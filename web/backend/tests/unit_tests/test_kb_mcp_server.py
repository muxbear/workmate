"""云知识库检索 MCP 服务的身份解析、工具面与越权边界。

背景：MCP 服务既被 Web 版智能体在对话中调用（身份来自 LangGraph 运行时上下文），
也被外部 MCP 客户端以 HTTP 直连（身份只能来自 ``Authorization: Bearer <token>``）。
两条路都必须收敛到**同一个**用户身份，否则就会出现"网页里搜不到、MCP 里却搜得到"。

本文件的重点在**失败关闭**：取不到身份、或拿了他人的 kb_id，都必须拒绝而不是放行。
"""

import importlib
from types import SimpleNamespace

import pytest
from mcp.server.lowlevel.server import request_ctx
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool
from starlette.datastructures import Headers

from api.knowledge_base import facade
from core.security import create_token_pair
from db.models.data_scope import DataScope
from db.models.department import Department
from db.models.knowledge_base import KnowledgeBase
from db.models.knowledge_base_grant import KnowledgeBaseGrant
from db.models.knowledge_base_share import KnowledgeBaseShare
from db.models.personnel import Personnel
from db.models.role import Role
from db.models.user_role import UserRole
from mcp_servers import request_auth
from mcp_servers.kb_server import SERVER_NAME, mcp

# agent.tools.__init__ 会把同名函数导出到包命名空间，取模块必须走 importlib
kb_search_module = importlib.import_module("agent.tools.kb_search")

pytestmark = pytest.mark.anyio

USER_A = "user-a"
USER_B = "user-b"


# ─── 身份解析：MCP 请求头 → user_id ──────────────────────────────────────────


@pytest.fixture
def mcp_request():
    """把 MCP 请求上下文替换成携带指定请求头的假上下文。"""
    set_tokens: list[object] = []

    def _install(headers: dict[str, str] | None) -> None:
        request = None if headers is None else SimpleNamespace(headers=Headers(headers))
        set_tokens.append(request_ctx.set(SimpleNamespace(request=request)))

    yield _install

    for token in reversed(set_tokens):
        request_ctx.reset(token)  # type: ignore[arg-type]


def test_no_request_context_means_no_identity():
    """进程内内存传输（自托管服务）没有 HTTP 请求，不得凭空造出身份。"""
    assert request_auth.authorization_header() == ""
    assert request_auth.user_id_from_mcp_request() == ""


def test_missing_authorization_header_is_not_identity(mcp_request):
    """带请求头但没有 Authorization（如桌面端当前实现）→ 无身份。"""
    mcp_request({"accept": "application/json"})
    assert request_auth.user_id_from_mcp_request() == ""


@pytest.mark.parametrize(
    "header",
    [
        "",  # 空
        "Bearer",  # 缺 token
        "Bearer   ",  # 只有空白
        "Basic dXNlcjpwYXNz",  # 非 Bearer 方案
        "Bearer not-a-jwt",  # 非法 token
    ],
)
def test_malformed_authorization_is_not_identity(mcp_request, header):
    """畸形/非 Bearer 的凭据一律按匿名处理，由调用方拒绝。"""
    mcp_request({"authorization": header})
    assert request_auth.user_id_from_mcp_request() == ""


def test_valid_access_token_yields_user_id(mcp_request):
    """有效 access token 解析出 sub 作为用户身份。"""
    token = create_token_pair(USER_A).accessToken
    mcp_request({"authorization": f"Bearer {token}"})
    assert request_auth.user_id_from_mcp_request() == USER_A


def test_bearer_scheme_is_case_insensitive(mcp_request):
    """HTTP 方案名大小写不敏感（bearer / Bearer 都应接受）。"""
    token = create_token_pair(USER_A).accessToken
    mcp_request({"authorization": f"bearer {token}"})
    assert request_auth.user_id_from_mcp_request() == USER_A


def test_refresh_token_is_rejected_as_identity(mcp_request):
    """refresh token 不能当身份用——它不该出现在请求头里，且权限面更大。"""
    refresh = create_token_pair(USER_A).refreshToken
    mcp_request({"authorization": f"Bearer {refresh}"})
    assert request_auth.user_id_from_mcp_request() == ""


def test_token_signed_with_other_secret_is_rejected(mcp_request, monkeypatch):
    """签名不对的 token 必须被拒——否则任何人都能自造 sub 读他人知识库。"""
    import jwt as pyjwt

    forged = pyjwt.encode(
        {"sub": USER_B, "type": "access", "aud": "ke-hermes"},
        "attacker-secret",
        algorithm="HS256",
    )
    mcp_request({"authorization": f"Bearer {forged}"})
    assert request_auth.user_id_from_mcp_request() == ""


# ─── kb_search 的身份分层：运行时上下文优先，其次请求头 ─────────────────────


