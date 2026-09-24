"""稀疏检索打分——客户端 BM25 / BM25+ / TF-IDF 实现。

之前 ``bm25_search`` 只做大小写不敏感的**词频计数**：既没有 IDF，也没有长度
归一，`bm25_k1` / `bm25_b` / `sparse_algo` 三个配置项从未被读取。本模块把它们
变成真正生效的算法：

===============  ==========================================================
sparse_algo      打分公式
===============  ==========================================================
``bm25``         ``idf * f*(k1+1) / (f + k1*(1-b+b*|d|/avgdl))``
``bm25_plus``    ``idf * (f*(k1+1)+delta) / (f + k1*(1-b+b*|d|/avgdl))``
``tf_idf``       ``idf * (1+ln f) / sqrt(|d|)``
``none``         不启用稀疏检索（返回空结果）
===============  ==========================================================

其中 ``idf = ln(1 + (N - df + 0.5) / (df + 0.5))``（Lucene 形式，恒非负）。

索引与打分分离：:class:`BM25Index` 只承载语料统计（df / 文档词频 / 平均长度），
可以按知识库缓存复用；k1 / b 等参数在查询时应用，因此改参数无需重建索引。
"""

from __future__ import annotations

import logging
import math
import time
from abc import ABC, abstractmethod
from collections import Counter
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from core.rag.text_analyzer import term_frequencies, tokenize_query

logger = logging.getLogger(__name__)

DEFAULT_K1 = 1.5
DEFAULT_B = 0.75
BM25_PLUS_DELTA = 1.0

SPARSE_ALGO_BM25 = "bm25"
SPARSE_ALGO_BM25_PLUS = "bm25_plus"
SPARSE_ALGO_TF_IDF = "tf_idf"
SPARSE_ALGO_NONE = "none"


@dataclass(frozen=True)
class SparseConfig:
    """稀疏检索参数（来自知识库 IndexConfig）。"""

    sparse_algo: str = SPARSE_ALGO_BM25
    bm25_k1: float = DEFAULT_K1
    bm25_b: float = DEFAULT_B

    @classmethod
    def from_config(cls, config: Mapping[str, Any] | None) -> SparseConfig:
        """从知识库配置字典构造；缺字段时回退默认值。

        同时兼容前端历史 camelCase 键名。
        """
        if not config:
            return cls()

        def pick(*keys: str, default: Any) -> Any:
            for key in keys:
                value = config.get(key)
                if value is not None:
                    return value
            return default

        algo = str(pick("sparse_algo", "sparseAlgo", default=SPARSE_ALGO_BM25)).lower()
        if algo not in _SCORER_REGISTRY:
            logger.warning("未知的 sparse_algo=%s，回退 bm25", algo)
            algo = SPARSE_ALGO_BM25

        try:
            k1 = float(pick("bm25_k1", "bm25K1", default=DEFAULT_K1))
            b = float(pick("bm25_b", "bm25B", default=DEFAULT_B))
        except (TypeError, ValueError):
            k1, b = DEFAULT_K1, DEFAULT_B

        return cls(sparse_algo=algo, bm25_k1=k1, bm25_b=b)


