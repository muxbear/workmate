"""Embedding 维度与模型绑定校验（迭代 4 T4.4）。

此前的状态：维度完全靠用户在配置页手填、**没有任何校验**。三个后果：

1. 填错维度（比如 768 而模型输出 1024）时集合按错维度建好，直到第一片向量写进去
   才报错，而错误信息是向量库的维度断言——与"配置页填错了"这个真正的原因无关；
2. 文档级 config 可以覆盖 embedding 模型 → **同一个库混入不同语义空间的向量**，
   检索结果互不可比且悄无声息；
3. 换模型后不重建索引也不报错。

用例覆盖：探测落库、不一致拒绝、无法确定时放行（探测失败不能把功能锁死）、
文档级覆盖拦截。
"""

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from api.knowledge_base.model_provider import check_embedding_dim, resolve_embedding_dim
from api.knowledge_base.schemas import IndexConfigSchema
from core.rag.vector_store import BaseVectorStore
from db.base import Base
from db.models.ai_model import AIModel
from db.models.provider import Provider

pytestmark = pytest.mark.anyio


@pytest.fixture
async def sessionmaker():
    from db.models.knowledge_base import KnowledgeBase
    from db.models.knowledge_base_document import KnowledgeBaseDocument

    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        await conn.run_sync(Provider.__table__.create)
        await conn.run_sync(AIModel.__table__.create)
        await conn.run_sync(KnowledgeBase.__table__.create)
        await conn.run_sync(KnowledgeBaseDocument.__table__.create)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    yield maker
    await engine.dispose()


async def seed_model(
    sessionmaker, *, dim: int | None, name: str = "text-embedding-v4",
) -> None:
    """写入一条可用的 embedding 模型。

    注意 ``api_key`` 必须是**加密后**的形态：模型解析会解密后再判断可用性，
    明文写进去会被当成"解密失败"而跳过（这正是"模型页配置看起来正常但检索说没有
    可用模型"的常见原因）。
    """
    from core.security import encrypt_api_key

    async with sessionmaker() as session:
        session.add(Provider(
            id="p1", name="DashScope", user_id="u1",
            api_base="https://dashscope.example.com/v1",
            api_key=encrypt_api_key("sk-test"),
        ))
        session.add(AIModel(
            id="m1", provider_id="p1", name=name, display_name=name,
            type="embedding", dim=dim,
        ))
        await session.commit()


class FakeEmbeddings:
    """替身：返回固定长度的向量。"""

    def __init__(self, dim: int = 1024):
        self.dim = dim
        self.calls = 0

    async def aembed_query(self, text: str) -> list[float]:
        self.calls += 1
        return [0.1] * self.dim


class TestDimProbe:
    async def test_declared_dim_is_returned_without_probing(self, sessionmaker, monkeypatch):
        await seed_model(sessionmaker, dim=1024)

        def explode(*args, **kwargs):  # pragma: no cover
            raise AssertionError("已声明维度时不该调用 API 探测")

        monkeypatch.setattr(
            "api.knowledge_base.model_provider.load_embedding_model", explode,
        )

        async with sessionmaker() as db:
            assert await resolve_embedding_dim(db) == 1024

    async def test_missing_dim_is_probed_and_persisted(self, sessionmaker, monkeypatch):
        """模型页没填维度时探测一次并落库——省得用户去翻文档填错。"""
        await seed_model(sessionmaker, dim=None)
        fake = FakeEmbeddings(dim=1024)
        monkeypatch.setattr(
            "api.knowledge_base.model_provider.load_embedding_model",
            lambda *a, **kw: _async_return(fake),
        )

        async with sessionmaker() as db:
            dim = await resolve_embedding_dim(db)
            assert dim == 1024

        async with sessionmaker() as db:
            row = await db.get(AIModel, "m1")
            assert row.dim == 1024, "探测结果应落库，避免每次都调 API"

    async def test_probe_failure_returns_none(self, sessionmaker, monkeypatch):
        await seed_model(sessionmaker, dim=None)

        async def boom(*args, **kwargs):
            raise RuntimeError("embedding 服务不可用")

        monkeypatch.setattr(
            "api.knowledge_base.model_provider.load_embedding_model", boom,
        )

        async with sessionmaker() as db:
            assert await resolve_embedding_dim(db) is None

    async def test_no_model_raises(self, sessionmaker):
        async with sessionmaker() as db:
            with pytest.raises(RuntimeError, match="embedding 模型"):
                await resolve_embedding_dim(db)


async def _async_return(value):
    return value


