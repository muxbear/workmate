"""Tests for kb_search / list_knowledge_bases 的可见范围隔离。

这些工具此前完全按 ``kb_id`` 查询且会「自动取第一个 ready 的知识库」，等于把
其他用户的知识库暴露给任意会话。此处用内存 SQLite 覆盖真实 WHERE 条件。

可见范围：「自己创建的 ∪ 已接受的分享 ∪ 公共库」，未授权（含仅收到邀请但
未接受）的知识库仍必须被拒绝。
"""

import importlib

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from api.knowledge_base.schemas import SearchResponse
from api.knowledge_base.search_service import set_search_orchestrator
from db.models.knowledge_base import KnowledgeBase
from db.models.knowledge_base_share import (
    SHARE_STATUS_ACCEPTED,
    SHARE_STATUS_PENDING,
    KnowledgeBaseShare,
)

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
        await conn.run_sync(KnowledgeBaseShare.__table__.create)

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


def kb_row(
    kb_id: str, name: str, user_id: str, status: str = "ready",
    visibility: str = "private",
) -> dict:
    return {
        "id": kb_id, "name": name, "user_id": user_id, "status": status,
        "description": "", "config": {}, "tags": [], "docs_count": 1,
        "visibility": visibility,
    }


async def seed_shares(sessionmaker, rows: list[dict]) -> None:
    async with sessionmaker() as session:
        for row in rows:
            session.add(KnowledgeBaseShare(**row))
        await session.commit()


def share_row(
    share_id: str, kb_id: str, owner_id: str, grantee_id: str,
    status: str = SHARE_STATUS_ACCEPTED,
) -> dict:
    return {
        "id": share_id, "kb_id": kb_id, "owner_id": owner_id,
        "grantee_id": grantee_id, "status": status, "permission": "read",
    }


async def call_search(**kwargs) -> dict:
    """直接调用异步实现，避免 asyncio.run 嵌套。"""
    # top_k 默认 None：与工具签名一致（未显式传入时跟随知识库配置）
    params = {"query": "查询", "kb_id": "", "kb_name": "", "mode": "hybrid", "top_k": None}
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

        assert "无权访问" in result["error"]
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


class TestArgumentGuards:
    """参数由模型自由填写，非法值必须回可读提示而不是让工具抛异常。"""

    async def test_invalid_mode_returns_available_modes(
        self, monkeypatch, patched_env, sessionmaker,
    ):
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [kb_row("kb-a", "我的", USER_A)])

        result = await call_search(kb_id="kb-a", mode="graph")

        assert "不支持的检索模式" in result["error"]
        assert set(result["available_modes"]) == {"hybrid", "vector", "bm25"}
        assert patched_env.calls == [], "非法 mode 不得发起检索"

    async def test_out_of_range_top_k_is_clamped(
        self, monkeypatch, patched_env, sessionmaker,
    ):
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [kb_row("kb-a", "我的", USER_A)])

        await call_search(kb_id="kb-a", top_k=500)
        await call_search(kb_id="kb-a", top_k=-3)

        assert [req.top_k for _, req in patched_env.calls] == [50, 1]

    async def test_non_numeric_top_k_falls_back_to_default(
        self, monkeypatch, patched_env, sessionmaker,
    ):
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [kb_row("kb-a", "我的", USER_A)])

        await call_search(kb_id="kb-a", top_k="很多")

        assert patched_env.calls[0][1].top_k == 5

    async def test_unexpected_error_is_contained(
        self, monkeypatch, patched_env, sessionmaker,
    ):
        """工具边界必须兜住任何异常（此前只捕获 RuntimeError）。"""
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [kb_row("kb-a", "我的", USER_A)])

        async def boom(*args, **kwargs):
            raise KeyError("unexpected")

        patched_env.search = boom  # type: ignore[method-assign]
        result = await call_search(kb_id="kb-a")

        assert "检索失败" in result["error"]
        assert result["total"] == 0