class BM25Index:
    """语料统计：文档词频、文档频率、平均文档长度。

    只依赖分词结果，与 k1 / b 无关，因此可跨查询复用。
    """

    def __init__(self, doc_freqs: dict[str, Counter[str]]) -> None:
        self._doc_freqs = doc_freqs
        self._df: Counter[str] = Counter()
        for freqs in doc_freqs.values():
            self._df.update(freqs.keys())
        self._n = len(doc_freqs)
        total_terms = sum(sum(freqs.values()) for freqs in doc_freqs.values())
        self._avgdl = (total_terms / self._n) if self._n else 0.0

    @classmethod
    def build(cls, documents: Iterable[tuple[str, str]]) -> BM25Index:
        """从 ``(doc_id, text)`` 迭代器构建索引。"""
        return cls({doc_id: term_frequencies(text or "") for doc_id, text in documents})

    @property
    def size(self) -> int:
        """语料中的文档数。"""
        return self._n

    @property
    def avgdl(self) -> float:
        """平均文档长度（token 数）。"""
        return self._avgdl

    @property
    def document_frequency(self) -> Counter[str]:
        """文档频率表（只读用途）。"""
        return self._df

    def idf(self, term: str) -> float:
        """Lucene 形式的 IDF，语料中不存在的词返回 0（不产生得分）。"""
        df = self._df.get(term, 0)
        if df == 0 or self._n == 0:
            return 0.0
        return math.log(1.0 + (self._n - df + 0.5) / (df + 0.5))

    def term_frequency(self, doc_id: str, term: str) -> int:
        """某文档中某词的词频。"""
        return self._doc_freqs.get(doc_id, Counter()).get(term, 0)

    def doc_length(self, doc_id: str) -> int:
        """某文档长度（token 数）。"""
        return sum(self._doc_freqs.get(doc_id, Counter()).values())

    def doc_ids(self) -> list[str]:
        """全部文档 ID。"""
        return list(self._doc_freqs)

    def score(
        self, doc_id: str, query_terms: list[str], config: SparseConfig,
    ) -> float:
        """按配置的算法给单个文档打分。"""
        scorer = create_sparse_scorer(config.sparse_algo)
        if scorer is None or not query_terms:
            return 0.0
        return scorer.score(self, doc_id, query_terms, config)

    def search(
        self, query: str, top_k: int, config: SparseConfig | None = None,
        *, expand_synonyms: bool = False,
    ) -> list[tuple[str, float]]:
        """检索并按得分降序返回 ``(doc_id, score)``。

        只返回得分大于 0 的文档；同分时按 doc_id 稳定排序，保证结果可复现。

        Args:
            expand_synonyms: 是否在同义词表命中时扩展查询词。默认关闭；
                调用方在零命中时再用它重试一次（见 ``bm25_search_with_fallback``）。
        """
        cfg = config or SparseConfig()
        scorer = create_sparse_scorer(cfg.sparse_algo)
        if scorer is None:
            return []

        query_terms = tokenize_query(query, expand_synonyms=expand_synonyms)
        if not query_terms:
            return []

        scored: list[tuple[str, float]] = []
        for doc_id in self._doc_freqs:
            score = scorer.score(self, doc_id, query_terms, cfg)
            if score > 0.0:
                scored.append((doc_id, score))

        scored.sort(key=lambda item: (-item[1], item[0]))
        return scored[:top_k]


def bm25_search_with_fallback(
    index: BM25Index,
    query: str,
    top_k: int,
    config: SparseConfig | None = None,
) -> list[tuple[str, float]]:
    """BM25 检索 + 同义词兜底。

    先用「原文词（过滤停用词）」检索；**零命中时**再用同义词扩展重试一次。
    这样既能在「k8s 集群」这类表述上补召回，又不会让扩展词稀释正常查询的
    排序权重（实测：常开扩展会让 MRR 掉 0.015）。

    Args:
        index: 已构建的语料索引。
        query: 查询串。
        top_k: 返回条数。
        config: 稀疏算法与 k1/b 参数。

    Returns:
        按得分降序的 ``(chunk_id, score)``。
    """
    hits = index.search(query, top_k, config)
    if hits:
        return hits
    expanded = index.search(query, top_k, config, expand_synonyms=True)
    if expanded:
        logger.info("BM25 基础词表零命中，同义词扩展后命中 %d 条", len(expanded))
    return expanded


class SparseScorer(ABC):
    """稀疏打分算法抽象接口。"""

    name: str

    @abstractmethod
    def score(
        self, index: BM25Index, doc_id: str, query_terms: list[str],
        config: SparseConfig,
    ) -> float:
        """计算文档对查询的得分。"""
        ...

    def _length_norm(self, index: BM25Index, doc_id: str, b: float) -> float:
        """BM25 长度归一因子。"""
        if index.avgdl <= 0:
            return 1.0
        ratio = index.doc_length(doc_id) / index.avgdl
        return 1.0 - b + b * ratio


