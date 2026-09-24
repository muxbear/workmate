"""Tests for 检索编排器与 RRF 融合。

覆盖此前失效的配置项与新增的精排环节：
- ``hybrid_alpha`` / 请求 ``alpha`` 真正影响排序（此前 RRF 权重固定）；
- 展示分数与排序一致（此前展示分用加权和、排序用 RRF，二者可能矛盾）；
- ``sparse_algo`` / ``bm25_k1`` / ``bm25_b`` 透传到向量库；
- 纯 BM25 检索不再强制向量化；
- Reranker 生效、且失败时回退原顺序不影响检索。
"""

import pytest

from api.knowledge_base.schemas import SearchRequest
from api.knowledge_base.search_service import (
    HybridSearchStrategy,
    SearchContext,
    SearchOrchestrator,
    _fuse_scores,
    create_search_registry,
)
from core.rag.bm25 import SparseConfig

pytestmark = pytest.mark.anyio


# ─── RRF 融合 ────────────────────────────────────────────────────────────────


class TestFuseScores:
    def test_empty_inputs(self):
        assert _fuse_scores([], [], top_k=5, alpha=0.7) == []

    def test_vector_only_input(self):
        result = _fuse_scores([("a", 0.9), ("b", 0.5)], [], top_k=5, alpha=0.7)
        assert [c.chunk_id for c in result] == ["a", "b"]
        assert result[0].bm25_score is None

    def test_bm25_only_input(self):
        result = _fuse_scores([], [("x", 3.0), ("y", 1.0)], top_k=5, alpha=0.7)
        assert [c.chunk_id for c in result] == ["x", "y"]
        assert result[0].vec_score is None

    def test_alpha_one_follows_vector_ranking(self):
        """alpha=1 → 纯向量排序（此前 alpha 完全不影响顺序）。"""
        vec = [("v1", 0.9), ("v2", 0.8), ("v3", 0.7)]
        bm25 = [("b1", 9.0), ("b2", 8.0), ("b3", 7.0)]
        result = _fuse_scores(vec, bm25, top_k=3, alpha=1.0)
        assert [c.chunk_id for c in result] == ["v1", "v2", "v3"]

    def test_alpha_zero_follows_bm25_ranking(self):
        """alpha=0 → 纯 BM25 排序。"""
        vec = [("v1", 0.9), ("v2", 0.8), ("v3", 0.7)]
        bm25 = [("b1", 9.0), ("b2", 8.0), ("b3", 7.0)]
        result = _fuse_scores(vec, bm25, top_k=3, alpha=0.0)
        assert [c.chunk_id for c in result] == ["b1", "b2", "b3"]

    def test_alpha_changes_order_for_conflicting_channels(self):
        """两路结果冲突时，alpha 的取值必须改变排序。"""
        vec = [("v1", 0.9), ("shared", 0.8)]
        bm25 = [("b1", 9.0), ("shared", 8.0)]
        vector_heavy = _fuse_scores(vec, bm25, top_k=3, alpha=0.9)
        bm25_heavy = _fuse_scores(vec, bm25, top_k=3, alpha=0.1)
        assert [c.chunk_id for c in vector_heavy] != [c.chunk_id for c in bm25_heavy]

    def test_alpha_is_clamped(self):
        """越界 alpha 被夹到 [0, 1]，不产生负权重。"""
        result = _fuse_scores([("a", 1.0)], [("b", 1.0)], top_k=2, alpha=5.0)
        assert result[0].chunk_id == "a"

    def test_top_hit_scores_one_and_descends(self):
        """综合分为归一化 RRF：榜首为 1.0 且单调不增。"""
        result = _fuse_scores(
            [("a", 0.9), ("b", 0.5), ("c", 0.1)], [("a", 5.0)], top_k=3, alpha=0.5,
        )
        assert result[0].score == pytest.approx(1.0)
        scores = [c.score for c in result]
        assert scores == sorted(scores, reverse=True)

    def test_score_order_matches_listed_order(self):
        """展示分与排序必须一致（此前两者用不同公式，可能互相矛盾）。"""
        vec = [(f"v{i}", 1.0 - i * 0.1) for i in range(6)]
        bm25 = [(f"b{i}", 6.0 - i) for i in range(6)]
        result = _fuse_scores(vec, bm25, top_k=6, alpha=0.6)
        scores = [c.score for c in result]
        assert scores == sorted(scores, reverse=True)

    def test_doc_found_by_both_channels_ranks_first(self):
        """两路都排前的切片应优于仅单路出现的切片。"""
        vec = [("only_vec", 0.99), ("both", 0.5)]
        bm25 = [("only_bm25", 99.0), ("both", 1.0)]
        result = _fuse_scores(vec, bm25, top_k=3, alpha=0.5)
        assert result[0].chunk_id == "both"

    def test_per_channel_scores_are_raw(self):
        """分维度得分回传**原始分**（余弦 / BM25）。

        此前是候选集内 min-max 相对值，与单路模式的原始分同名不同义——
        前端把两者都当"得分"展示会误导用户（同样标 1.00 的可能是余弦 0.88，
        也可能只是"本批里最高"）。
        """
        result = _fuse_scores([("a", 10.0), ("b", 0.0)], [("a", 100.0)], top_k=2, alpha=0.5)
        by_id = {c.chunk_id: c for c in result}
        assert by_id["a"].vec_score == pytest.approx(10.0)
        assert by_id["b"].vec_score == pytest.approx(0.0)
        assert by_id["a"].bm25_score == pytest.approx(100.0)
        assert by_id["a"].score_kind == "rrf"


