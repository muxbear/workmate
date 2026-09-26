"""知识库的部门隔离（迭代 5 T5.2）。

此前 `public` = **全站可见**，与部门无关：任何人对任何人的公开库都能读。平台早在
「权限管理 → 数据权限」里给 `knowledge` 配了范围（all / dept_and_children / dept /
self / custom / none），知识库却从未读过它。

现在的语义（按"**只收紧、不放宽**"定稿）：

- 公开库的可见范围收敛为**数据范围内**——部门、部门子树或 all；
- 别人的**私有库**仍然只对本人与被分享人可见：数据范围**不构成**读私有库的理由
  （这条最关键，它决定了上线不会让任何人多看到东西）；
- 部门缺失（创建者无人员档案）的库不因"公开"而对他人可见；
- 列表与"按 id 直接打开"必须用同一条判定——藏起来但仍能直接访问不算隔离。
"""

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from api.knowledge_base.service import (
    KBAccess,
    _readable_condition,
    list_kbs,
    resolve_kb_access,
)
from api.rbac.data_scope import dept_subtree, resolve_dept_scope
from db.models.data_scope import DataScope
from db.models.department import Department
from db.models.knowledge_base import KnowledgeBase
from db.models.knowledge_base_grant import KnowledgeBaseGrant
from db.models.knowledge_base_share import KnowledgeBaseShare
from db.models.personnel import Personnel
from db.models.role import Role
from db.models.user import Account
from db.models.user_role import UserRole

pytestmark = pytest.mark.anyio

# 组织：集团 → 北京公司 → {研发部, 市场部}
GROUP = "dept-group"
BEIJING = "dept-bj"
RD = "dept-rd"
MARKET = "dept-market"

ALICE = "user-alice"    # 研发部
BOB = "user-bob"        # 市场部
CAROL = "user-carol"    # 北京公司（未细分）


@pytest.fixture
async def db():
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        for table in (
            KnowledgeBase, KnowledgeBaseShare, KnowledgeBaseGrant,
            Account, Role, UserRole, DataScope, Personnel, Department,
        ):
            await conn.run_sync(table.__table__.create)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as session:
        yield session
    await engine.dispose()


async def seed_org(db) -> None:
    """部门树 + 人员归属。"""
    db.add_all([
        Department(id=GROUP, code="group", name="集团", parent_id=None),
        Department(id=BEIJING, code="bj", name="北京公司", parent_id=GROUP),
        Department(id=RD, code="rd", name="研发部", parent_id=BEIJING),
        Department(id=MARKET, code="mk", name="市场部", parent_id=BEIJING),
        Personnel(id="p-alice", account_id=ALICE, name="Alice", employee_id="E1", dept_id=RD),
        Personnel(id="p-bob", account_id=BOB, name="Bob", employee_id="E2", dept_id=MARKET),
        Personnel(id="p-carol", account_id=CAROL, name="Carol", employee_id="E3", dept_id=BEIJING),
    ])
    await db.commit()


async def grant(db, user_id: str, scope: str) -> None:
    """给用户配角色与该角色的 knowledge 数据范围。"""
    role = Role(id=f"role-{user_id}", key="member", name="member", is_active=True)
    db.add(role)
    db.add(UserRole(user_id=user_id, role_id=role.id))
    db.add(DataScope(
        role_id=role.id, resource_key="knowledge", scope=scope,
        custom_dept_ids="[]",
    ))
    await db.commit()


async def seed_kb(
    db, kb_id: str, name: str, owner: str, *, visibility: str = "private",
    dept_id: str | None = None,
) -> None:
    db.add(KnowledgeBase(
        id=kb_id, name=name, description="", user_id=owner, status="ready",
        config={}, tags=[], docs_count=1, visibility=visibility, dept_id=dept_id,
    ))
    await db.commit()


async def readable_ids(db, user_id: str) -> set[str]:
    from sqlalchemy import select

    rows = (await db.execute(
        select(KnowledgeBase.id).where(await _readable_condition(db, user_id))
    )).all()
    return {row[0] for row in rows}


# ─── 数据范围解析 ────────────────────────────────────────────────────────────


