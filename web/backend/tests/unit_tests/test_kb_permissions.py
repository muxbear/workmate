"""知识库写接口的权限门禁（迭代 5 T5.1）。

背景：平台早有 `knowledge:create/upload/delete/edit` 这些权限键，还有角色-权限矩阵的
管理界面，但**知识库的写接口一道校验都没有**——拿到 token 就能建库、传文档、删库，
权限管理页形同虚设。

这里锁两件事：

1. **结构**：所有知识库写接口都必须挂权限依赖。这类问题靠"逐个接口写一条用例"防不住
   （新增接口时没人会记得补），所以遍历真实路由表断言——漏挂就会被测出来；
2. **语义**：`check_user_permission` 的判定（超管放行、按活动角色取键、无角色即无权）。

豁免项各自都有理由（见 ``PERMISSION_EXEMPT``）：被邀请人的「接受/拒绝邀请」
（"我的收件箱"操作，按参与者身份鉴权，否则被分享人永远接受不了），以及 `search`
与 `download`（**用 POST 传请求体的只读操作**——JWT 在 Authorization 头里，
`<a href>` 带不上，只能 fetch；下载的权限在服务层的 ``require_kb_readable``）。

写这条结构性断言的价值在本次实施中立刻兑现了：它一次就点出了两个我手工清点时
漏掉的接口——`graph/re-extract`（真写操作，已补权限）与 `search`（读操作，已列豁免）。
"""

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from api.rbac.deps import check_user_permission
from db.models.permission_resource import PermissionResource
from db.models.role import Role
from db.models.role_permission import RolePermission
from db.models.user_role import UserRole

pytestmark = pytest.mark.anyio

KB_PREFIX = "/api/knowledge-bases"

#: 允许没有权限依赖的"写方法"接口，每条都要有明确理由：
#:
#: - ``shares/{id}/accept|reject``：被邀请人不是知识库的编辑者，这是"我的收件箱"
#:   操作，按参与者身份鉴权（否则被分享人永远接受不了分享）；
#: - ``search``：**用 POST 传请求体的只读操作**（检索），不需要写权限——
#:   能读哪些库由库的可见性与归属校验决定，与角色权限无关。
PERMISSION_EXEMPT = {
    f"{KB_PREFIX}/shares/{{share_id}}/accept",
    f"{KB_PREFIX}/shares/{{share_id}}/reject",
    f"{KB_PREFIX}/{{kb_id}}/search",
    # 下载原文同样是**用 POST 传请求体的只读操作**：JWT 在 Authorization 头里，
    # `<a href>` 带不上，只能 fetch + blob，于是需要 POST。权限不在这里声明，
    # 而是服务层的 require_kb_readable（读到正文的人就能下载原文）。
    f"{KB_PREFIX}/{{kb_id}}/documents/{{doc_id}}/download",
}

#: 关键接口的权限键（防止"随手改成一个更宽松的键"）
EXPECTED_KEYS = {
    ("POST", KB_PREFIX): "knowledge:create",
    ("PUT", f"{KB_PREFIX}/{{kb_id}}"): "knowledge:edit",
    ("POST", f"{KB_PREFIX}/{{kb_id}}/reindex"): "knowledge:edit",
    ("DELETE", f"{KB_PREFIX}/{{kb_id}}"): "knowledge:delete",
    ("POST", f"{KB_PREFIX}/{{kb_id}}/documents/upload"): "knowledge:upload",
}


def _flatten_routes(routes) -> list:
    """展开 FastAPI 0.141 的惰性路由包装（``_IncludedRouter``），与路由遮蔽测试同法。"""
    out: list = []
    for route in routes:
        if type(route).__name__ == "_IncludedRouter":
            out.extend(_flatten_routes(route.original_router.routes))
            continue
        if getattr(route, "path", None):
            out.append(route)
    return out


def _permission_keys(route) -> set[str]:
    """递归取出该路由声明里的权限键。"""
    def walk(dependant) -> set[str]:
        keys: set[str] = set()
        for sub in getattr(dependant, "dependencies", []):
            key = getattr(sub.call, "__permission_key__", None)
            if key:
                keys.add(key)
            keys |= walk(sub)
        return keys

    return walk(getattr(route, "dependant", None))


def _kb_write_routes() -> list:
    from server import app

    writes = {"POST", "PUT", "PATCH", "DELETE"}
    return [
        route for route in _flatten_routes(app.routes)
        if route.path.startswith(KB_PREFIX)
        and set(getattr(route, "methods", None) or []) & writes
    ]


