"""分享升级：有效期 / 可写级别 / 部门与角色授权 / 访问级别透传（迭代 6 T6.3·S3）。

四条不变式，每条都对应一个"实现容易写错、错了却很难发现"的点：

1. **过期必须在 SQL 条件里排除**——列表、统计、agent 工具三处共用 `_readable_condition`，
   靠服务层逐行过滤一定会漏（agent 那条尤其容易忘）；
2. **多来源取最强**：同一用户可能既是只读分享接收人、又落在一条可写授权里，
   "先命中先返回"会让他莫名其妙地只有只读；
3. **部门授权按祖先链展开**（`include_subtree`），且换部门后立即失效——这是"人走权限走"
   的正确语义，但表现为"库列表里少了几项"，很容易被当成 bug；
4. **角色授权按"持有的任一有效角色"匹配**，不随"当前活动角色"变化。
"""

from datetime import datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from api.knowledge_base.service import (
    KBAccess,
    list_kbs,
    resolve_kb_access,
)
from db.models.data_scope import DataScope
from db.models.department import Department
from db.models.knowledge_base import KnowledgeBase
from db.models.knowledge_base_document import KnowledgeBaseDocument
from db.models.knowledge_base_entity import KnowledgeBaseEntity
from db.models.knowledge_base_grant import (
    GRANT_TARGET_DEPT,
    GRANT_TARGET_ROLE,
    KnowledgeBaseGrant,
)
from db.models.knowledge_base_index_task import KnowledgeBaseIndexTask
from db.models.knowledge_base_relation import KnowledgeBaseRelation
from db.models.knowledge_base_share import (
    SHARE_STATUS_ACCEPTED,
    KnowledgeBaseShare,
)
from db.models.personnel import Personnel
from db.models.role import Role
from db.models.user import Account
from db.models.user_role import UserRole

pytestmark = pytest.mark.anyio

OWNER = "u-owner"
ALICE = "u-alice"     # 研发部
BOB = "u-bob"         # 市场部（研发的兄弟部门）
GROUP = "d-group"
BEIJING = "d-beijing"
RD = "d-rd"
MARKET = "d-market"


@pytest.fixture
async def db():
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        for model in (
            KnowledgeBase, KnowledgeBaseShare, KnowledgeBaseGrant,
            KnowledgeBaseDocument,   # 文档级写操作的用例需要它
            KnowledgeBaseEntity, KnowledgeBaseRelation, KnowledgeBaseIndexTask,
            Account, Role, UserRole, DataScope, Personnel, Department,
        ):
            await conn.run_sync(model.__table__.create)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as session:
        yield session
    await engine.dispose()


async def seed_org(db) -> None:
    """部门树：集团 → 北京 → 研发 / 市场。"""
    db.add_all([
        Department(id=GROUP, code="group", name="集团", parent_id=None),
        Department(id=BEIJING, code="bj", name="北京公司", parent_id=GROUP),
        Department(id=RD, code="rd", name="研发部", parent_id=BEIJING),
        Department(id=MARKET, code="mk", name="市场部", parent_id=BEIJING),
        Personnel(id="p-a", account_id=ALICE, name="Alice", employee_id="E1", dept_id=RD),
        Personnel(id="p-b", account_id=BOB, name="Bob", employee_id="E2", dept_id=MARKET),
    ])
    await db.commit()


async def seed_kb(db, kb_id: str = "kb-1", *, owner: str = OWNER) -> None:
    db.add(KnowledgeBase(
        id=kb_id, name=f"库-{kb_id}", user_id=owner, status="ready",
        description="", config={}, tags=[], visibility="private",
    ))
    await db.commit()


async def share_to(
    db, user_id: str, *, kb_id: str = "kb-1", permission: str = "read",
    expires_at: datetime | None = None, status: str = SHARE_STATUS_ACCEPTED,
) -> None:
    db.add(KnowledgeBaseShare(
        id=f"s-{user_id}-{kb_id}", kb_id=kb_id, owner_id=OWNER, grantee_id=user_id,
        status=status, permission=permission, expires_at=expires_at,
    ))
    await db.commit()