class BM25Scorer(SparseScorer):
    """经典 BM25。"""

    name = SPARSE_ALGO_BM25

    def score(
        self, index: BM25Index, doc_id: str, query_terms: list[str],
        config: SparseConfig,
    ) -> float:
        k1, b = config.bm25_k1, config.bm25_b
        norm = self._length_norm(index, doc_id, b)
        total = 0.0
        for term in query_terms:
            f = index.term_frequency(doc_id, term)
            if f <= 0:
                continue
            idf = index.idf(term)
            if idf <= 0:
                continue
            total += idf * (f * (k1 + 1.0)) / (f + k1 * norm)
        return total


class BM25PlusScorer(BM25Scorer):
    """BM25+ —— 为词频饱和项加下界 delta，缓解长文档中低频词得分被过度压制。"""

    name = SPARSE_ALGO_BM25_PLUS

    def score(
        self, index: BM25Index, doc_id: str, query_terms: list[str],
        config: SparseConfig,
    ) -> float:
        k1, b = config.bm25_k1, config.bm25_b
        norm = self._length_norm(index, doc_id, b)
        total = 0.0
        for term in query_terms:
            f = index.term_frequency(doc_id, term)
            if f <= 0:
                continue
            idf = index.idf(term)
            if idf <= 0:
                continue
            total += idf * (f * (k1 + 1.0) + BM25_PLUS_DELTA) / (f + k1 * norm)
        return total


class TfIdfScorer(SparseScorer):
    """TF-IDF —— 对数词频 + 余弦长度归一。"""

    name = SPARSE_ALGO_TF_IDF

    def score(
        self, index: BM25Index, doc_id: str, query_terms: list[str],
        config: SparseConfig,
    ) -> float:
        length = index.doc_length(doc_id)
        if length <= 0:
            return 0.0
        total = 0.0
        for term in query_terms:
            f = index.term_frequency(doc_id, term)
            if f <= 0:
                continue
            idf = index.idf(term)
            if idf <= 0:
                continue
            total += idf * (1.0 + math.log(f))
        return total / math.sqrt(length)


_SCORER_REGISTRY: dict[str, SparseScorer] = {
    SPARSE_ALGO_BM25: BM25Scorer(),
    SPARSE_ALGO_BM25_PLUS: BM25PlusScorer(),
    SPARSE_ALGO_TF_IDF: TfIdfScorer(),
}


def create_sparse_scorer(sparse_algo: str | None) -> SparseScorer | None:
    """按 ``sparse_algo`` 取得打分器；``none`` 或未知算法返回 ``None``（不启用）。"""
    if not sparse_algo:
        return _SCORER_REGISTRY[SPARSE_ALGO_BM25]
    if sparse_algo == SPARSE_ALGO_NONE:
        return None
    return _SCORER_REGISTRY.get(sparse_algo.lower())


class SparseIndexCache:
    """按知识库缓存 :class:`BM25Index`，避免每次查询都全量拉取并重新分词。

    语料统计（df / avgdl）不随 k1、b 变化，因此索引可以跨查询复用；打分参数在
    查询时应用。写入路径（add / delete / update / 重建 collection）会调用
    :meth:`invalidate` 立即失效，保证同进程内读到最新语料；``ttl_seconds`` 仅作为
    跨进程写入（多 worker 部署）的兜底过期时间。
    """

    def __init__(
        self,
        ttl_seconds: float = 60.0,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._ttl_seconds = ttl_seconds
        self._clock = clock or time.monotonic
        self._entries: dict[str, tuple[float, BM25Index]] = {}

    def get(self, kb_id: str) -> BM25Index | None:
        """取出未过期的索引；不存在或已过期返回 ``None``。"""
        entry = self._entries.get(kb_id)
        if entry is None:
            return None
        stored_at, index = entry
        if self._clock() - stored_at > self._ttl_seconds:
            self._entries.pop(kb_id, None)
            return None
        return index

    def put(self, kb_id: str, index: BM25Index) -> None:
        """写入索引并记录时间戳。"""
        self._entries[kb_id] = (self._clock(), index)

    def invalidate(self, kb_id: str) -> None:
        """使某知识库的缓存失效（写入路径必须调用）。"""
        self._entries.pop(kb_id, None)

    def clear(self) -> None:
        """清空全部缓存。"""
        self._entries.clear()

    def __len__(self) -> int:
        return len(self._entries)

