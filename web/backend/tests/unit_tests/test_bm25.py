"""Tests for core.rag.bm25 — 稀疏检索打分（IDF / 长度归一 / 算法切换）。"""

import math

import pytest

from core.rag.bm25 import (
    BM25Index,
    BM25PlusScorer,
    BM25Scorer,
    SparseConfig,
    TfIdfScorer,
    create_sparse_scorer,
)

CORPUS: list[tuple[str, str]] = [
    ("d1", "向量数据库用于相似度检索，Milvus 是常用的向量数据库实现。"),
    ("d2", "知识图谱用于抽取实体和关系，实体之间通过关系连接。"),
    ("d3", "文本切片决定了检索粒度，切片过大或过小都会影响召回效果。"),
    ("d4", "深度学习模型依赖大规模语料进行预训练。"),
]


@pytest.fixture
def index() -> BM25Index:
    return BM25Index.build(CORPUS)


class TestSparseConfig:
    def test_defaults(self):
        cfg = SparseConfig.from_config(None)
        assert cfg.sparse_algo == "bm25"
        assert cfg.bm25_k1 == 1.5
        assert cfg.bm25_b == 0.75

    def test_reads_snake_case_keys(self):
        """配置里的 k1/b 现在真的会被读取（此前从未被使用）。"""
        cfg = SparseConfig.from_config({
            "sparse_algo": "bm25_plus", "bm25_k1": 2.0, "bm25_b": 0.3,
        })
        assert cfg.sparse_algo == "bm25_plus"
        assert cfg.bm25_k1 == 2.0
        assert cfg.bm25_b == 0.3

    def test_reads_camel_case_keys(self):
        """兼容前端历史 camelCase 配置。"""
        cfg = SparseConfig.from_config({"sparseAlgo": "tf_idf", "bm25K1": 1.2})
        assert cfg.sparse_algo == "tf_idf"
        assert cfg.bm25_k1 == 1.2

    def test_unknown_algo_falls_back_to_bm25(self):
        assert SparseConfig.from_config({"sparse_algo": "nope"}).sparse_algo == "bm25"

    def test_bad_numbers_fall_back(self):
        cfg = SparseConfig.from_config({"bm25_k1": "abc", "bm25_b": None})
        assert cfg.bm25_k1 == 1.5
        assert cfg.bm25_b == 0.75


class TestBM25Index:
    def test_basic_stats(self, index: BM25Index):
        assert index.size == 4
        assert index.avgdl > 0

    def test_document_frequency(self, index: BM25Index):
        """「数据」只出现在 d1；「检索」出现在 d1 与 d3。"""
        df = index.document_frequency
        assert df["数据"] == 1
        assert df["据库"] == 1
        assert df["检索"] == 2

    def test_idf_is_zero_for_absent_term(self, index: BM25Index):
        """语料中不存在的词不产生得分（旧实现仅靠词频，无关词也可能得分）。"""
        assert index.idf("不存在的词汇xyz") == 0.0

    def test_idf_decreases_with_frequency(self, index: BM25Index):
        """词越常见 IDF 越低：检索(df=2) 低于 数据(df=1)。"""
        assert index.idf("检索") < index.idf("数据")

    def test_single_char_terms_are_indexed(self, index: BM25Index):
        """文档侧保留单字，使单词查询也能命中。"""
        assert index.term_frequency("d1", "库") > 0

    def test_idf_is_non_negative(self, index: BM25Index):
        """Lucene 形式 IDF 恒非负，避免高频词出现负分。"""
        for term in index.document_frequency:
            assert index.idf(term) >= 0.0

    def test_doc_length_counts_tokens(self, index: BM25Index):
        assert index.doc_length("d1") > 0
        assert index.doc_length("missing") == 0


class TestBM25Scoring:
    def test_relevant_doc_ranks_first(self, index: BM25Index):
        """中文查询能命中对应文档（旧实现：整句作为一个 token，tf 恒为 0）。"""
        results = index.search("向量数据库检索", top_k=3)
        assert results, "中文查询不应返回空结果"
        assert results[0][0] == "d1"

    def test_phrase_need_not_appear_verbatim(self, index: BM25Index):
        """查询词分散出现即可命中，无需整句原样出现。"""
        results = dict(index.search("数据库 检索", top_k=4))
        assert "d1" in results
        assert results["d1"] > 0

    def test_unrelated_query_returns_nothing(self, index: BM25Index):
        """完全无关的查询不应有命中。"""
        assert index.search("量子纠缠光谱仪", top_k=5) == []

    def test_scores_are_sorted_descending(self, index: BM25Index):
        scores = [s for _, s in index.search("切片 检索", top_k=4)]
        assert scores == sorted(scores, reverse=True)

    def test_top_k_limits_results(self, index: BM25Index):
        assert len(index.search("数据库", top_k=1)) <= 1

    def test_absent_term_alone_yields_no_hits(self, index: BM25Index):
        assert index.search("外星星系", top_k=5) == []

    def test_length_normalization_penalizes_longer_docs(self):
        """b>0 时，同样命中一次的长文档得分应低于短文档。"""
        short = ("short", "数据库")
        long = ("long", "数据库" + "无关填充内容" * 20)
        idx = BM25Index.build([short, long])
        cfg = SparseConfig(bm25_b=1.0)
        scores = dict(idx.search("数据库", top_k=2, config=cfg))
        assert scores["short"] > scores["long"]

    def test_b_zero_disables_length_normalization(self):
        """b=0 时长度归一失效，两篇文档命中次数相同则得分相同。"""
        idx = BM25Index.build([
            ("short", "数据库"),
            ("long", "数据库" + "无关填充内容" * 20),
        ])
        cfg = SparseConfig(bm25_b=0.0)
        scores = dict(idx.search("数据库", top_k=2, config=cfg))
        assert scores["short"] == pytest.approx(scores["long"])

    def test_higher_k1_increases_gain_from_repeats(self):
        """k1 越大，词频饱和越慢，重复命中的收益越高。"""
        docs = [("twice", "数据库数据库"), ("once", "数据库内容")]
        idx = BM25Index.build(docs)
        low = dict(idx.search("数据库", top_k=2, config=SparseConfig(bm25_k1=0.5)))
        high = dict(idx.search("数据库", top_k=2, config=SparseConfig(bm25_k1=3.0)))
        assert (high["twice"] / high["once"]) > (low["twice"] / low["once"])

    def test_results_are_deterministic(self, index: BM25Index):
        """同分时按 doc_id 稳定排序，保证结果可复现。"""
        first = index.search("数据", top_k=4)
        second = index.search("数据", top_k=4)
        assert first == second


