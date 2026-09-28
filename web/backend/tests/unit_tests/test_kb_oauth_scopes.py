"""知识库接口的 OAuth2 scope 门禁（结构断言）。

背景：平台早有 OAuth2 授权（授权码 + PKCE + 授权页逐项开关），知识库接口却只有
RBAC 与逐库可读判定——**客户端 token 带不带知识库 scope，没有任何接口校验**。
于是"用户在授权页关掉了知识库"这件事对客户端毫无约束：只要用户角色允许，
拿到 token 的客户端照样能读、能写。

与 ``test_kb_permissions`` 同样的理由，这里锁的是**结构**而不是逐个接口写用例：

1. 遍历真实路由表，断言每个知识库接口都挂了 scope 依赖（读 → knowledge:read，
   写 → knowledge:write）——新增接口时没人会记得补，漏挂必须被扫出来；
2. 匿名接口（公开分享预览、健康检查）必须**一个 scope 都不挂**：它们是唯一
   允许无凭据访问的知识库路径，误加门禁等于把公开分享页锁死。

判定口径见 ``api/deps.py:scope_missing``：客户端 token（带 client_id claim）受
scope 约束，第一方 Web token 与进程内调用不受（Web 登录本来就不走授权页）。
"""

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from api.deps import require_scope, require_scope_from_query, scope_missing
from core.security import create_token_pair

pytestmark = pytest.mark.anyio

USER_ID = "user-kb-scope"

SCOPE_READ = "knowledge:read"
SCOPE_WRITE = "knowledge:write"

#: 知识库相关路径：三个前缀都归本测试管（分组另起前缀是为了避免路由遮蔽）
KB_PREFIXES = ("/api/knowledge-bases", "/api/knowledge-base-groups", "/health/kb")

#: 允许完全没有 scope 门禁的知识库接口，每条都要有明确理由：
#:
#: - ``shares/links/{token}/preview``：公开链接分享的预览页，**按设计匿名可用**
#:   （权限来自链接 token 本身，见 share_api.py 的模块注释）；
#: - ``/health/kb``：部署探活，本来就不带凭据。
ANONYMOUS = {
    "/api/knowledge-bases/shares/links/{token}/preview",
    "/health/kb",
}

#: **用写方法承载的只读操作**：按操作性质归读 scope，而不是按 HTTP 方法。
#: 与 ``test_kb_permissions.PERMISSION_EXEMPT`` 是同一批接口、同一批理由
#: （JWT 只能在请求体/查询串里带，于是只读操作也得用 POST）。
READ_ONLY_WRITES = {
    "/api/knowledge-bases/{kb_id}/search",
    "/api/knowledge-bases/{kb_id}/documents/{doc_id}/download",
    "/api/knowledge-bases/shares/{share_id}/accept",
    "/api/knowledge-bases/shares/{share_id}/reject",
    "/api/knowledge-bases/shares/links/{token}/accept",
}

WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def _flatten_routes(routes) -> list:
    """展开 FastAPI 惰性路由包装（``_IncludedRouter``），与权限门禁测试同法。"""
    out: list = []
    for route in routes:
        if type(route).__name__ == "_IncludedRouter":
            out.extend(_flatten_routes(route.original_router.routes))
            continue
        if getattr(route, "path", None):
            out.append(route)
    return out


def _scope_keys(route) -> set[str]:
    """递归取出该路由声明里要求的 scope（``require_scope`` 打的标记）。"""

    def walk(dependant) -> set[str]:
        keys: set[str] = set()
        for sub in getattr(dependant, "dependencies", []):
            key = getattr(sub.call, "__scope_key__", None)
            if key:
                keys.add(key)
            keys |= walk(sub)
        return keys

    return walk(getattr(route, "dependant", None))


def _kb_routes() -> list:
    from server import app

    return [
        route for route in _flatten_routes(app.routes)
        if any(route.path.startswith(prefix) for prefix in KB_PREFIXES)
    ]


def _expected_scope(route) -> str | None:
    """该路由应有的 scope：匿名 → 无；写操作 → write；其余（含只读 POST）→ read."""
    if route.path in ANONYMOUS:
        return None
    is_write = bool(set(getattr(route, "methods", None) or []) & WRITE_METHODS)
    if is_write and route.path not in READ_ONLY_WRITES:
        return SCOPE_WRITE
    return SCOPE_READ


def _label(route) -> str:
    method = sorted(set(getattr(route, "methods", None) or []))[0] if route.methods else "?"
    return f"{method} {route.path}"


