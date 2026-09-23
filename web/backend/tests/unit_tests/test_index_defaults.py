"""Tests for 索引配置契约——默认值一致性与前后端字段对齐。

此前切片默认值在三处互不相同（IndexConfigSchema=512、IndexingPipeline=1024、
splitters=1000），且前端 provider 选择字段不在 schema 中（被 pydantic 静默丢弃），
导致「选了提供商却按模型名全局解析」。
"""

from api.knowledge_base.schemas import IndexConfigSchema
from core.rag.bm25 import DEFAULT_B, DEFAULT_K1, SPARSE_ALGO_BM25
from core.rag.splitters import INDEX_CONFIG_DEFAULTS


class TestDefaultsConsistency:
    def test_chunk_size_matches_single_source_of_truth(self):
        assert IndexConfigSchema().chunk_size == INDEX_CONFIG_DEFAULTS["chunk_size"]

    def test_chunk_overlap_matches_single_source_of_truth(self):
        assert IndexConfigSchema().chunk_overlap == INDEX_CONFIG_DEFAULTS["chunk_overlap"]

    def test_sparse_defaults_match_bm25_module(self):
        config = IndexConfigSchema()
        assert config.sparse_algo == SPARSE_ALGO_BM25
        assert config.bm25_k1 == DEFAULT_K1
        assert config.bm25_b == DEFAULT_B

    def test_reranker_disabled_by_default(self):
        """新知识库默认不启用精排——未接入却默认开启会误导用户。"""
        assert IndexConfigSchema().enable_reranker is False


class TestFrontendPayloadContract:
    """前端 configToSnake() 产出的字段必须能被 schema 接收（否则被静默丢弃）。"""

    FRONTEND_PAYLOAD = {
        "chunk_strategy": "recursive",
        "chunk_size": 512,
        "chunk_overlap": 64,
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

    def test_provider_ids_are_optional(self):
        """历史配置没有 provider 字段，读取时不能报错。"""
        legacy = {k: v for k, v in self.FRONTEND_PAYLOAD.items()
                  if not k.endswith("_provider_id")}
        config = IndexConfigSchema(**legacy)
        assert config.embedding_provider_id is None
        assert config.reranker_provider_id is None

    def test_unknown_fields_are_ignored_not_fatal(self):
        """旧版本前端多传字段时不应 500。"""
        payload = {**self.FRONTEND_PAYLOAD, "legacy_field": "x"}
        assert IndexConfigSchema(**payload).chunk_size == 512

    def test_sparse_algo_accepts_all_ui_values(self):
        for algo in ("bm25", "bm25_plus", "tf_idf", "none"):
            assert IndexConfigSchema(sparse_algo=algo).sparse_algo == algo