class TestKnowledgeBaseSelection:
    async def test_multiple_kbs_require_explicit_id(
        self, monkeypatch, patched_env, sessionmaker,
    ):
        """未指定 kb_id 且有多个可用库时不猜测——此前 limit(1) 无排序，结果不可复现。"""
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [
            kb_row("kb-a", "我的甲", USER_A),
            kb_row("kb-b", "我的乙", USER_A),
        ])

        result = await call_search()

        assert "多个可用知识库" in result["error"]
        assert {item["kb_id"] for item in result["candidates"]} == {"kb-a", "kb-b"}
        assert patched_env.calls == [], "多候选时不得擅自选中某一个"

    async def test_ambiguous_name_requires_explicit_id(
        self, monkeypatch, patched_env, sessionmaker,
    ):
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [
            kb_row("kb-a", "产品手册 v1", USER_A),
            kb_row("kb-b", "产品手册 v2", USER_A),
        ])

        result = await call_search(kb_name="产品手册")

        assert "匹配到多个知识库" in result["error"]
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
            # 引用定位：模型可据此给出可核查的出处
            "doc_id": "d1", "chunk_index": 0, "page": None, "section": "",
            "score_kind": "", "kb_name": None,
        }
        assert patched_env.calls[0][1].mode == "vector"
        assert patched_env.calls[0][1].top_k == 3

    async def test_missing_top_k_uses_kb_config(
        self, monkeypatch, patched_env, sessionmaker,
    ):
        """未显式传 top_k 时用知识库配置的 Top-K——此前工具硬编码 5，
        用户在配置页设的值对智能体完全无效。"""
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [{
            **kb_row("kb-a", "我的", USER_A), "config": {"top_k": 12},
        }])

        await call_search(kb_id="kb-a")

        assert patched_env.calls[0][1].top_k == 12

    async def test_no_relevant_result_is_distinguished(
        self, monkeypatch, patched_env, sessionmaker,
    ):
        """「库里没有相关内容」必须与「检索失败」区分开，模型才能如实回答。"""
        from api.knowledge_base.schemas import SearchResponse

        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [kb_row("kb-a", "我的", USER_A)])

        async def empty_search(db, kb_id, request):
            patched_env.calls.append((kb_id, request))
            return SearchResponse(
                query=request.query, mode=request.mode, total=0, results=[],
                no_relevant_result=True, min_similarity=0.35, filtered_count=6,
            )

        patched_env.search = empty_search  # type: ignore[method-assign]
        result = await call_search(kb_id="kb-a")

        assert result["total"] == 0
        assert result["no_relevant_result"] is True
        assert "未找到" in result["hint"]
        assert "error" not in result

    async def test_orchestrator_missing(self, monkeypatch, sessionmaker):
        monkeypatch.setattr("db.engine.async_session", sessionmaker)
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        set_search_orchestrator(None)  # type: ignore[arg-type]

        result = await call_search(kb_id="kb-a")

        assert "搜索服务未就绪" in result["error"]


class TestMultiKbSearch:
    async def test_unreadable_kb_in_kb_ids_is_rejected(
        self, monkeypatch, patched_env, sessionmaker,
    ):
        """编排器不做权限判定，工具必须逐个校验 kb_ids——否则模型传一个他人的
        kb_id 就能读到别人的库。"""
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [
            kb_row("kb-a", "我的", USER_A),
            kb_row("kb-b", "他人的", USER_B),
        ])

        result = await call_search(kb_id="kb-a", kb_ids=["kb-b"])

        assert "无权访问" in result["error"]
        assert patched_env.calls == [], "不得对无权访问的库发起检索"

    async def test_readable_kb_ids_are_passed_through(
        self, monkeypatch, patched_env, sessionmaker,
    ):
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [
            kb_row("kb-a", "我的甲", USER_A),
            kb_row("kb-c", "我的乙", USER_A),
        ])

        result = await call_search(kb_id="kb-a", kb_ids=["kb-c"])
        request = patched_env.calls[0][1]

        assert request.kb_ids == ["kb-a", "kb-c"]
        assert result["total"] == 1