# ─── 策略注册表 ──────────────────────────────────────────────────────────────


class TestRegistry:
    def test_three_modes_registered(self):
        assert sorted(create_search_registry().supported_modes) == ["bm25", "hybrid", "vector"]

    def test_unknown_mode_returns_none(self):
        assert create_search_registry().get("graph") is None

    def test_bm25_strategy_does_not_require_embedding(self):
        registry = create_search_registry()
        assert registry.get("bm25").requires_embedding is False
        assert registry.get("vector").requires_embedding is True
        assert registry.get("hybrid").requires_embedding is True


class TestSearchContext:
    def test_sparse_config_default(self):
        ctx = SearchContext(kb_id="k", query_text="q", query_embedding=[], top_k=3)
        assert ctx.sparse_config.sparse_algo == "bm25"
        assert ctx.alpha == 0.7


# ─── 编排器 ──────────────────────────────────────────────────────────────────


class FakeEmbedding:
    def __init__(self, fail: bool = False):
        self.fail = fail
        self.calls: list[str] = []

    async def aembed_query(self, text: str) -> list[float]:
        self.calls.append(text)
        if self.fail:
            raise RuntimeError("embedding service down")
        return [0.1] * 8


class FakeStore:
    """只实现编排器用到的接口。"""

    def __init__(self, vec=None, bm25=None, chunks=None):
        self.vec = vec or []
        self.bm25 = bm25 or []
        self.chunks = chunks or {}
        self.sparse_configs: list[SparseConfig] = []
        self.vec_top_k: list[int] = []
        self.bm25_top_k: list[int] = []
        self.fail_chunk_fetch = False

    async def similarity_search(self, kb_id, query_embedding, top_k):
        self.vec_top_k.append(top_k)
        return self.vec[:top_k]

    async def bm25_search(self, kb_id, query, top_k, sparse_config=None):
        self.bm25_top_k.append(top_k)
        self.sparse_configs.append(sparse_config)
        return self.bm25[:top_k]

    async def get_chunks_by_ids(self, kb_id, chunk_ids):
        if self.fail_chunk_fetch:
            raise RuntimeError("boom")
        return [self.chunks[cid] for cid in chunk_ids if cid in self.chunks]


class FakeReranker:
    def __init__(self, order=None, fail: bool = False):
        self.order = order
        self.fail = fail
        self.received: list[str] = []
        self.top_n: int | None = None

    async def rerank(self, query, documents, top_n=None):
        self.received = documents
        self.top_n = top_n
        if self.fail:
            return None
        if self.order is not None:
            return self.order
        return [(i, 1.0 - i * 0.01) for i in range(len(documents))]