def test_runtime_context_wins_over_request_header(mcp_request, monkeypatch):
    """Agent 在对话中调用时用运行时身份，不被请求头带偏。"""
    mcp_request({"authorization": f"Bearer {create_token_pair(USER_B).accessToken}"})

    runtime = SimpleNamespace(context=SimpleNamespace(user_id=USER_A))
    monkeypatch.setattr("langgraph.runtime.get_runtime", lambda: runtime)

    assert kb_search_module._current_user_id() == USER_A


def test_falls_back_to_mcp_header_when_no_runtime_context(mcp_request, monkeypatch):
    """MCP 服务里没有 LangGraph 上下文，回退到请求头身份。"""
    mcp_request({"authorization": f"Bearer {create_token_pair(USER_B).accessToken}"})

    def _raise() -> None:
        raise RuntimeError("no runtime")

    monkeypatch.setattr("langgraph.runtime.get_runtime", _raise)

    assert kb_search_module._current_user_id() == USER_B


def test_no_identity_anywhere_returns_empty(mcp_request, monkeypatch):
    """两处都取不到身份时返回空串——调用方据此拒绝，绝不放行。"""
    mcp_request({"accept": "application/json"})

    def _raise() -> None:
        raise RuntimeError("no runtime")

    monkeypatch.setattr("langgraph.runtime.get_runtime", _raise)

    assert kb_search_module._current_user_id() == ""


# ─── 工具面 ──────────────────────────────────────────────────────────────────


async def test_server_exposes_expected_tools():
    """暴露的 4 个检索工具——广场卡片的 features 与之一一对应。"""
    names = {tool.name for tool in await mcp.list_tools()}
    assert names == {
        "list_knowledge_bases",
        "kb_search",
        "kb_get_chunk_context",
        "kb_graph_lookup",
    }


# ─── MCP 广场种子与挂载 ──────────────────────────────────────────────────────


def test_kb_card_is_seeded_in_square():
    """广场里能看得到这张卡片，且分类与功能描述齐备。"""
    from api.mcp.service import BUILTIN_MCP_TOOLS

    cards = [item for item in BUILTIN_MCP_TOOLS if item["name"] == SERVER_NAME]
    assert len(cards) == 1, f"广场应恰好有一张「{SERVER_NAME}」卡片"
    card = cards[0]
    assert card["category"] == "knowledge_base"
    assert card["official"] is True
    assert card["features"], "卡片必须列出可检索的能力，否则用户不知道它能做什么"


def test_seed_name_matches_registered_server_name():
    """注册名与种子卡片的 name 必须一致。

    ``mcp_loader._get_mcp_config`` 按 **名称** 匹配库内记录，两处不一致会让
    「已安装」的配置永远读不到——工具看似装上、实际用不了。
    """
    import importlib as _importlib

    _importlib.import_module("server")  # 导入即完成 register_local_mcp_server 注册

    from agent.tools.mcp_loader import _LOCAL_MCP_SERVERS

    assert SERVER_NAME in _LOCAL_MCP_SERVERS
    # 与广场卡片同名是这条链路的硬约束（上面的测试已断言卡片存在）
    from api.mcp.service import BUILTIN_MCP_TOOLS

    assert any(item["name"] == SERVER_NAME for item in BUILTIN_MCP_TOOLS)


def test_kb_card_paths_derive_public_urls(monkeypatch):
    """卡片的地址由配置基址推导，不写死回环地址。"""
    from agent.config import settings
    from api.mcp.service import BUILTIN_MCP_TOOLS, builtin_mcp_urls

    monkeypatch.setattr(
        settings, "MCP_PUBLIC_BASE_URL", "https://ai.example.com", raising=False
    )
    card = next(i for i in BUILTIN_MCP_TOOLS if i["name"] == SERVER_NAME)
    urls = builtin_mcp_urls(card)
    assert urls["sse_url"] == "https://ai.example.com/mcp/kb/sse"
    assert urls["streamable_http_url"] == "https://ai.example.com/mcp/kb-http/mcp"


async def test_seeder_inserts_kb_card_and_is_idempotent():
    """种子函数真能把卡片写进库，且重复调用不产生重复行（每次启动都会跑）。"""
    from sqlalchemy import func, select

    from api.mcp.service import seed_builtin_mcp_tools
    from db.models.mcp_tool import McpTool

    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        await conn.run_sync(McpTool.__table__.create)
    maker = async_sessionmaker(engine, expire_on_commit=False)

    try:
        for _ in range(2):  # 模拟两次启动
            async with maker() as db:
                await seed_builtin_mcp_tools(db)
                await db.commit()

        async with maker() as db:
            row = (
                await db.execute(select(McpTool).where(McpTool.name == SERVER_NAME))
            ).scalar_one_or_none()
            total = (
                await db.execute(
                    select(func.count()).select_from(McpTool).where(
                        McpTool.name == SERVER_NAME
                    )
                )
            ).scalar()

        assert total == 1, "重复启动不应插入重复卡片"
        assert row is not None
        assert row.category == "knowledge_base"
        assert row.streamable_http_url.endswith("/mcp/kb-http/mcp")
        assert row.sse_url.endswith("/mcp/kb/sse")
    finally:
        await engine.dispose()