class TestResolveDeptScope:
    async def test_all_means_no_dept_restriction(self, db):
        await seed_org(db)
        await grant(db, ALICE, "all")

        assert await resolve_dept_scope(db, ALICE, "knowledge") is None

    async def test_dept_is_own_department_only(self, db):
        await seed_org(db)
        await grant(db, ALICE, "dept")

        assert await resolve_dept_scope(db, ALICE, "knowledge") == {RD}

    async def test_dept_and_children_expands_subtree(self, db):
        await seed_org(db)
        await grant(db, CAROL, "dept_and_children")  # 北京公司

        scope = await resolve_dept_scope(db, CAROL, "knowledge")

        assert scope == {BEIJING, RD, MARKET}
        assert GROUP not in scope, "父节点不在子树内"

    async def test_self_and_none_yield_empty_scope(self, db):
        await seed_org(db)
        await grant(db, ALICE, "self")

        assert await resolve_dept_scope(db, ALICE, "knowledge") == set()

    async def test_unconfigured_resource_falls_closed(self, db):
        """未给该资源配置范围时按 none 处理（配了才算数）。"""
        await seed_org(db)
        role = Role(id="r1", key="member", name="member", is_active=True)
        db.add(role)
        db.add(UserRole(user_id=ALICE, role_id=role.id))
        await db.commit()

        assert await resolve_dept_scope(db, ALICE, "knowledge") == set()

    async def test_user_without_department_is_not_waved_through(self, db):
        await seed_org(db)
        await grant(db, "user-nobody", "dept_and_children")

        assert await resolve_dept_scope(db, "user-nobody", "knowledge") == set()

    async def test_user_without_role_is_not_waved_through(self, db):
        await seed_org(db)

        assert await resolve_dept_scope(db, ALICE, "knowledge") == set()

    async def test_missing_rbac_tables_do_not_break_reads(self, db):
        """RBAC 表不可用时**失败关闭但不抛错**：读取不该因此 500。"""
        from sqlalchemy import text

        await db.execute(text("DROP TABLE data_scopes"))
        await db.commit()

        assert await resolve_dept_scope(db, ALICE, "knowledge") == set()

    async def test_dept_subtree_includes_root_itself(self, db):
        await seed_org(db)

        assert await dept_subtree(db, RD) == {RD}
        assert await dept_subtree(db, GROUP) == {GROUP, BEIJING, RD, MARKET}


# ─── 公开库的可见范围 ────────────────────────────────────────────────────────


class TestPublicKbScope:
    async def test_same_dept_public_kb_is_visible(self, db):
        await seed_org(db)
        await grant(db, ALICE, "dept")
        await seed_kb(db, "kb-rd", "研发公开库", BOB, visibility="public", dept_id=RD)

        assert await readable_ids(db, ALICE) == {"kb-rd"}

    async def test_other_dept_public_kb_is_hidden(self, db):
        """跨部门越权用例：市场部的公开库对研发部不可见。"""
        await seed_org(db)
        await grant(db, ALICE, "dept")
        await seed_kb(db, "kb-mk", "市场公开库", BOB, visibility="public", dept_id=MARKET)

        assert await readable_ids(db, ALICE) == set()

    async def test_other_dept_public_kb_is_hidden_by_direct_id(self, db):
        """藏起来但仍能按 id 直接打开等于没隔离——两条路径必须同一判定。"""
        await seed_org(db)
        await grant(db, ALICE, "dept")
        await seed_kb(db, "kb-mk", "市场公开库", BOB, visibility="public", dept_id=MARKET)

        _kb, access = await resolve_kb_access(db, "kb-mk", ALICE)

        assert access is KBAccess.NONE

    async def test_dept_and_children_sees_descendant_public_kb(self, db):
        await seed_org(db)
        await grant(db, CAROL, "dept_and_children")
        await seed_kb(db, "kb-rd", "研发公开库", ALICE, visibility="public", dept_id=RD)

        assert await readable_ids(db, CAROL) == {"kb-rd"}

    async def test_all_scope_sees_every_public_kb(self, db):
        await seed_org(db)
        await grant(db, ALICE, "all")
        await seed_kb(db, "kb-mk", "市场公开库", BOB, visibility="public", dept_id=MARKET)

        assert await readable_ids(db, ALICE) == {"kb-mk"}

    async def test_self_scope_sees_no_others_public_kb(self, db):
        await seed_org(db)
        await grant(db, ALICE, "self")
        await seed_kb(db, "kb-rd", "同事的公开库", BOB, visibility="public", dept_id=RD)

        assert await readable_ids(db, ALICE) == set()

    async def test_kb_without_department_is_not_publicly_visible(self, db):
        """创建者没有人员档案时库没有归属部门——不确定归属就不因"公开"放行。"""
        await seed_org(db)
        await grant(db, ALICE, "dept")
        await seed_kb(db, "kb-null", "无归属公开库", BOB, visibility="public", dept_id=None)

        assert await readable_ids(db, ALICE) == set()

    async def test_all_scope_still_sees_kb_without_department(self, db):
        """范围 all 时不按部门过滤，无归属的公开库照常可见（与接入前一致）。"""
        await seed_org(db)
        await grant(db, ALICE, "all")
        await seed_kb(db, "kb-null", "无归属公开库", BOB, visibility="public", dept_id=None)

        assert await readable_ids(db, ALICE) == {"kb-null"}


# ─── 只收紧不放宽：私有库不受影响 ────────────────────────────────────────────