class TestCheckEmbeddingDim:
    async def test_mismatch_returns_actionable_message(self, sessionmaker):
        await seed_model(sessionmaker, dim=1024)
        config = IndexConfigSchema(embedding_model="text-embedding-v4", embedding_dim=768)

        async with sessionmaker() as db:
            message = await check_embedding_dim(db, config)

        assert message and "768" in message and "1024" in message
        assert "重建索引" in message, "要告诉用户怎么修，而不是只说错了"

    async def test_match_returns_none(self, sessionmaker):
        await seed_model(sessionmaker, dim=1024)
        config = IndexConfigSchema(embedding_model="text-embedding-v4", embedding_dim=1024)

        async with sessionmaker() as db:
            assert await check_embedding_dim(db, config) is None

    async def test_dict_config_is_supported(self, sessionmaker):
        """落库的配置是 dict，历史配置还可能是 camelCase。"""
        await seed_model(sessionmaker, dim=1024)

        async with sessionmaker() as db:
            assert await check_embedding_dim(
                db, {"embedding_model": "text-embedding-v4", "embedding_dim": 1024},
            ) is None
            assert await check_embedding_dim(
                db, {"embedding_model": "text-embedding-v4", "embeddingDim": 512},
            )

    async def test_unknown_actual_dim_lets_it_pass(self, sessionmaker):
        """探测不出来时放行：不能因为探测失败就把建库/重建整个锁死。"""
        config = IndexConfigSchema(embedding_model="不存在的模型", embedding_dim=768)

        async with sessionmaker() as db:
            assert await check_embedding_dim(db, config) is None

    async def test_missing_configured_dim_lets_it_pass(self, sessionmaker):
        await seed_model(sessionmaker, dim=1024)
        config = IndexConfigSchema(embedding_model="text-embedding-v4")
        config.embedding_dim = 0  # 非正数视为未声明

        async with sessionmaker() as db:
            assert await check_embedding_dim(db, config) is None


class TestDocLevelOverrideIsRejected:
    def test_embedding_model_override_is_rejected(self):
        from fastapi import HTTPException

        from api.knowledge_base.doc_service import validate_doc_config

        with pytest.raises(HTTPException) as exc:
            validate_doc_config(
                {"embedding_model": "另一个模型"},
                {"embedding_model": "text-embedding-v4", "embedding_dim": 1024},
            )

        assert exc.value.status_code == 400
        assert "embedding_model" in exc.value.detail
        assert "重建索引" in exc.value.detail

    def test_embedding_dim_override_is_rejected(self):
        from fastapi import HTTPException

        from api.knowledge_base.doc_service import validate_doc_config

        with pytest.raises(HTTPException):
            validate_doc_config({"embedding_dim": 768}, {"embedding_dim": 1024})

    def test_identical_values_are_allowed(self):
        from api.knowledge_base.doc_service import validate_doc_config

        validate_doc_config(
            {"embedding_model": "text-embedding-v4", "embedding_dim": 1024},
            {"embedding_model": "text-embedding-v4", "embedding_dim": 1024},
        )

    def test_other_overrides_are_allowed(self):
        """切片策略、门槛这些**可以在文档级覆盖**，别把挡板做成一堵墙。"""
        from api.knowledge_base.doc_service import validate_doc_config

        validate_doc_config(
            {"chunk_strategy": "markdown", "chunk_size": 256, "min_similarity": 0.4},
            {"embedding_model": "text-embedding-v4"},
        )

    def test_empty_config_is_fine(self):
        from api.knowledge_base.doc_service import validate_doc_config

        validate_doc_config(None, {"embedding_dim": 1024})
        validate_doc_config({}, {"embedding_dim": 1024})


class TestCreateCollectionDimIsValidatedBeforeHand:
    async def test_reindex_rejects_mismatched_dim(self, sessionmaker):
        """重建是"换模型/换维度"的唯一正确入口，必须在这里拦住不一致的配置。"""
        from fastapi import HTTPException

        from api.knowledge_base.service import reindex_kb
        from db.models.knowledge_base import KnowledgeBase

        await seed_model(sessionmaker, dim=1024)
        async with sessionmaker() as db:
            db.add(KnowledgeBase(
                id="kb-1", name="库", user_id="u1", status="ready", description="",
                config={"embedding_model": "text-embedding-v4", "embedding_dim": 1024},
                tags=[], visibility="private", docs_count=0, chunks_count=0,
            ))
            await db.commit()

        async with sessionmaker() as db:
            with pytest.raises(HTTPException) as exc:
                await reindex_kb(
                    db, "kb-1", "u1",
                    config=IndexConfigSchema(
                        embedding_model="text-embedding-v4", embedding_dim=256,
                    ),
                )
        assert exc.value.status_code == 400
        assert "256" in exc.value.detail


class TestVectorStoreInterfaceAcceptsSparseParams:
    def test_create_collection_signature_carries_sparse_params(self):
        """BM25 的 k1/b 固化在稀疏索引里，接口必须支持在建集合时传入。"""
        import inspect

        params = inspect.signature(BaseVectorStore.create_collection).parameters
        assert "sparse_params" in params