class TestSparseAlgoSwitch:
    def test_none_algo_disables_sparse_search(self, index: BM25Index):
        """sparse_algo=none 现在真的关闭稀疏检索（此前是装饰性配置）。"""
        assert index.search("数据库", top_k=5, config=SparseConfig(sparse_algo="none")) == []

    def test_registry_lookup(self):
        assert isinstance(create_sparse_scorer("bm25"), BM25Scorer)
        assert isinstance(create_sparse_scorer("bm25_plus"), BM25PlusScorer)
        assert isinstance(create_sparse_scorer("tf_idf"), TfIdfScorer)
        assert create_sparse_scorer("none") is None

    def test_unknown_algo_returns_none(self):
        assert create_sparse_scorer("unknown") is None

    def test_bm25_plus_differs_from_bm25(self, index: BM25Index):
        """BM25+ 的 delta 下界使得分不弱于经典 BM25。"""
        cfg_plain = SparseConfig(sparse_algo="bm25")
        cfg_plus = SparseConfig(sparse_algo="bm25_plus")
        plain = dict(index.search("数据库", top_k=4, config=cfg_plain))
        plus = dict(index.search("数据库", top_k=4, config=cfg_plus))
        assert set(plain) == set(plus)
        for doc_id, score in plus.items():
            assert score >= plain[doc_id]

    def test_tf_idf_ranks_relevant_doc_first(self, index: BM25Index):
        results = index.search("向量数据库", top_k=3, config=SparseConfig(sparse_algo="tf_idf"))
        assert results and results[0][0] == "d1"

    def test_tf_idf_normalizes_by_length(self):
        """TF-IDF 除以 sqrt(文档长度)：短文档命中同样的词得分更高。"""
        idx = BM25Index.build([("short", "数据库"), ("long", "数据库" + "填充" * 50)])
        cfg = SparseConfig(sparse_algo="tf_idf")
        scores = dict(idx.search("数据库", top_k=2, config=cfg))
        assert scores["short"] > scores["long"]

    def test_tf_idf_uses_log_tf(self):
        """TF-IDF 用对数词频：重复 4 次不应得到 4 倍得分。"""
        idx = BM25Index.build([("d", "数据库" * 4)])
        cfg = SparseConfig(sparse_algo="tf_idf")
        single = dict(BM25Index.build([("d", "数据库")]).search("数据库", 1, cfg))["d"]
        quad = dict(idx.search("数据库", 1, cfg))["d"]
        assert quad < single * 4


class TestEdgeCases:
    def test_empty_corpus(self):
        idx = BM25Index.build([])
        assert idx.size == 0
        assert idx.avgdl == 0.0
        assert idx.search("任何查询", top_k=5) == []

    def test_empty_query(self, index: BM25Index):
        assert index.search("", top_k=5) == []

    def test_query_with_only_stopwords_does_not_crash(self, index: BM25Index):
        assert isinstance(index.search("的 了 是", top_k=5), list)

    def test_document_with_empty_text(self):
        idx = BM25Index.build([("empty", ""), ("full", "数据库")])
        assert idx.doc_length("empty") == 0
        results = dict(idx.search("数据库", top_k=2))
        assert results["full"] > 0
        assert "empty" not in results

    def test_score_matches_manual_formula(self, index: BM25Index):
        """对照手算校验公式（防止公式漂移）。"""
        cfg = SparseConfig(bm25_k1=1.5, bm25_b=0.75)
        scorer = BM25Scorer()
        f = index.term_frequency("d1", "数据库")
        idf = index.idf("数据库")
        norm = 1 - cfg.bm25_b + cfg.bm25_b * (index.doc_length("d1") / index.avgdl)
        expected = idf * (f * (cfg.bm25_k1 + 1)) / (f + cfg.bm25_k1 * norm)
        assert scorer.score(index, "d1", ["数据库"], cfg) == pytest.approx(expected)

    def test_idf_formula(self, index: BM25Index):
        """对照手算校验 IDF。"""
        n = index.size
        df = index.document_frequency["milvus"]
        expected = math.log(1 + (n - df + 0.5) / (df + 0.5))
        assert index.idf("milvus") == pytest.approx(expected)