def make_chunk(cid: str, text: str = "") -> dict:
    return {
        "id": cid,
        "doc_id": "doc-1",
        "doc_name": "手册.pdf",
        "chunk_index": 0,
        "chunk_text": text or f"内容-{cid}",
    }


def make_orchestrator(kb_config=None, reranker=None, **store_kwargs):
    store = FakeStore(**store_kwargs)
    embedding = FakeEmbedding()
    orchestrator = SearchOrchestrator(vector_store=store, embedding_model=embedding)

    async def fake_load_config(db, kb_id):
        return dict(kb_config or {})

    async def fake_resolve_reranker(db, config):
        return reranker

    orchestrator._load_kb_config = fake_load_config  # type: ignore[method-assign]
    orchestrator._resolve_reranker = fake_resolve_reranker  # type: ignore[method-assign]
    return orchestrator, store, embedding


class TestOrchestratorModes:
    async def test_bm25_mode_skips_embedding(self):
        """纯 BM25 不再强制向量化——embedding 挂了也能检索。"""
        orchestrator, _store, embedding = make_orchestrator(
            bm25=[("c1", 2.0)],
            chunks={"c1": make_chunk("c1")},
        )
        embedding.fail = True

        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="数据库", mode="bm25", top_k=3),
        )

        assert embedding.calls == []
        assert response.total == 1

    async def test_vector_mode_reports_embedding_failure(self):
        orchestrator, _, embedding = make_orchestrator(vec=[("c1", 0.9)])
        embedding.fail = True

        with pytest.raises(RuntimeError, match="查询向量化失败"):
            await orchestrator.search(
                None, "kb-1", SearchRequest(query="数据库", mode="vector", top_k=3),
            )

    async def test_hybrid_failure_is_wrapped(self):
        orchestrator, store, _ = make_orchestrator(
            vec=[("c1", 0.9)], bm25=[("c1", 1.0)],
        )

        async def boom(*args, **kwargs):
            raise RuntimeError("milvus down")

        store.similarity_search = boom  # type: ignore[method-assign]
        with pytest.raises(RuntimeError, match="检索执行失败"):
            await orchestrator.search(
                None, "kb-1", SearchRequest(query="q", mode="hybrid", top_k=3),
            )

    async def test_unknown_mode_raises_value_error(self):
        orchestrator, _, _ = make_orchestrator()
        with pytest.raises(ValueError, match="不支持的检索模式"):
            await orchestrator.search(
                None, "kb-1", SearchRequest(query="q", mode="graph", top_k=3),
            )

    async def test_empty_results_short_circuits(self):
        orchestrator, _, _ = make_orchestrator(vec=[], bm25=[])
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="hybrid", top_k=3),
        )
        assert response.total == 0
        assert response.results == []

    async def test_chunk_fetch_failure_is_wrapped(self):
        orchestrator, store, _ = make_orchestrator(
            vec=[("c1", 0.9)], chunks={"c1": make_chunk("c1")},
        )
        store.fail_chunk_fetch = True
        with pytest.raises(RuntimeError, match="查询分片详情失败"):
            await orchestrator.search(
                None, "kb-1", SearchRequest(query="q", mode="vector", top_k=3),
            )

    async def test_result_fields_are_mapped(self):
        orchestrator, _, _ = make_orchestrator(
            bm25=[("c1", 2.0)], chunks={"c1": make_chunk("c1", "切片正文")},
        )
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="bm25", top_k=3),
        )
        match = response.results[0]
        assert match.id == "c1"
        assert match.doc_name == "手册.pdf"
        assert match.content == "切片正文"
        assert match.bm25_score is not None


