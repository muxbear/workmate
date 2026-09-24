"""文本分词——为 BM25 稀疏检索提供 CJK 友好的切词。

设计取舍：不引入第三方分词库（jieba 等），拉丁/数字按词切分、CJK 按相邻二元组
切分，并采用**文档侧与查询侧非对称**的策略：

- **文档侧**（:func:`tokenize`）产出「单字 + 二元组」，保证单字查询也能命中；
- **查询侧**（:func:`tokenize_query`）对长度 ≥2 的 CJK 片段**只产出二元组**。

非对称的原因：查询侧若也产出单字，会带来明显误召回。例如查询「量子纠缠」含单字
「量」，会命中所有含「向量」的切片；文档侧保留单字则让单词查询（如「库」）仍能
检索。二元组本身已覆盖未登录词（「麦克斯韦」→ 麦克/克斯/斯韦），因此精度与召回
可以兼得。

例子::

    >>> tokenize("向量数据库")          # 文档侧
    ['向', '量', '数', '据', '库', '向量', '量数', '数据', '据库']
    >>> tokenize_query("向量数据库")    # 查询侧
    ['向量', '量数', '数据', '据库']
    >>> tokenize("RAG 系统 2024年")
    ['rag', '系', '统', '系统', '2024', '年']

**停用词与同义词**：文档侧与查询侧都会过滤高频虚词（:data:`STOPWORDS`），因为
它们 IDF 接近 0 却会占掉短文本的可观权重；同义词表（:data:`SYNONYMS`）只在
「基础词表零命中」时作为兜底扩展启用，避免常开扩展稀释原词权重。
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterator

# 拉丁字母 / 数字 / 下划线组成的"词"
_LATIN_WORD = re.compile(r"[a-z0-9_]+")

#: 停用词——高频虚词。它们几乎出现在每篇文档里，IDF 接近 0，但对短文本
#: （标题、命令片段）会占据可观的分值权重，把真正有信息量的词挤下去。
#: 只过滤**单字/整词**；含停用词的二元组（如「目的的」）保留，因为二元组
#: 本身已带上下文信息。
STOPWORDS: frozenset[str] = frozenset({
    # 中文虚词（单字）
    "的", "了", "是", "在", "和", "与", "或", "及", "也", "就", "都", "而",
    "对", "把", "被", "让", "使", "为", "以", "于", "则", "并", "且", "之",
    "其", "此", "该", "个", "些", "么", "呢", "吧", "啊", "呀", "哦", "嗯",
    "我", "你", "他", "她", "它", "们", "这", "那", "哪", "什", "怎", "会",
    "要", "可", "能", "不", "没", "很", "太", "更", "最", "再", "还", "从",
    "到", "着", "过", "上", "下", "里", "中", "外", "后", "前", "时", "候",
    # 英文虚词
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "of", "to", "in", "on", "at", "by", "for", "with", "about", "into",
    "and", "or", "but", "if", "then", "than", "as", "so", "not", "no",
    "it", "its", "this", "that", "these", "those", "i", "you", "he", "she",
    "we", "they", "what", "which", "who", "how", "when", "where", "why",
    "do", "does", "did", "can", "could", "will", "would", "should", "may",
    "have", "has", "had",
})

#: 别名 / 同义词——**查询侧扩展**：查询里出现某个键时，额外把它的同义表达
#: 也加入检索词，从而命中用另一种说法写成的文档（「k8s 集群」也能命中
#: 「Kubernetes 集群」）。文档侧不扩展，避免索引里塞入原文没有的词。
#: 只在**完全没有检索结果**时才可能影响召回方向，因此误召回风险很低。
SYNONYMS: dict[str, tuple[str, ...]] = {
    "k8s": ("kubernetes",),
    "kubernetes": ("k8s",),
    "rag": ("检索增强", "知识库检索"),
    "检索增强": ("rag",),
    "llm": ("大模型", "大语言模型"),
    "大模型": ("llm",),
    "大语言模型": ("llm",),
    "向量": ("embedding", "vector"),
    "embedding": ("向量",),
    "向量数据库": ("vector", "milvus"),
    "微服务": ("microservice",),
    "容器": ("docker", "container"),
    "docker": ("容器",),
    "数据库": ("db", "database"),
    "缓存": ("cache", "redis"),
    "持续集成": ("ci", "jenkins"),
    "网关": ("gateway", "ingress"),
    "负载均衡": ("loadbalance", "lb"),
    "智能体": ("agent",),
    "agent": ("智能体",),
    "提示词": ("prompt",),
    "prompt": ("提示词",),
    "检索": ("search", "retrieval"),
    "分词": ("tokenize", "tokenizer"),
    "切片": ("chunk", "分块"),
    "分块": ("chunk", "切片"),
    "重排": ("rerank", "重排序"),
    "重排序": ("rerank",),
}


def _is_cjk(ch: str) -> bool:
    """判断字符是否属于 CJK / 假名 / 谚文（需要按字切分的文字）。"""
    code = ord(ch)
    return (
        0x3400 <= code <= 0x4DBF      # CJK 扩展 A
        or 0x4E00 <= code <= 0x9FFF   # CJK 统一表意文字
        or 0xF900 <= code <= 0xFAFF   # CJK 兼容表意文字
        or 0x3040 <= code <= 0x30FF   # 平假名 / 片假名
        or 0xAC00 <= code <= 0xD7AF   # 谚文音节
    )


def _split_runs(text: str) -> Iterator[tuple[str, bool]]:
    """把文本切成连续的「同类片段」——(片段, 是否为 CJK)。"""
    run: list[str] = []
    run_is_cjk = False
    for ch in text:
        is_cjk = _is_cjk(ch)
        if run and is_cjk != run_is_cjk:
            yield "".join(run), run_is_cjk
            run = []
        run_is_cjk = is_cjk
        run.append(ch)
    if run:
        yield "".join(run), run_is_cjk


def _iter_tokens(text: str, *, with_unigrams: bool = True) -> Iterator[str]:
    """惰性产出 token——避免为打分场景构造中间列表。

    Args:
        text: 待切分文本。
        with_unigrams: CJK 片段是否额外产出单字。文档侧需要（单字查询可命中），
            查询侧不需要（单字会造成跨词误召回）。
    """
    for run, is_cjk in _split_runs(text):
        if is_cjk:
            length = len(run)
            if length == 1:
                yield run
            else:
                if with_unigrams:
                    yield from run  # 单字
                for i in range(length - 1):
                    yield run[i:i + 2]  # 相邻二元组
        else:
            for word in _LATIN_WORD.findall(run.lower()):
                yield _stem_latin(word)


def _stem_latin(word: str) -> str:
    """保守的英文词干化——只处理最常见的复数形态。

    不做完整 Porter 词干（``class`` → ``clas`` 这类误伤代价大于收益），只把
    ``models`` / ``chunks`` 与 ``model`` / ``chunk`` 归一到同一个 token。
    """
    if len(word) > 3 and word.endswith("s") and not word.endswith(("ss", "us", "is")):
        return word[:-1]
    return word


def _is_stopword(token: str) -> bool:
    """是否为停用词。

    除整词命中停用词表外，**由两个停用字组成的二元组**也视为停用词：
    像「的是」「了在」这种组合在任何中文长文里都随处可见，留着只会制造噪声
    （整句虚词的查询也就不再产生任何检索词）。
    """
    if token in STOPWORDS:
        return True
    return len(token) == 2 and all(ch in STOPWORDS for ch in token)


def tokenize(text: str) -> list[str]:
    """把文本切分为 token 列表（文档侧：单字 + 二元组，过滤停用词）。

    Args:
        text: 待切分文本。

    Returns:
        token 列表，保留顺序与重复（如需词频请用 :func:`term_frequencies`）。
    """
    if not text:
        return []
    return [t for t in _iter_tokens(text) if not _is_stopword(t)]


def term_frequencies(text: str) -> Counter[str]:
    """统计文档文本的词频（文档侧切分口径）。"""
    if not text:
        return Counter()
    return Counter(t for t in _iter_tokens(text) if not _is_stopword(t))


def _expand_synonyms(tokens: list[str]) -> list[str]:
    """按别名表扩展查询词——把同义表达一并加入检索词。

    只加不减：原词始终保留，因此不会因为别名表不全而丢掉原本能命中的结果。
    """
    extra: list[str] = []
    for token in tokens:
        for synonym in SYNONYMS.get(token, ()):
            for piece in _iter_tokens(synonym, with_unigrams=False):
                if not _is_stopword(piece):
                    extra.append(piece)
    return tokens + extra


def tokenize_query(query: str, *, expand_synonyms: bool = False) -> list[str]:
    """切分查询串并去重（查询侧：CJK 只取二元组 + 过滤停用词）。

    去重避免同一 token 在打分时被重复累加；长度 ≥2 的 CJK 片段不产出单字，
    以免「量子纠缠」通过单字「量」误命中「向量」这类跨词假阳性。

    Args:
        query: 用户查询串。
        expand_synonyms: 是否额外加入别名表里的同义表达。**默认关闭**——
            常开扩展会稀释原词的权重（实测 MRR -0.015）；由调用方在"基础词表
            零命中"时再开一次重试，既补召回又不影响正常排序。

    Returns:
        去重后的 token 列表（保留首次出现顺序）。
    """
    seen: dict[str, None] = {}
    base = [
        token for token in _iter_tokens(query or "", with_unigrams=False)
        if not _is_stopword(token)
    ]
    tokens = _expand_synonyms(base) if expand_synonyms else base
    for token in tokens:
        seen.setdefault(token, None)
    return list(seen)