async def grant_to_dept(
    db, dept_id: str, *, kb_id: str = "kb-1", permission: str = "read",
    include_subtree: bool = True,
) -> None:
    db.add(KnowledgeBaseGrant(
        id=f"g-{dept_id}-{kb_id}", kb_id=kb_id, target_type=GRANT_TARGET_DEPT,
        target_id=dept_id, include_subtree=include_subtree,
        permission=permission, created_by=OWNER,
    ))
    await db.commit()


async def grant_to_role(db, role_key: str, *, kb_id: str = "kb-1", permission: str = "read") -> None:
    db.add(KnowledgeBaseGrant(
        id=f"g-role-{role_key}-{kb_id}", kb_id=kb_id, target_type=GRANT_TARGET_ROLE,
        target_id=role_key, permission=permission, created_by=OWNER,
    ))
    await db.commit()


async def give_role(db, user_id: str, role_key: str, *, is_active: bool = True) -> None:
    role_id = f"role-{role_key}-{user_id}"
    db.add(Role(id=role_id, key=role_key, name=role_key, is_active=is_active))
    db.add(UserRole(user_id=user_id, role_id=role_id))
    await db.commit()


class TestExpiry:
    async def test_expired_share_is_invisible_everywhere(self, db):
        """过期的分享在**四处同时**不可见：按 id 判定、列表（all / shared_with_me）。"""
        await seed_org(db)
        await seed_kb(db)
        await share_to(db, ALICE, expires_at=datetime.utcnow() - timedelta(minutes=1))

        _, access = await resolve_kb_access(db, "kb-1", ALICE)
        assert access is KBAccess.NONE

        for scope in ("all", "shared_with_me"):
            page = await list_kbs(db, ALICE, scope=scope)
            assert page.items == [], f"{scope} 里不该出现已过期的分享"

    async def test_null_expiry_means_forever(self, db):
        await seed_org(db)
        await seed_kb(db)
        await share_to(db, ALICE, expires_at=None)

        _, access = await resolve_kb_access(db, "kb-1", ALICE)
        assert access is KBAccess.GRANTEE

    async def test_expiry_boundary_is_now(self, db):
        """``expires_at == 此刻``视为已过期（> 才算有效）。"""
        await seed_org(db)
        await seed_kb(db)
        await share_to(db, ALICE, expires_at=datetime.utcnow())

        _, access = await resolve_kb_access(db, "kb-1", ALICE)
        assert access is KBAccess.NONE

    async def test_future_expiry_is_visible(self, db):
        await seed_org(db)
        await seed_kb(db)
        await share_to(db, ALICE, expires_at=datetime.utcnow() + timedelta(days=7))

        page = await list_kbs(db, ALICE, scope="all")
        assert [kb.id for kb in page.items] == ["kb-1"]


class TestWriteLevel:
    async def test_write_share_yields_write_access(self, db):
        await seed_org(db)
        await seed_kb(db)
        await share_to(db, ALICE, permission="write")

        _, access = await resolve_kb_access(db, "kb-1", ALICE)
        assert access is KBAccess.WRITE

    async def test_read_share_yields_grantee(self, db):
        await seed_org(db)
        await seed_kb(db)
        await share_to(db, ALICE, permission="read")

        _, access = await resolve_kb_access(db, "kb-1", ALICE)
        assert access is KBAccess.GRANTEE

    async def test_strongest_source_wins(self, db):
        """同一人既有只读分享、又落在可写授权里 → 取 WRITE，而不是"先命中的那个"。"""
        await seed_org(db)
        await seed_kb(db)
        await share_to(db, ALICE, permission="read")
        await grant_to_dept(db, RD, permission="write")

        _, access = await resolve_kb_access(db, "kb-1", ALICE)
        assert access is KBAccess.WRITE

    async def test_access_field_is_exposed_on_the_list(self, db):
        """列表要把级别透传出去，否则前端分不清"公共库只读"与"被授予可写"。"""
        await seed_org(db)
        await seed_kb(db)
        await share_to(db, ALICE, permission="write")

        page = await list_kbs(db, ALICE, scope="all")

        assert [kb.access for kb in page.items] == ["write"]

    async def test_own_kb_is_owner(self, db):
        await seed_org(db)
        await seed_kb(db)

        page = await list_kbs(db, OWNER)
        assert [kb.access for kb in page.items] == ["owner"]


