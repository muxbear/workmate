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
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterator

# 拉丁字母 / 数字 / 下划线组成的"词"
_LATIN_WORD = re.compile(r"[a-z0-9_]+")


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
            yield from _LATIN_WORD.findall(run.lower())


def tokenize(text: str) -> list[str]:
    """把文本切分为 token 列表（文档侧：单字 + 二元组）。

    Args:
        text: 待切分文本。

    Returns:
        token 列表，保留顺序与重复（如需词频请用 :func:`term_frequencies`）。
    """
    if not text:
        return []
    return list(_iter_tokens(text))


def term_frequencies(text: str) -> Counter[str]:
    """统计文档文本的词频（文档侧切分口径）。"""
    if not text:
        return Counter()
    return Counter(_iter_tokens(text))


def tokenize_query(query: str) -> list[str]:
    """切分查询串并去重（查询侧：CJK 只取二元组）。

    去重避免同一 token 在打分时被重复累加；长度 ≥2 的 CJK 片段不产出单字，
    以免「量子纠缠」通过单字「量」误命中「向量」这类跨词假阳性。

    Args:
        query: 用户查询串。

    Returns:
        去重后的 token 列表（保留首次出现顺序）。
    """
    seen: dict[str, None] = {}
    for token in _iter_tokens(query or "", with_unigrams=False):
        seen.setdefault(token, None)
    return list(seen)