class TestOrchestratorConfigWiring:
    async def test_sparse_config_passed_to_store(self):
        """sparse_algo / k1 / b 真正传到向量库（此前从未被读取）。"""
        orchestrator, store, _ = make_orchestrator(
            kb_config={"sparse_algo": "bm25_plus", "bm25_k1": 2.2, "bm25_b": 0.4},
            bm25=[("c1", 2.0)], chunks={"c1": make_chunk("c1")},
        )
        await orchestrator.search(None, "kb-1", SearchRequest(query="q", mode="bm25", top_k=3))

        cfg = store.sparse_configs[0]
        assert cfg is not None
        assert cfg.sparse_algo == "bm25_plus"
        assert cfg.bm25_k1 == 2.2
        assert cfg.bm25_b == 0.4

    async def test_alpha_defaults_from_kb_config(self):
        """未显式传 alpha 时使用知识库配置的 hybrid_alpha。"""
        orchestrator, _, _ = make_orchestrator(
            kb_config={"hybrid_alpha": 0.0},
            vec=[("v1", 0.9), ("v2", 0.8)],
            bm25=[("b1", 9.0), ("b2", 8.0)],
            chunks={c: make_chunk(c) for c in ("v1", "v2", "b1", "b2")},
        )
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="hybrid", top_k=1),
        )
        assert response.results[0].id == "b1", "alpha=0 应退化为纯 BM25 排序"

    async def test_request_alpha_overrides_kb_config(self):
        orchestrator, _, _ = make_orchestrator(
            kb_config={"hybrid_alpha": 0.0},
            vec=[("v1", 0.9), ("v2", 0.8)],
            bm25=[("b1", 9.0), ("b2", 8.0)],
            chunks={c: make_chunk(c) for c in ("v1", "v2", "b1", "b2")},
        )
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="hybrid", top_k=1, alpha=1.0),
        )
        assert response.results[0].id == "v1"

    async def test_invalid_alpha_in_config_falls_back(self):
        orchestrator, _, _ = make_orchestrator(
            kb_config={"hybrid_alpha": "not-a-number"},
            vec=[("v1", 0.9)], bm25=[("b1", 9.0)],
            chunks={"v1": make_chunk("v1"), "b1": make_chunk("b1")},
        )
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="hybrid", top_k=1),
        )
        assert response.total == 1


class TestOrchestratorRerank:
    async def test_disabled_by_default(self):
        """未启用精排时只取 top_k 个候选。"""
        orchestrator, store, _ = make_orchestrator(
            vec=[(f"c{i}", 1.0 - i * 0.01) for i in range(10)],
            chunks={f"c{i}": make_chunk(f"c{i}") for i in range(10)},
        )
        await orchestrator.search(None, "kb-1", SearchRequest(query="q", mode="vector", top_k=3))
        assert store.vec_top_k == [3]

    async def test_enabled_retrieves_more_candidates(self):
        """启用精排时扩大召回候选数。"""
        reranker = FakeReranker()
        orchestrator, store, _ = make_orchestrator(
            reranker=reranker,
            vec=[(f"c{i}", 1.0 - i * 0.01) for i in range(20)],
            chunks={f"c{i}": make_chunk(f"c{i}") for i in range(20)},
        )
        await orchestrator.search(None, "kb-1", SearchRequest(query="q", mode="vector", top_k=2))
        assert store.vec_top_k[0] > 2
        assert reranker.top_n == 2

    async def test_rerank_reorders_and_truncates(self):
        """精排结果决定最终顺序与条数。"""
        orchestrator, _, _ = make_orchestrator(
            reranker=FakeReranker(order=[(2, 0.99), (0, 0.5)]),
            vec=[("c0", 0.9), ("c1", 0.8), ("c2", 0.7), ("c3", 0.6)],
            chunks={f"c{i}": make_chunk(f"c{i}") for i in range(4)},
        )
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="vector", top_k=2),
        )
        assert [r.id for r in response.results] == ["c2", "c0"]
        assert response.results[0].score == pytest.approx(0.99)
        assert response.results[0].vec_score is not None, "应保留召回阶段的分维度得分"

    async def test_rerank_receives_candidate_texts(self):
        reranker = FakeReranker()
        orchestrator, _, _ = make_orchestrator(
            reranker=reranker,
            vec=[("c0", 0.9), ("c1", 0.8)],
            chunks={"c0": make_chunk("c0", "正文0"), "c1": make_chunk("c1", "正文1")},
        )
        await orchestrator.search(None, "kb-1", SearchRequest(query="q", mode="vector", top_k=2))
        assert reranker.received == ["正文0", "正文1"]

    async def test_rerank_failure_falls_back_to_recall_order(self):
        """精排失败不能让整次检索失败，应回退原顺序。"""
        orchestrator, _, _ = make_orchestrator(
            reranker=FakeReranker(fail=True),
            vec=[("c0", 0.9), ("c1", 0.8), ("c2", 0.7)],
            chunks={f"c{i}": make_chunk(f"c{i}") for i in range(3)},
        )
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="vector", top_k=2),
        )
        assert [r.id for r in response.results] == ["c0", "c1"]

    async def test_single_candidate_skips_rerank(self):
        reranker = FakeReranker()
        orchestrator, _, _ = make_orchestrator(
            reranker=reranker,
            vec=[("c0", 0.9)], chunks={"c0": make_chunk("c0")},
        )
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="vector", top_k=2),
        )
        assert reranker.received == []
        assert response.results[0].id == "c0"

    async def test_out_of_range_rerank_index_ignored(self):
        """越界的精排下标被忽略，不抛异常，且结果按召回顺序补足。"""
        orchestrator, _, _ = make_orchestrator(
            reranker=FakeReranker(order=[(99, 0.9), (0, 0.5)]),
            vec=[("c0", 0.9), ("c1", 0.8)],
            chunks={"c0": make_chunk("c0"), "c1": make_chunk("c1")},
        )
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="vector", top_k=2),
        )
        # 有效的精排项排在前面，被丢弃的候选从召回顺序补回，条数满足 top_k
        assert [r.id for r in response.results] == ["c0", "c1"]