def test_transport_security_keeps_loopback_only_when_unconfigured(monkeypatch):
    """未配置对外基址时白名单与从前一致（仅回环），不放宽任何主机。"""
    from agent.config import settings
    from mcp_servers.transport_security import transport_security_settings

    monkeypatch.setattr(settings, "MCP_PUBLIC_BASE_URL", "", raising=False)
    cfg = transport_security_settings()

    assert cfg.enable_dns_rebinding_protection is True
    # IPv6 字面量在 Host 头里带方括号，白名单按同一种写法登记
    assert set(cfg.allowed_hosts) == {
        "127.0.0.1", "127.0.0.1:*", "localhost", "localhost:*", "[::1]", "[::1]:*",
    }
    assert "ai.example.com" not in cfg.allowed_hosts


def test_transport_security_allows_configured_public_host(monkeypatch):
    """配了对外基址就把该主机名加入白名单。

    否则外部客户端带 ``Host: ai.example.com`` 会被传输层直接拒成
    ``400 Invalid Host header``——服务挂着、地址也对，就是连不上。
    """
    from agent.config import settings
    from mcp_servers.transport_security import transport_security_settings

    monkeypatch.setattr(
        settings, "MCP_PUBLIC_BASE_URL", "https://ai.example.com/", raising=False
    )
    cfg = transport_security_settings()

    # 裸主机（默认端口会省略端口号）与任意端口两种写法都要覆盖
    assert "ai.example.com" in cfg.allowed_hosts
    assert "ai.example.com:*" in cfg.allowed_hosts
    assert "127.0.0.1:*" in cfg.allowed_hosts


def test_all_builtin_mcp_servers_share_transport_security(monkeypatch):
    """4 个内置服务都用同一份传输层设置——漏掉一个就会在部署后单独连不上。"""
    from mcp_servers.image_gen_server import mcp as image_mcp
    from mcp_servers.video_gen_server import mcp as video_mcp
    from mcp_servers.web_search_server import mcp as search_mcp

    for server in (mcp, image_mcp, video_mcp, search_mcp):
        security = server.settings.transport_security
        assert security is not None, "未配置传输层安全设置"
        assert security.allowed_hosts, "白名单为空会导致任何 Host 都被拒"


def test_routes_are_mounted_and_do_not_shadow_each_other():
    """``/mcp/kb`` 与 ``/mcp/kb-http`` 都挂上了，且前缀不互相吃路径。

    ``/mcp/kb`` 若能匹配 ``/mcp/kb-http/...``，后者就永远收不到请求——与
    「分享路由被 ``{kb_id}`` 遮蔽」是同一类问题，故在挂载层就断言。
    """
    from starlette.routing import Mount

    from server import app

    mounts = {
        route.path: route
        for route in app.routes
        if isinstance(route, Mount) and route.path.startswith("/mcp/kb")
    }
    assert set(mounts) == {"/mcp/kb", "/mcp/kb-http"}

    # 用真实挂载的正则断言：Mount 匹配的是 "<prefix>/{path:path}"
    sse_regex = mounts["/mcp/kb"].path_regex
    assert sse_regex.match("/mcp/kb/sse"), "SSE 端点应落在 /mcp/kb 前缀下"
    assert not sse_regex.match("/mcp/kb-http/mcp"), (
        "/mcp/kb 不应吞掉 /mcp/kb-http 的请求"
    )
    assert mounts["/mcp/kb-http"].path_regex.match("/mcp/kb-http/mcp")


# ─── 越权边界：拿别人的 kb_id 必须被拒 ───────────────────────────────────────


class FakeVectorStore:
    """只实现读切片所需的两个方法。"""

    def __init__(self, chunks: dict[tuple[str, str], list[dict]] | None = None) -> None:
        self.chunks = chunks or {}

    async def get_chunks_by_doc_id(self, kb_id: str, doc_id: str) -> list[dict]:
        return self.chunks.get((kb_id, doc_id), [])


@pytest.fixture
async def sessionmaker():
    """内存 SQLite 会话工厂，替换 db.engine.async_session。"""
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        for model in (
            KnowledgeBase,
            KnowledgeBaseShare,
            KnowledgeBaseGrant,
            Role,
            UserRole,
            DataScope,
            Personnel,
            Department,
        ):
            await conn.run_sync(model.__table__.create)

    maker = async_sessionmaker(engine, expire_on_commit=False)
    yield maker
    await engine.dispose()