class TestDeptGrant:
    async def test_dept_grant_covers_members_without_accepting(self, db):
        """部门授权**立即生效**，没有"接受"这一步。"""
        await seed_org(db)
        await seed_kb(db)
        await grant_to_dept(db, RD)

        _, access = await resolve_kb_access(db, "kb-1", ALICE)
        assert access is KBAccess.GRANTEE
        # 兄弟部门不覆盖
        _, bob_access = await resolve_kb_access(db, "kb-1", BOB)
        assert bob_access is KBAccess.NONE

    async def test_ancestor_grant_with_subtree_covers_children(self, db):
        """授给"北京公司"且含子树 → 研发/市场的人都能读。"""
        await seed_org(db)
        await seed_kb(db)
        await grant_to_dept(db, BEIJING, include_subtree=True)

        _, alice = await resolve_kb_access(db, "kb-1", ALICE)
        _, bob = await resolve_kb_access(db, "kb-1", BOB)
        assert alice is KBAccess.GRANTEE
        assert bob is KBAccess.GRANTEE

    async def test_ancestor_grant_without_subtree_excludes_children(self, db):
        """``include_subtree=False`` 时只覆盖该部门**直属**成员。"""
        await seed_org(db)
        await seed_kb(db)
        await grant_to_dept(db, BEIJING, include_subtree=False)

        _, alice = await resolve_kb_access(db, "kb-1", ALICE)
        assert alice is KBAccess.NONE, "研发部是北京的子部门，不该被覆盖"

    async def test_leaving_the_department_revokes_access(self, db):
        """人走权限走——按当前部门关系判定，不快照。"""
        await seed_org(db)
        await seed_kb(db)
        await grant_to_dept(db, RD)
        assert (await resolve_kb_access(db, "kb-1", ALICE))[1] is KBAccess.GRANTEE

        from sqlalchemy import select

        personnel = (await db.execute(
            select(Personnel).where(Personnel.account_id == ALICE)
        )).scalar_one()
        personnel.dept_id = MARKET
        await db.commit()

        assert (await resolve_kb_access(db, "kb-1", ALICE))[1] is KBAccess.NONE

    async def test_revoked_grant_is_ignored(self, db):
        await seed_org(db)
        await seed_kb(db)
        await grant_to_dept(db, RD)

        from sqlalchemy import select

        row = (await db.execute(select(KnowledgeBaseGrant))).scalar_one()
        row.revoked_at = datetime.utcnow()
        await db.commit()

        assert (await resolve_kb_access(db, "kb-1", ALICE))[1] is KBAccess.NONE


class TestRoleGrant:
    async def test_role_grant_matches_held_role(self, db):
        await seed_org(db)
        await seed_kb(db)
        await give_role(db, ALICE, "manager")
        await grant_to_role(db, "manager")

        _, access = await resolve_kb_access(db, "kb-1", ALICE)
        assert access is KBAccess.GRANTEE
        # 没这个角色的人不受影响
        assert (await resolve_kb_access(db, "kb-1", BOB))[1] is KBAccess.NONE

    async def test_inactive_role_does_not_match(self, db):
        await seed_org(db)
        await seed_kb(db)
        await give_role(db, ALICE, "manager", is_active=False)
        await grant_to_role(db, "manager")

        _, access = await resolve_kb_access(db, "kb-1", ALICE)
        assert access is KBAccess.NONE

    async def test_role_grant_does_not_depend_on_activity_role(self, db):
        """角色授权按"持有"匹配，不取决于今天把哪个角色设为活动。"""
        await seed_org(db)
        await seed_kb(db)
        await give_role(db, ALICE, "manager")
        await give_role(db, ALICE, "member")
        await grant_to_role(db, "manager")

        # 即使显式指定活动角色是 member，角色授权仍然生效
        _, access = await resolve_kb_access(db, "kb-1", ALICE, role_key="member")
        assert access is KBAccess.GRANTEE