class TestRerankAppliedFlag:
    """``rerank_requested`` / ``rerank_applied`` 必须如实反映精排是否生效。"""

    async def test_applied_true_when_reranker_succeeds(self):
        orchestrator, _, _ = make_orchestrator(
            kb_config={"enable_reranker": True},
            reranker=FakeReranker(),
            vec=[("c0", 0.9), ("c1", 0.8)],
            chunks={"c0": make_chunk("c0"), "c1": make_chunk("c1")},
        )
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="vector", top_k=2),
        )

        assert response.rerank_requested is True
        assert response.rerank_applied is True

    async def test_applied_false_when_reranker_fails(self):
        """精排调用失败时结果回退原序，但必须标记为"未生效"。"""
        orchestrator, _, _ = make_orchestrator(
            kb_config={"enable_reranker": True},
            reranker=FakeReranker(fail=True),
            vec=[("c0", 0.9), ("c1", 0.8)],
            chunks={"c0": make_chunk("c0"), "c1": make_chunk("c1")},
        )
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="vector", top_k=2),
        )

        assert response.rerank_requested is True
        assert response.rerank_applied is False
        assert response.total == 2

    async def test_requested_true_when_config_key_absent(self):
        """配置里没有该键时按"启用"处理（迭代 2 起精排默认开启）。

        此前默认关闭——"配置页有这个开关但绝大多数库从来没开过"，
        精排等于白配。
        """
        orchestrator, _, _ = make_orchestrator(
            vec=[("c0", 0.9)], chunks={"c0": make_chunk("c0")},
        )
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="vector", top_k=2),
        )

        assert response.rerank_requested is True
        # 本次没有可用 reranker（替身返回 None），因此未生效
        assert response.rerank_applied is False

    async def test_explicit_disable_is_respected(self):
        orchestrator, _, _ = make_orchestrator(
            kb_config={"enable_reranker": False},
            vec=[("c0", 0.9)], chunks={"c0": make_chunk("c0")},
        )
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="vector", top_k=2),
        )

        assert response.rerank_requested is False
        assert response.rerank_applied is False

    async def test_request_flag_overrides_kb_config(self):
        """请求级开关（高级面板 / 评测脚本）优先于知识库配置。"""
        orchestrator, _, _ = make_orchestrator(
            kb_config={"enable_reranker": False},
            reranker=FakeReranker(),
            vec=[("c0", 0.9), ("c1", 0.8)],
            chunks={"c0": make_chunk("c0"), "c1": make_chunk("c1")},
        )
        response = await orchestrator.search(
            None, "kb-1",
            SearchRequest(query="q", mode="vector", top_k=2, enable_rerank=True),
        )

        assert response.rerank_requested is True
        assert response.rerank_applied is True

    async def test_partial_rerank_result_is_topped_up(self):
        """精排只返回部分候选时，用召回顺序补足，条数不应变少。"""
        orchestrator, _, _ = make_orchestrator(
            reranker=FakeReranker(order=[(1, 0.9)]),
            vec=[("c0", 0.9), ("c1", 0.8), ("c2", 0.7)],
            chunks={f"c{i}": make_chunk(f"c{i}") for i in range(3)},
        )
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="vector", top_k=3),
        )

        assert response.rerank_applied is True
        assert response.total == 3
        assert response.results[0].id == "c1"