class TestEveryKbRouteIsScopeGuarded:
    def test_routes_are_discovered(self):
        """先确认真的扫到了接口——否则下面的断言会在"零个接口"上空转通过。"""
        routes = _kb_routes()
        assert len(routes) >= 50, f"只扫到 {len(routes)} 个知识库接口，路由表结构可能变了"

    def test_every_route_declares_the_expected_scope(self):
        wrong: list[str] = []
        for route in _kb_routes():
            expected = _expected_scope(route)
            found = _scope_keys(route)
            if expected is None:
                if found:
                    wrong.append(f"{_label(route)}：匿名接口不该要求 scope {sorted(found)}")
                continue
            if found != {expected}:
                wrong.append(f"{_label(route)}：期望 {expected}，实际 {sorted(found) or '未挂'}")
        assert not wrong, "以下知识库接口的 scope 门禁不符：\n" + "\n".join(wrong)

    def test_no_route_requires_both_scopes(self):
        """读写两项各自独立：一个接口只该属于一个方向（写权限不隐含读权限）。"""
        both = [
            _label(route) for route in _kb_routes()
            if _scope_keys(route) == {SCOPE_READ, SCOPE_WRITE}
        ]
        assert not both, f"以下接口同时要求读写两项 scope：{both}"

    @pytest.mark.parametrize("path", sorted(ANONYMOUS))
    def test_anonymous_routes_stay_open(self, path):
        """匿名接口必须不带任何门禁——误加 scope 会直接锁死公开分享预览页。"""
        route = next((r for r in _kb_routes() if r.path == path), None)
        assert route is not None, f"未找到匿名路由 {path}（路径或注册方式变了？）"
        assert _scope_keys(route) == set()

    @pytest.mark.parametrize("path", sorted(READ_ONLY_WRITES))
    def test_read_only_writes_take_read_scope(self, path):
        """POST 承载的只读操作归读 scope：用写权限拦住检索是错的。"""
        routes = [r for r in _kb_routes() if r.path == path]
        assert routes, f"未找到路由 {path}"
        for route in routes:
            assert _scope_keys(route) == {SCOPE_READ}, _label(route)

    def test_write_scope_is_actually_used(self):
        """反向守卫：若哪天没人要求写 scope，说明写接口的收口被整体拿掉了。"""
        writers = [r for r in _kb_routes() if _scope_keys(r) == {SCOPE_WRITE}]
        assert len(writers) >= 20, f"只有 {len(writers)} 个接口要求写 scope，写路径可能松了"


# ─── 门禁本身：客户端 token 缺 scope 一律 403 ─────────────────────────────────


def _request(headers: dict[str, str] | None = None, query: str = "") -> Request:
    """构造一个只带指定请求头/查询串的 Starlette 请求（不启动应用）。"""
    raw = [(key.lower().encode(), value.encode()) for key, value in (headers or {}).items()]
    return Request({"type": "http", "headers": raw, "query_string": query.encode()})


def _client_token(scope: str = "") -> str:
    return create_token_pair(USER_ID, {"client_id": "ke-work-desktop", "scope": scope}).accessToken


def _first_party_token() -> str:
    return create_token_pair(USER_ID, {"role": "user"}).accessToken


class TestScopeGate:
    """`require_scope` / `require_scope_from_query` 的放行口径。"""

    async def test_missing_authorization_is_401(self):
        with pytest.raises(HTTPException) as exc:
            await require_scope(SCOPE_READ)(_request())
        assert exc.value.status_code == 401

    async def test_first_party_token_passes(self):
        """Web 登录态不受 OAuth2 scope 约束——网页功能不因本次收口而回归。"""
        user_id = await require_scope(SCOPE_READ)(
            _request({"authorization": f"Bearer {_first_party_token()}"})
        )
        assert user_id == USER_ID

    async def test_client_token_with_scope_passes(self):
        user_id = await require_scope(SCOPE_READ)(
            _request({"authorization": f"Bearer {_client_token(SCOPE_READ)}"})
        )
        assert user_id == USER_ID

    async def test_client_token_without_scope_is_403(self):
        with pytest.raises(HTTPException) as exc:
            await require_scope(SCOPE_READ)(
                _request({"authorization": f"Bearer {_client_token('skill:read')}"})
            )
        assert exc.value.status_code == 403
        assert SCOPE_READ in str(exc.value.detail)

    async def test_write_scope_does_not_open_read(self):
        """两枚 scope 各自独立：只授予写权限时，读接口仍然拒绝。"""
        with pytest.raises(HTTPException) as exc:
            await require_scope(SCOPE_READ)(
                _request({"authorization": f"Bearer {_client_token(SCOPE_WRITE)}"})
            )
        assert exc.value.status_code == 403

    async def test_query_token_gate_matches_header_gate(self):
        """SSE 用查询参数传 token：判定必须与请求头版完全一致（同一份口径）。"""
        dep = require_scope_from_query(SCOPE_READ)

        with pytest.raises(HTTPException) as exc:
            await dep(_request(query=f"token={_client_token('skill:read')}"))
        assert exc.value.status_code == 403

        user_id = await dep(_request(query=f"token={_client_token(SCOPE_READ)}"))
        assert user_id == USER_ID

    async def test_query_token_gate_rejects_missing_and_invalid(self):
        dep = require_scope_from_query(SCOPE_READ)
        with pytest.raises(HTTPException) as missing:
            await dep(_request())
        assert missing.value.status_code == 401
        with pytest.raises(HTTPException) as invalid:
            await dep(_request(query="token=not-a-jwt"))
        assert invalid.value.status_code == 401

    def test_scope_missing_is_the_single_primitive(self):
        """REST 与 MCP 共用这一个判定原语——两处分叉就会出现"网页拒了、MCP 放行"。"""
        assert scope_missing({"sub": USER_ID}, SCOPE_READ) is False
        assert scope_missing({"sub": USER_ID, "client_id": "c", "scope": SCOPE_READ}, SCOPE_READ) is False
        assert scope_missing({"sub": USER_ID, "client_id": "c", "scope": "skill:read"}, SCOPE_READ) is True