class TestPrivateKbIsNeverWidened:
    async def test_colleague_private_kb_stays_invisible(self, db):
        """同部门同事的**私有库**仍然不可见——数据范围不是读私有库的理由。"""
        await seed_org(db)
        await grant(db, ALICE, "dept")           # 甚至给 all 也不该放开
        await seed_kb(db, "kb-bob", "同事私有库", BOB, visibility="private", dept_id=RD)

        assert await readable_ids(db, ALICE) == set()
        _kb, access = await resolve_kb_access(db, "kb-bob", ALICE)
        assert access is KBAccess.NONE

    async def test_all_scope_does_not_widen_private(self, db):
        await seed_org(db)
        await grant(db, ALICE, "all")
        await seed_kb(db, "kb-bob", "别人私有库", BOB, visibility="private", dept_id=RD)

        assert await readable_ids(db, ALICE) == set()

    async def test_own_kb_always_readable(self, db):
        await seed_org(db)
        await grant(db, ALICE, "none")
        await seed_kb(db, "kb-mine", "我的私有库", ALICE, visibility="private", dept_id=RD)

        assert await readable_ids(db, ALICE) == {"kb-mine"}

    async def test_shared_kb_still_readable_regardless_of_scope(self, db):
        """已接受的分享是显式授权，不受数据范围影响。"""
        await seed_org(db)
        await grant(db, ALICE, "none")
        await seed_kb(db, "kb-bob", "别人私有库", BOB, visibility="private", dept_id=MARKET)
        db.add(KnowledgeBaseShare(
            kb_id="kb-bob", owner_id=BOB, grantee_id=ALICE, status="accepted",
        ))
        await db.commit()

        assert await readable_ids(db, ALICE) == {"kb-bob"}


# ─── 列表页两条路径口径一致 ──────────────────────────────────────────────────


class TestListPathsAgree:
    async def test_public_tab_also_respects_scope(self, db):
        """「公共库」页签此前只按 visibility 过滤，是第二条漏出通道。"""
        await seed_org(db)
        await grant(db, ALICE, "dept")
        await seed_kb(db, "kb-rd", "研发公开库", BOB, visibility="public", dept_id=RD)
        await seed_kb(db, "kb-mk", "市场公开库", BOB, visibility="public", dept_id=MARKET)

        result = await list_kbs(db, ALICE, scope="public")

        assert [k.id for k in result.items] == ["kb-rd"]

    async def test_all_scope_list_matches_direct_access(self, db):
        await seed_org(db)
        await grant(db, ALICE, "dept")
        await seed_kb(db, "kb-rd", "研发公开库", BOB, visibility="public", dept_id=RD)
        await seed_kb(db, "kb-mk", "市场公开库", BOB, visibility="public", dept_id=MARKET)

        listed = {k.id for k in (await list_kbs(db, ALICE, scope="all")).items}

        assert listed == await readable_ids(db, ALICE) == {"kb-rd"}


# ─── 分享候选按部门收敛 ──────────────────────────────────────────────────────


class TestShareCandidatesAreScoped:
    """邀请候选此前是"全站任意用户"——跨部门分享等于绕过数据范围把库递出去。

    公开库的可见范围已按部门收敛，分享作为**另一条放行通道**必须同样收口，
    否则"发布受限、分享不受限"会成为现成的绕过路径。
    """

    async def _seed_accounts(self, db) -> None:
        db.add_all([
            Account(id=ALICE, username="alice", nickname="Alice"),
            Account(id=BOB, username="bob", nickname="Bob"),
            Account(id=CAROL, username="carol", nickname="Carol"),
        ])
        await db.commit()

    async def test_candidates_limited_to_own_dept_subtree(self, db):
        from api.knowledge_base.share_service import search_share_candidates

        await self._seed_accounts(db)
        await seed_org(db)                      # Alice 在研发部
        await grant(db, ALICE, "dept")
        # Bob 在市场部、Carol 在北京公司（Alice 的上级）——都不该出现在研发部用户的候选里

        candidates = await search_share_candidates(db, ALICE, "")

        assert [c.user_id for c in candidates] == []

    async def test_parent_dept_colleague_is_also_hidden(self, db):
        """同公司但不同部门的同事同样不可分享（只按自己部门+子部门）。"""
        from api.knowledge_base.share_service import search_share_candidates

        await self._seed_accounts(db)
        await seed_org(db)
        await grant(db, CAROL, "dept_and_children")   # 北京公司：往下含研发/市场

        candidates = await search_share_candidates(db, CAROL, "")

        assert sorted(c.user_id for c in candidates) == sorted([ALICE, BOB])

    async def test_user_without_department_keeps_full_candidate_list(self, db):
        """没有部门归属时不存在"同部门"可言，保持可分享（不额外收紧到无人可选）。"""
        from api.knowledge_base.share_service import search_share_candidates

        await self._seed_accounts(db)
        await seed_org(db)                     # 只建了人员，没有给任何人角色/部门关联

        candidates = await search_share_candidates(db, "user-unknown", "")

        assert {c.user_id for c in candidates} == {ALICE, BOB, CAROL}