class TestHybridStrategyCandidateExpansion:
    async def test_hybrid_fetches_more_candidates_than_top_k(self):
        ctx = SearchContext(kb_id="k", query_text="q", query_embedding=[0.1], top_k=4)
        store = FakeStore(vec=[("v", 0.9)], bm25=[("b", 1.0)])
        await HybridSearchStrategy().search(ctx, store)
        assert store.vec_top_k == [8]
        assert store.bm25_top_k == [8]


# ─── 迭代 2：相关度门槛、相对截断与引用 ──────────────────────────────────────


class TestRelevanceGate:
    """绝对门槛：最高余弦低于门槛 → 判定「库内没有相关内容」。"""

    async def test_unrelated_query_returns_empty(self):
        orchestrator, _, _ = make_orchestrator(
            # 全部低于默认门槛 0.53（实测"完全无关的问题"最高 0.51）
            vec=[("c0", 0.34), ("c1", 0.30), ("c2", 0.21)],
            chunks={f"c{i}": make_chunk(f"c{i}") for i in range(3)},
        )
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="无关问题", mode="vector", top_k=5),
        )

        assert response.total == 0
        assert response.results == []
        assert response.no_relevant_result is True
        assert response.filtered_count == 3
        assert response.min_similarity == pytest.approx(0.53)

    async def test_relevant_query_passes_gate(self):
        orchestrator, _, _ = make_orchestrator(
            vec=[("c0", 0.88), ("c1", 0.42)],
            chunks={"c0": make_chunk("c0"), "c1": make_chunk("c1")},
        )
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="相关问题", mode="vector", top_k=5),
        )

        assert response.total == 2
        assert response.no_relevant_result is False

    async def test_gate_can_be_disabled_via_request(self):
        orchestrator, _, _ = make_orchestrator(
            vec=[("c0", 0.10)], chunks={"c0": make_chunk("c0")},
        )
        response = await orchestrator.search(
            None, "kb-1",
            SearchRequest(query="q", mode="vector", top_k=5, min_similarity=0.0),
        )

        assert response.total == 1
        assert response.no_relevant_result is False

    async def test_gate_reads_kb_config(self):
        """知识库配置里的门槛高于默认值时同样生效。"""
        orchestrator, _, _ = make_orchestrator(
            kb_config={"min_similarity": 0.9},
            vec=[("c0", 0.80)], chunks={"c0": make_chunk("c0")},
        )
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="vector", top_k=5),
        )

        assert response.total == 0
        assert response.min_similarity == pytest.approx(0.9)

    async def test_request_threshold_overrides_kb_config(self):
        orchestrator, _, _ = make_orchestrator(
            kb_config={"min_similarity": 0.9},
            vec=[("c0", 0.80)], chunks={"c0": make_chunk("c0")},
        )
        response = await orchestrator.search(
            None, "kb-1",
            SearchRequest(query="q", mode="vector", top_k=5, min_similarity=0.5),
        )

        assert response.total == 1

    async def test_bm25_only_result_skips_absolute_gate(self):
        """纯 BM25 没有余弦可比（量纲无界），不做绝对门槛。"""
        orchestrator, _, _ = make_orchestrator(
            bm25=[("c0", 1.2)], chunks={"c0": make_chunk("c0")},
        )
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="bm25", top_k=5),
        )

        assert response.total == 1
        assert response.min_similarity is None