class TestEveryWriteRouteIsGuarded:
    def test_write_routes_are_discovered(self):
        """先确认真的扫到了接口——否则下面的断言会在"零个接口"上空转通过。"""
        routes = _kb_write_routes()
        assert len(routes) >= 10, f"只扫到 {len(routes)} 个知识库写接口，路由表结构可能变了"

    def test_all_write_routes_declare_a_permission(self):
        unguarded = [
            f"{sorted(set(route.methods))[0]} {route.path}"
            for route in _kb_write_routes()
            if not _permission_keys(route) and route.path not in PERMISSION_EXEMPT
        ]
        assert not unguarded, f"以下写接口没有权限门禁：{unguarded}"

    def test_exempt_list_stays_minimal(self):
        """豁免名单要保持最小——多一个都意味着"能改数据却不用权限"。"""
        exempt = {
            route.path for route in _kb_write_routes()
            if not _permission_keys(route)
        }
        assert exempt == PERMISSION_EXEMPT, f"豁免名单发生变化：{exempt}"

    @pytest.mark.parametrize(("method", "path", "expected"), [
        (*key, value) for key, value in EXPECTED_KEYS.items()
    ])
    def test_key_mapping_is_stable(self, method, path, expected):
        route = next(
            (r for r in _kb_write_routes()
             if r.path == path and method in (r.methods or set())),
            None,
        )
        assert route is not None, f"未找到路由 {method} {path}"
        assert expected in _permission_keys(route)


@pytest.fixture
async def rbac_sessionmaker():
    """内存库：角色 / 权限键 / 用户-角色三张表。"""
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        await conn.run_sync(Role.__table__.create)
        await conn.run_sync(RolePermission.__table__.create)
        await conn.run_sync(PermissionResource.__table__.create)
        await conn.run_sync(UserRole.__table__.create)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    yield maker
    await engine.dispose()


async def seed_role(
    maker, *, role_id: str, key: str, perm_keys: list[str],
    user_id: str | None = None, is_active: bool = True,
) -> None:
    async with maker() as db:
        db.add(Role(id=role_id, key=key, name=key, is_active=is_active))
        for perm in perm_keys:
            db.add(RolePermission(role_id=role_id, perm_key=perm))
        if user_id:
            db.add(UserRole(user_id=user_id, role_id=role_id))
        await db.commit()


class TestCheckUserPermission:
    async def test_role_with_key_is_granted(self, rbac_sessionmaker):
        await seed_role(
            rbac_sessionmaker, role_id="r-member", key="member",
            perm_keys=["knowledge:base", "knowledge:upload"], user_id="u1",
        )

        async with rbac_sessionmaker() as db:
            assert await check_user_permission(db, "u1", "knowledge:upload") is True
            assert await check_user_permission(db, "u1", "knowledge:delete") is False

    async def test_super_admin_is_granted_everything(self, rbac_sessionmaker):
        """超管不逐条比对权限键：漏配一条就把超管挡在门外是更糟的失败模式。"""
        await seed_role(
            rbac_sessionmaker, role_id="r-super", key="super_admin",
            perm_keys=[], user_id="u2",
        )

        async with rbac_sessionmaker() as db:
            assert await check_user_permission(db, "u2", "knowledge:delete") is True

    async def test_user_without_any_role_is_denied(self, rbac_sessionmaker):
        async with rbac_sessionmaker() as db:
            assert await check_user_permission(db, "nobody", "knowledge:base") is False

    async def test_inactive_role_is_ignored(self, rbac_sessionmaker):
        await seed_role(
            rbac_sessionmaker, role_id="r-off", key="member",
            perm_keys=["knowledge:upload"], user_id="u3", is_active=False,
        )

        async with rbac_sessionmaker() as db:
            assert await check_user_permission(db, "u3", "knowledge:upload") is False

    async def test_explicit_role_key_selects_that_role(self, rbac_sessionmaker):
        """带 role_key 时按它判定（与前端切换活动角色后的行为一致）。"""
        await seed_role(
            rbac_sessionmaker, role_id="r-a", key="member",
            perm_keys=["knowledge:upload"], user_id="u4",
        )
        await seed_role(
            rbac_sessionmaker, role_id="r-b", key="guest",
            perm_keys=[], user_id="u4",
        )

        async with rbac_sessionmaker() as db:
            assert await check_user_permission(
                db, "u4", "knowledge:upload", role_key="member",
            ) is True
            assert await check_user_permission(
                db, "u4", "knowledge:upload", role_key="guest",
            ) is False

    async def test_stale_role_key_falls_back_to_default_role(self, rbac_sessionmaker):
        """Token 里的角色已被删除/停用时回退默认角色，而不是直接判定无权。"""
        await seed_role(
            rbac_sessionmaker, role_id="r-a", key="member",
            perm_keys=["knowledge:upload"], user_id="u5",
        )

        async with rbac_sessionmaker() as db:
            assert await check_user_permission(
                db, "u5", "knowledge:upload", role_key="已删除的角色",
            ) is True