class TestQueryRewriteParams:
    """查询改写开关与多轮历史由模型传入工具（迭代 3 T3.4）。"""

    async def test_rewrite_flag_is_forwarded(self, monkeypatch, patched_env, sessionmaker):
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [kb_row("kb-a", "我的", USER_A)])

        await call_search(kb_id="kb-a", use_rewrite=True)

        assert patched_env.calls[0][1].use_rewrite is True

    async def test_unset_flag_stays_none_so_kb_config_applies(
        self, monkeypatch, patched_env, sessionmaker,
    ):
        """未显式传入时必须保持 None——传 False 会覆盖知识库配置。"""
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [kb_row("kb-a", "我的", USER_A)])

        await call_search(kb_id="kb-a")

        assert patched_env.calls[0][1].use_rewrite is None

    async def test_history_is_capped_and_cleaned(self, monkeypatch, patched_env, sessionmaker):
        """历史只留最近几条，且剔掉空白项——模型可能把整段对话塞进来。"""
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [kb_row("kb-a", "我的", USER_A)])

        await call_search(
            kb_id="kb-a", use_rewrite=True,
            history=["第一轮", "  ", "第二轮", "第三轮", "第四轮"],
        )

        assert patched_env.calls[0][1].history == ["第二轮", "第三轮", "第四轮"]

    async def test_empty_history_is_none(self, monkeypatch, patched_env, sessionmaker):
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [kb_row("kb-a", "我的", USER_A)])

        await call_search(kb_id="kb-a", history=[])

        assert patched_env.calls[0][1].history is None

    async def test_result_reports_rewrite_state(self, monkeypatch, patched_env, sessionmaker):
        """工具结果里要如实带出改写状态：模型据此决定是否再试一次。"""
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [kb_row("kb-a", "我的", USER_A)])

        async def searched(db, kb_id, request):
            return SearchResponse(
                query=request.query, mode=request.mode, total=0, results=[],
                no_relevant_result=True, rewrite_applied=True,
                rewrite_queries=["原问题", "消解后的问题"],
            )

        monkeypatch.setattr(patched_env, "search", searched)

        result = await call_search(kb_id="kb-a", use_rewrite=True)

        assert result["no_relevant_result"] is True
        assert result["rewrite_applied"] is True


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


class TestWidenedVisibility:
    """公共库与已接受分享对 Agent 可见；未授权/待接受仍必须被拒绝。"""

    async def test_public_kb_is_searchable(self, monkeypatch, patched_env, sessionmaker):
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [
            kb_row("kb-pub", "公共库", USER_B, visibility="public"),
        ])

        result = await call_search(kb_id="kb-pub")

        assert result["total"] == 1
        assert patched_env.calls[0][0] == "kb-pub"

    async def test_accepted_share_is_searchable(
        self, monkeypatch, patched_env, sessionmaker,
    ):
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [kb_row("kb-b", "他人知识库", USER_B)])
        await seed_shares(sessionmaker, [
            share_row("s1", "kb-b", USER_B, USER_A, SHARE_STATUS_ACCEPTED),
        ])

        result = await call_search(kb_id="kb-b")

        assert result["total"] == 1
        assert patched_env.calls[0][0] == "kb-b"

    async def test_pending_share_is_rejected(self, monkeypatch, patched_env, sessionmaker):
        """只收到邀请但未接受时不得检索。"""
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [kb_row("kb-b", "他人知识库", USER_B)])
        await seed_shares(sessionmaker, [
            share_row("s1", "kb-b", USER_B, USER_A, SHARE_STATUS_PENDING),
        ])

        result = await call_search(kb_id="kb-b")

        assert "无权访问" in result["error"]
        assert patched_env.calls == []

    async def test_share_to_other_user_does_not_leak(
        self, monkeypatch, patched_env, sessionmaker,
    ):
        """分享给 B 的库不能让 A 读到。"""
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [kb_row("kb-c", "他人知识库", "user-c")])
        await seed_shares(sessionmaker, [
            share_row("s1", "kb-c", "user-c", USER_B, SHARE_STATUS_ACCEPTED),
        ])

        result = await call_search(kb_id="kb-c")

        assert "无权访问" in result["error"]
        assert patched_env.calls == []

    async def test_list_includes_public_and_accepted_shares(
        self, monkeypatch, patched_env, sessionmaker,
    ):
        monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
        await seed(sessionmaker, [
            kb_row("kb-a", "我的", USER_A),
            kb_row("kb-pub", "公共库", USER_B, visibility="public"),
            kb_row("kb-b", "分享给我", USER_B),
            kb_row("kb-c", "别人的私有库", "user-c"),
        ])
        await seed_shares(sessionmaker, [
            share_row("s1", "kb-b", USER_B, USER_A, SHARE_STATUS_ACCEPTED),
        ])

        result = await kb_search_module._list_kb_async()

        assert sorted(kb["kb_id"] for kb in result["knowledge_bases"]) == [
            "kb-a", "kb-b", "kb-pub",
        ]
