"""Tests for kb_search / list_knowledge_bases 的用户隔离。

这些工具此前完全按 ``kb_id`` 查询且会「自动取第一个 ready 的知识库」，等于把
其他用户的知识库暴露给任意会话。此处用内存 SQLite 覆盖真实 WHERE 条件。
"""

import importlib

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from api.knowledge_base.schemas import SearchResponse
from api.knowledge_base.search_service import set_search_orchestrator
from db.models.knowledge_base import KnowledgeBase

# 注意：agent.tools.__init__ 会把同名函数导出到包命名空间，因此
# `from agent.tools import kb_search` 拿到的是函数而非模块，必须走 importlib。
kb_search_module = importlib.import_module("agent.tools.kb_search")

pytestmark = pytest.mark.anyio

USER_A = "user-a"
USER_B = "user-b"


class FakeOrchestrator:
    def __init__(self):
        self.calls: list[tuple[str, object]] = []

    async def search(self, db, kb_id, request):
        self.calls.append((kb_id, request))
        return SearchResponse(
            query=request.query,
            mode=request.mode,
            total=1,
            results=[{
                "id": "c1", "doc_id": "d1", "doc_name": "手册.pdf",
                "chunk_index": 0, "content": "命中内容",
                "score": 0.9, "vec_score": 0.8, "bm25_score": None,
            }],
        )


@pytest.fixture
async def sessionmaker():
    """内存 SQLite 会话工厂，替换 db.engine.async_session。"""
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        await conn.run_sync(KnowledgeBase.__table__.create)

    maker = async_sessionmaker(engine, expire_on_commit=False)
    yield maker
    await engine.dispose()


@pytest.fixture
def patched_env(monkeypatch, sessionmaker):
    """把工具用到的会话工厂与全局编排器都替换掉。"""
    monkeypatch.setattr("db.engine.async_session", sessionmaker)
    orchestrator = FakeOrchestrator()
    set_search_orchestrator(orchestrator)  # type: ignore[arg-type]
    yield orchestrator
    set_search_orchestrator(None)  # type: ignore[arg-type]


async def seed(sessionmaker, rows: list[dict]) -> None:
    async with sessionmaker() as session:
        for row in rows:
            session.add(KnowledgeBase(**row))
        await session.commit()


def kb_row(kb_id: str, name: str, user_id: str, status: str = "ready") -> dict:
    return {
        "id": kb_id, "name": name, "user_id": user_id, "status": status,
        "description": "", "config": {}, "tags": [], "docs_count": 1,
    }


async def call_search(**kwargs) -> dict:
    """直接调用异步实现，避免 asyncio.run 嵌套。"""
    params = {"query": "查询", "kb_id": "", "kb_name": "", "mode": "hybrid", "top_k": 5}
    params.update(kwargs)
    return await kb_search_module._kb_search_async(**params)


class TestUserIsolation:
    async def test_other_users_explicit_kb_id_is_rejected(
        self, monkeypatch, patched_env, sessionmaker,
    ):
        """即使模型猜中他人 kb_id，也不得检索。"""
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [kb_row("kb-b", "他人知识库", USER_B)])

        result = await call_search(kb_id="kb-b")

        assert "不属于当前用户" in result["error"]
        assert patched_env.calls == [], "不得对他人知识库发起检索"
        assert result["results"] == []

    async def test_own_kb_is_searchable(self, monkeypatch, patched_env, sessionmaker):
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [kb_row("kb-a", "我的知识库", USER_A)])

        result = await call_search(kb_id="kb-a")

        assert result["total"] == 1
        assert result["results"][0]["content"] == "命中内容"
        assert patched_env.calls[0][0] == "kb-a"

    async def test_kb_name_resolution_is_scoped_to_user(
        self, monkeypatch, patched_env, sessionmaker,
    ):
        """同名场景下不能解析到他人知识库。"""
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [kb_row("kb-b", "产品手册", USER_B)])

        result = await call_search(kb_name="产品手册")

        assert "未找到匹配的知识库" in result["error"]
        assert patched_env.calls == []

    async def test_available_kbs_only_list_own(self, monkeypatch, patched_env, sessionmaker):
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [
            kb_row("kb-a", "我的", USER_A),
            kb_row("kb-b", "他人的", USER_B),
        ])

        result = await call_search(kb_id="not-exist")

        names = [item["kb_id"] for item in result["available_kbs"]]
        assert names == ["kb-a"]

    async def test_auto_discovery_returns_own_kb(self, monkeypatch, patched_env, sessionmaker):
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [
            kb_row("kb-b", "他人的", USER_B),
            kb_row("kb-a", "我的", USER_A),
        ])

        result = await call_search()

        assert result["total"] == 1
        assert patched_env.calls[0][0] == "kb-a"

    async def test_no_ready_kb_reports_available_list(
        self, monkeypatch, patched_env, sessionmaker,
    ):
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [kb_row("kb-a", "未就绪", USER_A, status="indexing")])

        result = await call_search()

        assert "没有 ready 状态的知识库" in result["error"]
        assert patched_env.calls == []

    async def test_missing_user_context_refuses_search(
        self, monkeypatch, patched_env, sessionmaker,
    ):
        """无会话上下文时无法判定归属，必须拒绝而不是放行。"""
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: "")
        await seed(sessionmaker, [kb_row("kb-a", "任意", USER_A)])

        result = await call_search(kb_id="kb-a")

        assert "缺少用户会话上下文" in result["error"]
        assert patched_env.calls == []


class TestSearchBehaviour:
    async def test_empty_query_short_circuits(self, monkeypatch, patched_env):
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        assert await call_search(query="   ") == {"total": 0, "results": []}

    async def test_search_failure_returns_available_kbs(
        self, monkeypatch, patched_env, sessionmaker,
    ):
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [kb_row("kb-a", "我的", USER_A)])

        async def boom(db, kb_id, request):
            raise RuntimeError("collection 不存在")

        monkeypatch.setattr(patched_env, "search", boom)

        result = await call_search(kb_id="kb-a")

        assert "检索失败" in result["error"]
        assert [item["kb_id"] for item in result["available_kbs"]] == ["kb-a"]

    async def test_result_mapping(self, monkeypatch, patched_env, sessionmaker):
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [kb_row("kb-a", "我的", USER_A)])

        result = await call_search(kb_id="kb-a", mode="vector", top_k=3)

        assert result["results"][0] == {
            "doc": "手册.pdf", "content": "命中内容", "score": 0.9,
            "vec_score": 0.8, "bm25_score": None,
        }
        assert patched_env.calls[0][1].mode == "vector"
        assert patched_env.calls[0][1].top_k == 3

    async def test_orchestrator_missing(self, monkeypatch, sessionmaker):
        monkeypatch.setattr("db.engine.async_session", sessionmaker)
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        set_search_orchestrator(None)  # type: ignore[arg-type]

        result = await call_search(kb_id="kb-a")

        assert "搜索服务未就绪" in result["error"]


class TestListKnowledgeBases:
    async def test_scoped_to_current_user(self, monkeypatch, patched_env, sessionmaker):
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [
            kb_row("kb-a", "我的", USER_A),
            kb_row("kb-b", "他人的", USER_B),
            kb_row("kb-a2", "我的未就绪", USER_A, status="draft"),
        ])

        result = await kb_search_module._list_kb_async()

        assert result["total"] == 1
        assert result["knowledge_bases"][0]["kb_id"] == "kb-a"

    async def test_missing_context_returns_empty(self, monkeypatch, patched_env):
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: "")
        result = await kb_search_module._list_kb_async()
        assert result["total"] == 0
        assert "error" in result