class TestWritePaths:
    """可写的**边界**：内容操作放开，配置/重建/分享/删库仍仅库主。

    两侧都要断言，只测"能写"会把越权测没，只测"不能写"会把功能测没。
    """

    async def _seed_doc(self, db, doc_id: str = "doc-1", path: str = "/tmp/x.md") -> None:
        db.add(KnowledgeBaseDocument(
            id=doc_id, kb_id="kb-1", name="文档.md", type="md", size_bytes=1,
            status="indexed", storage_path=path,
        ))
        await db.commit()

    async def test_write_grantee_can_delete_documents(self, db):
        from api.knowledge_base.doc_service import delete_document
        from api.knowledge_base.service import require_kb_writable

        await seed_org(db)
        await seed_kb(db)
        await self._seed_doc(db)
        await share_to(db, ALICE, permission="write")

        # 内容类判定放行
        _, access = await require_kb_writable(db, "kb-1", ALICE)
        assert access is KBAccess.WRITE

        await delete_document(db, "kb-1", "doc-1", ALICE)
        await db.commit()

    async def test_read_grantee_cannot_write(self, db):
        from fastapi import HTTPException

        from api.knowledge_base.service import require_kb_writable

        await seed_org(db)
        await seed_kb(db)
        await share_to(db, ALICE, permission="read")

        with pytest.raises(HTTPException) as exc:
            await require_kb_writable(db, "kb-1", ALICE)

        assert exc.value.status_code == 404
        assert exc.value.detail == "知识库不存在", "要与'不存在'同文案，不泄漏存在性"

    async def test_write_grantee_cannot_change_config(self, db):
        """改配置会改变所有人的检索语义（向量空间/门槛），只由库主做。"""
        from fastapi import HTTPException

        from api.knowledge_base.schemas import KBUpdateRequest
        from api.knowledge_base.service import update_kb

        await seed_org(db)
        await seed_kb(db)
        await share_to(db, ALICE, permission="write")

        with pytest.raises(HTTPException) as exc:
            await update_kb(db, "kb-1", ALICE, KBUpdateRequest(name="改名"))

        assert exc.value.status_code == 404

    async def test_write_grantee_cannot_reshare(self, db):
        """能写内容不等于能把库再分享给别人。"""
        from fastapi import HTTPException

        from api.knowledge_base.share_service import invite_shares

        await seed_org(db)
        await seed_kb(db)
        await share_to(db, ALICE, permission="write")

        with pytest.raises(HTTPException) as exc:
            await invite_shares(db, "kb-1", ALICE, [BOB])

        assert exc.value.status_code == 404

    async def test_write_grantee_cannot_delete_the_kb(self, db):
        from fastapi import HTTPException

        from api.knowledge_base.service import delete_kb

        await seed_org(db)
        await seed_kb(db)
        await share_to(db, ALICE, permission="write")

        with pytest.raises(HTTPException) as exc:
            await delete_kb(db, "kb-1", ALICE)

        assert exc.value.status_code == 404

    async def test_dept_write_grant_allows_content_writes(self, db):
        from api.knowledge_base.service import require_kb_writable

        await seed_org(db)
        await seed_kb(db)
        await grant_to_dept(db, RD, permission="write")

        _, access = await require_kb_writable(db, "kb-1", ALICE)
        assert access is KBAccess.WRITE

    async def test_public_reader_cannot_write(self, db):
        from fastapi import HTTPException
        from sqlalchemy import select

        from api.knowledge_base.service import require_kb_writable

        await seed_org(db)
        await seed_kb(db, owner=OWNER)
        # 设为公开：读者能**读**，但公开不构成写权限
        kb = (await db.execute(
            select(KnowledgeBase).where(KnowledgeBase.id == "kb-1")
        )).scalar_one()
        kb.visibility = "public"
        kb.dept_id = RD
        await db.commit()

        with pytest.raises(HTTPException) as exc:
            await require_kb_writable(db, "kb-1", ALICE)

        assert exc.value.status_code == 404