@pytest.fixture
def patched_env(monkeypatch, sessionmaker):
    """替换会话工厂与向量库引用。"""
    monkeypatch.setattr("db.engine.async_session", sessionmaker)
    facade.set_vector_store(FakeVectorStore())
    yield
    facade.set_vector_store(None)


async def seed_kb(sessionmaker, kb_id: str, user_id: str) -> None:
    async with sessionmaker() as session:
        session.add(
            KnowledgeBase(
                id=kb_id,
                name=f"{user_id} 的库",
                user_id=user_id,
                status="ready",
                description="",
                config={},
                tags=[],
                docs_count=1,
                visibility="private",
            )
        )
        await session.commit()


async def test_chunk_context_rejects_other_users_kb(
    patched_env, sessionmaker, monkeypatch
):
    """他人私有库的切片不可读——这是越权的直接入口。"""
    from mcp_servers.kb_server import kb_get_chunk_context

    monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
    await seed_kb(sessionmaker, "kb-b", USER_B)

    result = await kb_get_chunk_context(kb_id="kb-b", doc_id="d1", chunk_index=0)

    assert "error" in result
    assert result.get("chunks") in (None, [])


async def test_graph_lookup_rejects_other_users_kb(
    patched_env, sessionmaker, monkeypatch
):
    """图谱同样按可读性收敛——此前该接口只按 kb_id 查，等于全站可读。"""
    from mcp_servers.kb_server import kb_graph_lookup

    monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
    await seed_kb(sessionmaker, "kb-b", USER_B)

    result = await kb_graph_lookup(kb_id="kb-b")

    assert "error" in result


async def test_tools_refuse_without_identity(patched_env, monkeypatch):
    """没有任何身份时，全部工具失败关闭（返回提示而不是抛异常）。

    4 个工具共用同一套拒绝口径——否则外部客户端会拿到"缺少用户会话上下文"
    这种面向会话语境的文案，不知道该补什么凭据。
    """
    from mcp_servers.kb_server import (
        kb_get_chunk_context,
        kb_graph_lookup,
        kb_search,
        list_knowledge_bases,
    )

    monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: "")

    for result in (
        await list_knowledge_bases(),
        await kb_search(query="任意查询", kb_id="kb-a"),
        await kb_get_chunk_context(kb_id="kb-a", doc_id="d1", chunk_index=0),
        await kb_graph_lookup(kb_id="kb-a"),
    ):
        assert "error" in result, result
        assert "身份" in result["error"]


async def test_chunk_context_returns_window_for_own_kb(
    patched_env, sessionmaker, monkeypatch
):
    """自己的库：按 chunk_index 开窗返回上下文，命中片被标注。"""
    from mcp_servers.kb_server import kb_get_chunk_context

    monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
    await seed_kb(sessionmaker, "kb-a", USER_A)
    # 故意打乱顺序：向量库返回顺序不保证，工具内部必须自己排序
    facade.set_vector_store(
        FakeVectorStore(
            {
                ("kb-a", "d1"): [
                    {
                        "id": "c2",
                        "chunk_index": 2,
                        "chunk_text": "第三段",
                        "metadata_": {},
                    },
                    {
                        "id": "c0",
                        "chunk_index": 0,
                        "chunk_text": "第一段",
                        "metadata_": {},
                    },
                    {
                        "id": "c1",
                        "chunk_index": 1,
                        "chunk_text": "第二段",
                        "metadata_": {},
                    },
                ]
            }
        )
    )

    result = await kb_get_chunk_context(
        kb_id="kb-a",
        doc_id="d1",
        chunk_index=1,
        window=1,
    )

    assert [c["index"] for c in result["chunks"]] == [0, 1, 2]
    assert [c["is_hit"] for c in result["chunks"]] == [False, True, False]
    assert result["total_chunks"] == 3


async def test_chunk_context_reports_missing_chunk(
    patched_env, sessionmaker, monkeypatch
):
    """切片号不存在时给出可选值，而不是空结果让模型瞎猜。"""
    from mcp_servers.kb_server import kb_get_chunk_context

    monkeypatch.setattr(kb_search_module, "_current_user_id", lambda: USER_A)
    await seed_kb(sessionmaker, "kb-a", USER_A)
    facade.set_vector_store(
        FakeVectorStore(
            {
                ("kb-a", "d1"): [
                    {
                        "id": "c0",
                        "chunk_index": 0,
                        "chunk_text": "第一段",
                        "metadata_": {},
                    },
                ]
            }
        )
    )

    result = await kb_get_chunk_context(kb_id="kb-a", doc_id="d1", chunk_index=9)

    assert "error" in result
    assert result["available_chunk_indices"] == [0]
