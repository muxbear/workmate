"""Tests for 索引配置契约——默认值一致性与前后端字段对齐。

此前切片默认值在三处互不相同（IndexConfigSchema=512、IndexingPipeline=1024、
splitters=1000），且前端 provider 选择字段不在 schema 中（被 pydantic 静默丢弃），
导致「选了提供商却按模型名全局解析」。
"""

import pytest

from api.knowledge_base.schemas import IndexConfigSchema
from core.rag.bm25 import DEFAULT_B, DEFAULT_K1, SPARSE_ALGO_BM25
from core.rag.splitters import INDEX_CONFIG_DEFAULTS


class TestDefaultsConsistency:
    def test_chunk_size_matches_single_source_of_truth(self):
        assert IndexConfigSchema().chunk_size == INDEX_CONFIG_DEFAULTS["chunk_size"]

    def test_chunk_overlap_matches_single_source_of_truth(self):
        assert (
            IndexConfigSchema().chunk_overlap == INDEX_CONFIG_DEFAULTS["chunk_overlap"]
        )

    def test_sparse_defaults_match_bm25_module(self):
        config = IndexConfigSchema()
        assert config.sparse_algo == SPARSE_ALGO_BM25
        assert config.bm25_k1 == DEFAULT_K1
        assert config.bm25_b == DEFAULT_B

    def test_reranker_enabled_by_default(self):
        """新知识库默认启用精排（迭代 2）。

        此前默认关闭，导致"配置页有开关但绝大多数库从来没开过"，精排等于白配。
        模型不可用时检索会如实返回 ``rerank_applied=false``，不会假装生效。
        """
        assert IndexConfigSchema().enable_reranker is True

    def test_relevance_threshold_defaults(self):
        """门槛默认值：余弦 0.53（黄金集校准值）；相对截断默认关闭。"""
        config = IndexConfigSchema()
        assert config.min_similarity == pytest.approx(0.53)
        assert config.score_threshold == pytest.approx(0.0)

    def test_query_rewrite_disabled_by_default(self):
        """查询改写默认关闭（迭代 3 T3.4）。

        它每次都多一次 LLM 调用（延迟 + 成本），按方案 §12.1 的灰度策略
        "默认关闭、按库/按次开启"。开启后最坏情况也只是退回改写前的行为——
        原始查询始终参与召回。
        """
        config = IndexConfigSchema()
        assert config.enable_query_rewrite is False
        assert config.enable_hyde is False

    def test_ocr_disabled_by_default(self):
        """OCR 默认关闭（迭代 6 T6.4）。

        开启后扫描件与图片会逐页调用外部视觉模型（延迟、费用、内容出网），
        按方案 §12.1 的灰度策略"默认关闭、按库开启"。
        """
        assert IndexConfigSchema().enable_ocr is False


class TestFrontendPayloadContract:
    """前端 configToSnake() 产出的字段必须能被 schema 接收（否则被静默丢弃）。"""

    FRONTEND_PAYLOAD = {
        "chunk_strategy": "recursive",
        "chunk_size": 512,
        "chunk_overlap": 64,
        "parent_chunk_size": 2048,
        "min_chunk_size": 48,
        "embedding_model": "text-embedding-v4",
        "embedding_provider_id": "provider-1",
        "embedding_dim": 1024,
        "sparse_algo": "bm25_plus",
        "bm25_k1": 1.8,
        "bm25_b": 0.6,
        "entity_model": "deepseek-v3",
        "relation_model": "deepseek-v3",
        "enable_graph": False,
        "reranker_model": "bge-reranker-v2-m3",
        "reranker_provider_id": "provider-2",
        "enable_reranker": True,
        "top_k": 8,
        "hybrid_alpha": 0.4,
        "enable_query_rewrite": True,
        "enable_hyde": True,
        "enable_ocr": True,
        "ocr_model": "qwen-vl-ocr",
        "ocr_provider_id": "provider-3",
    }

    def test_all_fields_are_accepted(self):
        config = IndexConfigSchema(**self.FRONTEND_PAYLOAD)
        for key, value in self.FRONTEND_PAYLOAD.items():
            assert getattr(config, key) == value, f"字段 {key} 未生效"

    def test_round_trip_through_model_dump(self):
        """存储为 JSON 再读回不应丢字段（KB 的 config 列即此路径）。"""
        stored = IndexConfigSchema(**self.FRONTEND_PAYLOAD).model_dump()
        restored = IndexConfigSchema(**stored)
        assert restored.reranker_provider_id == "provider-2"
        assert restored.embedding_provider_id == "provider-1"
        assert restored.enable_graph is False
        assert restored.enable_ocr is True
        assert restored.ocr_provider_id == "provider-3"

    def test_provider_ids_are_optional(self):
        """历史配置没有 provider 字段，读取时不能报错。"""
        legacy = {
            k: v
            for k, v in self.FRONTEND_PAYLOAD.items()
            if not k.endswith("_provider_id")
        }
        config = IndexConfigSchema(**legacy)
        assert config.embedding_provider_id is None
        assert config.reranker_provider_id is None
        assert config.ocr_provider_id is None

    def test_unknown_fields_are_ignored_not_fatal(self):
        """旧版本前端多传字段时不应 500。"""
        payload = {**self.FRONTEND_PAYLOAD, "legacy_field": "x"}
        assert IndexConfigSchema(**payload).chunk_size == 512

    def test_sparse_algo_accepts_all_ui_values(self):
        for algo in ("bm25", "bm25_plus", "tf_idf", "none"):
            assert IndexConfigSchema(sparse_algo=algo).sparse_algo == algo
