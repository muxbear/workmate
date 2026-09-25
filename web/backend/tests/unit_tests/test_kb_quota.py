"""知识库配额（迭代 5 T5.3）。

限额是"按部署环境决定"的策略，因此默认**全部不限**（值为 0）——升级时默认收紧会把
存量用户直接挡在门外。真正要紧的是两件事：

1. 配了限额就要**真的拦住**（库数 / 单库文档数 / 总存储）；
2. 拦下来时的文案要带**当前值、上限、怎么改**——只说"超限"会让用户无从判断是文件
   太大、库太多还是空间不够，也不知道能不能自己解决。
"""

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from api.knowledge_base.quota import ensure_doc_quota, ensure_kb_quota
from db.models.knowledge_base import KnowledgeBase
from db.models.knowledge_base_document import KnowledgeBaseDocument

pytestmark = pytest.mark.anyio

MB = 1024 * 1024


@pytest.fixture
async def db():
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        await conn.run_sync(KnowledgeBase.__table__.create)
        await conn.run_sync(KnowledgeBaseDocument.__table__.create)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as session:
        yield session
    await engine.dispose()


@pytest.fixture
def limits(monkeypatch):
    """按用例设置限额（0 = 不限）。"""
    from agent.config import settings

    def apply(**kwargs):
        for key, value in kwargs.items():
            monkeypatch.setattr(settings, key, value)

    return apply


async def seed_kb(db, kb_id: str, user_id: str, *, docs: int = 0, size_bytes: int = 0) -> None:
    db.add(KnowledgeBase(
        id=kb_id, name=kb_id, description="", user_id=user_id, status="ready",
        config={}, tags=[], docs_count=docs, visibility="private",
    ))
    for i in range(docs):
        db.add(KnowledgeBaseDocument(
            id=f"{kb_id}-d{i}", kb_id=kb_id, name=f"文档{i}", type="md",
            size_bytes=size_bytes // max(docs, 1), storage_path="/tmp/x.md",
            status="indexed",
        ))
    await db.commit()


class TestKbCountQuota:
    async def test_unlimited_by_default(self, db, limits):
        limits(KB_MAX_PER_USER=0)
        await seed_kb(db, "kb1", "u1")

        await ensure_kb_quota(db, "u1")  # 不该抛

    async def test_rejects_when_reaching_limit(self, db, limits):
        limits(KB_MAX_PER_USER=2)
        await seed_kb(db, "kb1", "u1")
        await seed_kb(db, "kb2", "u1")

        with pytest.raises(HTTPException) as exc:
            await ensure_kb_quota(db, "u1")

        assert exc.value.status_code == 400
        assert "2/2" in exc.value.detail, "文案要给出当前值与上限"
        assert "KB_MAX_PER_USER" in exc.value.detail, "要告诉运维改哪个配置"

    async def test_quota_is_per_user(self, db, limits):
        limits(KB_MAX_PER_USER=1)
        await seed_kb(db, "kb1", "u1")

        await ensure_kb_quota(db, "u2")  # 别人已经建满不影响我

    async def test_below_limit_passes(self, db, limits):
        limits(KB_MAX_PER_USER=3)
        await seed_kb(db, "kb1", "u1")

        await ensure_kb_quota(db, "u1")


class TestDocAndStorageQuota:
    async def test_doc_count_limit(self, db, limits):
        limits(KB_MAX_DOCS_PER_KB=2, KB_MAX_STORAGE_MB_PER_USER=0)
        await seed_kb(db, "kb1", "u1", docs=2)

        with pytest.raises(HTTPException) as exc:
            await ensure_doc_quota(db, "kb1", "u1", incoming_bytes=10)

        assert exc.value.status_code == 400
        assert "2/2" in exc.value.detail
        assert "KB_MAX_DOCS_PER_KB" in exc.value.detail

    async def test_storage_limit_counts_existing_files(self, db, limits):
        """总存储是**累计**口径：已用的算进去，不是只看这一次。"""
        limits(KB_MAX_DOCS_PER_KB=0, KB_MAX_STORAGE_MB_PER_USER=10)
        await seed_kb(db, "kb1", "u1", docs=1, size_bytes=9 * MB)

        with pytest.raises(HTTPException) as exc:
            await ensure_doc_quota(db, "kb1", "u1", incoming_bytes=2 * MB)

        detail = exc.value.detail
        assert "已用 9 MB" in detail and "上限 10 MB" in detail
        assert "KB_MAX_STORAGE_MB_PER_USER" in detail

    async def test_exactly_at_limit_passes(self, db, limits):
        limits(KB_MAX_DOCS_PER_KB=0, KB_MAX_STORAGE_MB_PER_USER=10)
        await seed_kb(db, "kb1", "u1", docs=1, size_bytes=9 * MB)

        await ensure_doc_quota(db, "kb1", "u1", incoming_bytes=MB)  # 正好 10MB

    async def test_quota_counts_only_the_target_kb(self, db, limits):
        limits(KB_MAX_DOCS_PER_KB=1, KB_MAX_STORAGE_MB_PER_USER=0)
        await seed_kb(db, "kb1", "u1", docs=1)
        await seed_kb(db, "kb2", "u1", docs=0)

        await ensure_doc_quota(db, "kb2", "u1", incoming_bytes=10)  # 另一个库满了不影响

    async def test_unlimited_by_default(self, db, limits):
        limits(KB_MAX_DOCS_PER_KB=0, KB_MAX_STORAGE_MB_PER_USER=0)
        await seed_kb(db, "kb1", "u1", docs=50, size_bytes=1024 * MB)

        await ensure_doc_quota(db, "kb1", "u1", incoming_bytes=1024 * MB)


class TestFileSizeLimitIsConfigurable:
    def test_configured_value_wins(self, monkeypatch):
        from agent.config import settings
        from api.knowledge_base import doc_service

        monkeypatch.setattr(settings, "KB_MAX_FILE_MB", 5)

        assert doc_service._max_file_bytes() == 5 * MB

    def test_falls_back_to_module_default(self, monkeypatch):
        from agent.config import settings
        from api.knowledge_base import doc_service

        monkeypatch.setattr(settings, "KB_MAX_FILE_MB", 0)

        assert doc_service._max_file_bytes() == doc_service.MAX_FILE_SIZE_MB * MB


class TestHeavyEndpointsAreRateLimited:
    """上传与检索都要限流：前者落盘并触发 embedding 计费，后者要打向量库 + 精排/改写。

    用结构化断言而不是功能断言（逐次调用到触发 429）：装饰器是黑盒，功能测试只能证明
    "某条路径上限流了"，覆盖不到"新加了重接口但忘了挂"这种真实回归。
    """

    def _find(self, path: str, method: str):
        from server import app
        from unit_tests.test_kb_permissions import _flatten_routes

        return next(
            (r for r in _flatten_routes(app.routes)
             if r.path == path and method in (r.methods or set())),
            None,
        )

    def test_upload_is_rate_limited(self):
        route = self._find("/api/knowledge-bases/{kb_id}/documents/upload", "POST")

        assert route is not None
        limit = getattr(route.endpoint, "__rate_limit__", None)
        assert limit is not None, "上传接口没挂限流"
        assert limit[0] > 0 and limit[1] > 0

    def test_search_is_rate_limited(self):
        route = self._find("/api/knowledge-bases/{kb_id}/search", "POST")

        assert route is not None
        assert getattr(route.endpoint, "__rate_limit__", None) is not None, "检索接口没挂限流"