class TestRelativeThreshold:
    async def test_tail_below_ratio_is_trimmed(self):
        orchestrator, _, _ = make_orchestrator(
            vec=[("c0", 0.9), ("c1", 0.8), ("c2", 0.4)],
            chunks={f"c{i}": make_chunk(f"c{i}") for i in range(3)},
        )
        response = await orchestrator.search(
            None, "kb-1",
            SearchRequest(query="q", mode="vector", top_k=5, score_threshold=0.9),
        )

        # 榜首 0.9，floor=0.81 → 只留下 c0
        assert [r.id for r in response.results] == ["c0"]
        assert response.filtered_count == 2

    async def test_disabled_by_default(self):
        orchestrator, _, _ = make_orchestrator(
            vec=[("c0", 0.9), ("c1", 0.4)],
            chunks={"c0": make_chunk("c0"), "c1": make_chunk("c1")},
        )
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="vector", top_k=5),
        )

        assert response.total == 2
        assert response.filtered_count == 0


class TestScoreSemantics:
    async def test_vector_mode_reports_cosine(self):
        orchestrator, _, _ = make_orchestrator(
            vec=[("c0", 0.77)], chunks={"c0": make_chunk("c0")},
        )
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="vector", top_k=5),
        )

        match = response.results[0]
        assert match.score_kind == "cosine"
        assert match.score == pytest.approx(0.77)
        assert match.vec_score == pytest.approx(0.77)
        assert response.score_kind == "cosine"

    async def test_hybrid_reports_raw_channel_scores(self):
        orchestrator, _, _ = make_orchestrator(
            vec=[("c0", 0.81)], bm25=[("c0", 6.5)],
            chunks={"c0": make_chunk("c0")},
        )
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="hybrid", top_k=5),
        )

        match = response.results[0]
        assert match.score_kind == "rrf"
        # 原始分如实回传，不再是"本批最高 = 1.0"
        assert match.vec_score == pytest.approx(0.81)
        assert match.bm25_score == pytest.approx(6.5)

    async def test_reranked_results_report_rerank_kind(self):
        orchestrator, _, _ = make_orchestrator(
            reranker=FakeReranker(order=[(1, 0.95), (0, 0.20)]),
            vec=[("c0", 0.9), ("c1", 0.8)],
            chunks={"c0": make_chunk("c0"), "c1": make_chunk("c1")},
        )
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="vector", top_k=2),
        )

        assert response.results[0].score_kind == "rerank"
        assert response.results[0].score == pytest.approx(0.95)
        assert response.score_kind == "rerank"


class TestCitations:
    async def test_page_and_section_come_from_metadata(self):
        chunk = make_chunk("c0")
        chunk["metadata_"] = {"page": 12, "h1": "第一章", "h2": "1.1 概述"}
        orchestrator, _, _ = make_orchestrator(
            vec=[("c0", 0.9)], chunks={"c0": chunk},
        )
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="vector", top_k=5),
        )

        match = response.results[0]
        assert match.page == 12
        assert match.section == "第一章"

    async def test_string_page_is_coerced(self):
        chunk = make_chunk("c0")
        chunk["metadata_"] = {"page": "7"}
        orchestrator, _, _ = make_orchestrator(vec=[("c0", 0.9)], chunks={"c0": chunk})
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="vector", top_k=5),
        )

        assert response.results[0].page == 7

    async def test_chroma_json_string_metadata_is_parsed(self):
        """Chroma 把 metadata_ 存成 JSON 字符串，解析失败时不能崩。"""
        chunk = make_chunk("c0")
        chunk["metadata_"] = '{"page": 3, "h1": "概览"}'
        orchestrator, _, _ = make_orchestrator(vec=[("c0", 0.9)], chunks={"c0": chunk})
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="vector", top_k=5),
        )

        assert response.results[0].page == 3
        assert response.results[0].section == "概览"

    async def test_missing_metadata_is_safe(self):
        orchestrator, _, _ = make_orchestrator(
            vec=[("c0", 0.9)], chunks={"c0": make_chunk("c0")},
        )
        response = await orchestrator.search(
            None, "kb-1", SearchRequest(query="q", mode="vector", top_k=5),
        )

        assert response.results[0].page is None
        assert response.results[0].section == ""
