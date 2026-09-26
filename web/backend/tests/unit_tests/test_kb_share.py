"""知识库分享与访问权限的单元测试。

覆盖三块：
1. ``resolve_kb_access`` 的四种身份判定（owner / grantee / public / none）。
2. 分享生命周期：邀请 → 待接受 → 接受 / 拒绝 → 出现在「共享给我的」。
3. 分享管理：删除单个被分享用户、取消全部分享、重复邀请不产生重复记录。
"""

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from api.knowledge_base import share_service
from api.knowledge_base.service import (
    KBAccess,
    _get_kb_or_404,
    list_kbs,
    resolve_kb_access,
)
from db.models.knowledge_base import KnowledgeBase
from db.models.knowledge_base_grant import KnowledgeBaseGrant
from db.models.knowledge_base_share import (
    SHARE_STATUS_ACCEPTED,
    SHARE_STATUS_PENDING,
    SHARE_STATUS_REJECTED,
    SHARE_STATUS_REVOKED,
    KnowledgeBaseShare,
)
from db.models.data_scope import DataScope
from db.models.department import Department
from db.models.personnel import Personnel
from db.models.role import Role
from db.models.user import Account
from db.models.user_role import UserRole

pytestmark = pytest.mark.anyio

OWNER = "user-owner"
OTHER = "user-other"
ALICE = "user-alice"
BOB = "user-bob"


@pytest.fixture
async def sessionmaker():
    """内存 SQLite 会话工厂。"""
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        await conn.run_sync(KnowledgeBase.__table__.create)
        await conn.run_sync(KnowledgeBaseShare.__table__.create)
        # 部门/角色授权（迭代 6 T6.3）：访问判定会查它
        await conn.run_sync(KnowledgeBaseGrant.__table__.create)
        await conn.run_sync(Account.__table__.create)
        # 数据范围（T5.2）：公开库的可见性由「角色 × knowledge 数据范围」决定，
        # 因此这些表是公开库判定的必要上下文，缺表会被当成"无可见部门"
        await conn.run_sync(Role.__table__.create)
        await conn.run_sync(UserRole.__table__.create)
        await conn.run_sync(DataScope.__table__.create)
        await conn.run_sync(Personnel.__table__.create)
        await conn.run_sync(Department.__table__.create)

    maker = async_sessionmaker(engine, expire_on_commit=False)
    yield maker
    await engine.dispose()


@pytest.fixture
def captured_notifications(monkeypatch) -> list:
    """拦截通知总线的发布（真实实现会去写业务库）。"""
    events: list = []

    async def fake_publish(event):
        events.append(event)

    monkeypatch.setattr(share_service.NotificationBus, "publish", fake_publish)
    return events


@pytest.fixture
async def db(sessionmaker):
    async with sessionmaker() as session:
        yield session


async def seed_user(sessionmaker, user_id: str, nickname: str) -> None:
    async with sessionmaker() as session:
        session.add(Account(
            id=user_id, username=user_id, nickname=nickname, password_hash="x",
        ))
        await session.commit()


async def seed_kb(
    sessionmaker, kb_id: str, name: str, owner_id: str, visibility: str = "private",
) -> None:
    async with sessionmaker() as session:
        session.add(KnowledgeBase(
            id=kb_id, name=name, description="", user_id=owner_id,
            status="ready", config={}, tags=[], docs_count=1,
            visibility=visibility,
        ))
        await session.commit()


async def seed_role_scope(
    sessionmaker, *, user_id: str, scope: str = "all",
    dept_ids: list[str] | None = None, role_key: str = "member",
) -> None:
    """给用户配一个角色与该角色的 knowledge 数据范围（公开库可见性的前提）。"""
    import json
    import uuid

    async with sessionmaker() as session:
        role = Role(id=f"role-{user_id}", key=role_key, name=role_key, is_active=True)
        session.add(role)
        session.add(UserRole(user_id=user_id, role_id=role.id))
        session.add(DataScope(
            role_id=role.id, resource_key="knowledge", scope=scope,
            custom_dept_ids=json.dumps(dept_ids or []),
        ))
        await session.commit()


# ─── 访问级别判定 ────────────────────────────────────────────────────────────


class TestResolveAccess:
    async def test_owner(self, sessionmaker, db):
        await seed_kb(sessionmaker, "kb1", "我的库", OWNER)
        kb, access = await resolve_kb_access(db, "kb1", OWNER)
        assert kb is not None
        assert access is KBAccess.OWNER

    async def test_accepted_grantee(self, sessionmaker, db):
        await seed_kb(sessionmaker, "kb1", "他人的库", OWNER)
        async with sessionmaker() as s:
            s.add(KnowledgeBaseShare(
                kb_id="kb1", owner_id=OWNER, grantee_id=ALICE,
                status=SHARE_STATUS_ACCEPTED,
            ))
            await s.commit()

        _, access = await resolve_kb_access(db, "kb1", ALICE)
        assert access is KBAccess.GRANTEE

    async def test_pending_share_is_not_grantee(self, sessionmaker, db):
        await seed_kb(sessionmaker, "kb1", "他人的库", OWNER)
        async with sessionmaker() as s:
            s.add(KnowledgeBaseShare(
                kb_id="kb1", owner_id=OWNER, grantee_id=ALICE,
                status=SHARE_STATUS_PENDING,
            ))
            await s.commit()

        _, access = await resolve_kb_access(db, "kb1", ALICE)
        assert access is KBAccess.NONE

    async def test_public_kb_is_readable_within_scope(self, sessionmaker, db):
        """公开库对**数据范围内**的人可读（T5.2 起不再等于"全站可见"）。

        这里给访问者配 `all` 范围，等价于接入数据范围之前的"全站可见"行为。
        """
        await seed_kb(sessionmaker, "kb1", "公共库", OWNER, visibility="public")
        await seed_role_scope(sessionmaker, user_id=OTHER, scope="all")

        _, access = await resolve_kb_access(db, "kb1", OTHER)
        assert access is KBAccess.PUBLIC

    async def test_public_kb_without_scope_is_denied(self, sessionmaker, db):
        """没有数据范围（未配角色/未配 knowledge 范围）时，公开不构成可见性。"""
        await seed_kb(sessionmaker, "kb1", "公共库", OWNER, visibility="public")

        _, access = await resolve_kb_access(db, "kb1", OTHER)
        assert access is KBAccess.NONE

    async def test_private_kb_denied(self, sessionmaker, db):
        await seed_kb(sessionmaker, "kb1", "私有库", OWNER)
        _, access = await resolve_kb_access(db, "kb1", OTHER)
        assert access is KBAccess.NONE

    async def test_missing_kb(self, db):
        kb, access = await resolve_kb_access(db, "nope", OWNER)
        assert kb is None
        assert access is KBAccess.NONE

    async def test_owner_takes_precedence_over_public(self, sessionmaker, db):
        """自己的公共库仍应判定为 OWNER（保留写权限）。"""
        await seed_kb(sessionmaker, "kb1", "我的公共库", OWNER, visibility="public")
        _, access = await resolve_kb_access(db, "kb1", OWNER)
        assert access is KBAccess.OWNER

    async def test_write_guard_rejects_grantee(self, sessionmaker, db):
        """写路径（_get_kb_or_404）对已接受分享的人仍应 404。"""
        await seed_kb(sessionmaker, "kb1", "他人的库", OWNER)
        async with sessionmaker() as s:
            s.add(KnowledgeBaseShare(
                kb_id="kb1", owner_id=OWNER, grantee_id=ALICE,
                status=SHARE_STATUS_ACCEPTED,
            ))
            await s.commit()

        with pytest.raises(HTTPException) as exc:
            await _get_kb_or_404(db, "kb1", ALICE)
        assert exc.value.status_code == 404

    async def test_write_guard_rejects_public_viewer(self, sessionmaker, db):
        await seed_kb(sessionmaker, "kb1", "公共库", OWNER, visibility="public")
        await seed_role_scope(sessionmaker, user_id=OTHER, scope="all")
        with pytest.raises(HTTPException) as exc:
            await _get_kb_or_404(db, "kb1", OTHER)
        assert exc.value.status_code == 404


# ─── 列表 scope ─────────────────────────────────────────────────────────────


class TestListScope:
    async def test_personal_scope_excludes_public_and_shared(self, sessionmaker, db):
        await seed_kb(sessionmaker, "kb-mine", "我的", OTHER)
        await seed_kb(sessionmaker, "kb-pub", "公共", OWNER, visibility="public")

        result = await list_kbs(db, OTHER, scope="personal")

        assert [k.id for k in result.items] == ["kb-mine"]

    async def test_public_scope_shows_only_public(self, sessionmaker, db):
        await seed_kb(sessionmaker, "kb-mine", "我的", OTHER)
        await seed_kb(sessionmaker, "kb-pub", "公共", OWNER, visibility="public")
        await seed_role_scope(sessionmaker, user_id=OTHER, scope="all")

        result = await list_kbs(db, OTHER, scope="public")

        assert [k.id for k in result.items] == ["kb-pub"]
        assert result.items[0].is_owner is False

    async def test_all_scope_shows_readable(self, sessionmaker, db):
        """概览口径：自己 + 公共 + 分享给我。"""
        await seed_kb(sessionmaker, "kb-mine", "我的", ALICE)
        await seed_kb(sessionmaker, "kb-pub", "公共", OWNER, visibility="public")
        await seed_kb(sessionmaker, "kb-shared", "分享给我", BOB)
        await seed_kb(sessionmaker, "kb-foreign", "别人的私有库", BOB)
        await seed_role_scope(sessionmaker, user_id=ALICE, scope="all")
        async with sessionmaker() as s:
            s.add(KnowledgeBaseShare(
                kb_id="kb-shared", owner_id=BOB, grantee_id=ALICE,
                status=SHARE_STATUS_ACCEPTED,
            ))
            await s.commit()

        result = await list_kbs(db, ALICE, scope="all")

        assert sorted(k.id for k in result.items) == ["kb-mine", "kb-pub", "kb-shared"]


# ─── 分享生命周期 ────────────────────────────────────────────────────────────


class TestShareLifecycle:
    async def test_invite_creates_pending_and_notifies(
        self, sessionmaker, db, captured_notifications,
    ):
        await seed_kb(sessionmaker, "kb1", "我的库", OWNER)
        await seed_user(sessionmaker, ALICE, "爱丽丝")

        result = await share_service.invite_shares(db, "kb1", OWNER, [ALICE])

        assert result.total == 1
        assert result.items[0].status == SHARE_STATUS_PENDING
        assert result.items[0].nickname == "爱丽丝"
        assert len(captured_notifications) == 1
        assert captured_notifications[0].type == "kb_shared"
        assert captured_notifications[0].user_id == ALICE

    async def test_invite_skips_owner(self, sessionmaker, db, captured_notifications):
        await seed_kb(sessionmaker, "kb1", "我的库", OWNER)
        await seed_user(sessionmaker, OWNER, "自己")

        with pytest.raises(HTTPException):
            await share_service.invite_shares(db, "kb1", OWNER, [OWNER])

    async def test_invite_unknown_user_rejected(self, sessionmaker, db, captured_notifications):
        await seed_kb(sessionmaker, "kb1", "我的库", OWNER)
        with pytest.raises(HTTPException) as exc:
            await share_service.invite_shares(db, "kb1", OWNER, ["ghost"])
        assert exc.value.status_code == 400

    async def test_reinvite_does_not_duplicate(
        self, sessionmaker, db, captured_notifications,
    ):
        await seed_kb(sessionmaker, "kb1", "我的库", OWNER)
        await seed_user(sessionmaker, ALICE, "爱丽丝")

        await share_service.invite_shares(db, "kb1", OWNER, [ALICE])
        result = await share_service.invite_shares(db, "kb1", OWNER, [ALICE])

        assert result.total == 1
        listed = await share_service.list_shares(db, "kb1", OWNER)
        assert listed.total == 1

    async def test_accept_then_visible_in_shared_with_me(
        self, sessionmaker, db, captured_notifications,
    ):
        await seed_kb(sessionmaker, "kb1", "我的库", OWNER)
        await seed_user(sessionmaker, ALICE, "爱丽丝")

        invited = await share_service.invite_shares(db, "kb1", OWNER, [ALICE])
        share_id = invited.items[0].id

        accepted = await share_service.respond_share(db, share_id, ALICE, accept=True)
        assert accepted.status == SHARE_STATUS_ACCEPTED
        assert accepted.accepted_at is not None

        visible = await list_kbs(db, ALICE, scope="shared_with_me")
        assert [k.id for k in visible.items] == ["kb1"]

    async def test_reject_keeps_kb_out_of_list(
        self, sessionmaker, db, captured_notifications,
    ):
        await seed_kb(sessionmaker, "kb1", "我的库", OWNER)
        await seed_user(sessionmaker, ALICE, "爱丽丝")

        invited = await share_service.invite_shares(db, "kb1", OWNER, [ALICE])
        rejected = await share_service.respond_share(
            db, invited.items[0].id, ALICE, accept=False,
        )
        assert rejected.status == SHARE_STATUS_REJECTED

        visible = await list_kbs(db, ALICE, scope="shared_with_me")
        assert visible.items == []

    async def test_only_grantee_can_respond(
        self, sessionmaker, db, captured_notifications,
    ):
        await seed_kb(sessionmaker, "kb1", "我的库", OWNER)
        await seed_user(sessionmaker, ALICE, "爱丽丝")
        await seed_user(sessionmaker, BOB, "鲍勃")

        invited = await share_service.invite_shares(db, "kb1", OWNER, [ALICE])

        with pytest.raises(HTTPException) as exc:
            await share_service.respond_share(db, invited.items[0].id, BOB, accept=True)
        assert exc.value.status_code == 404

    async def test_double_respond_conflicts(
        self, sessionmaker, db, captured_notifications,
    ):
        await seed_kb(sessionmaker, "kb1", "我的库", OWNER)
        await seed_user(sessionmaker, ALICE, "爱丽丝")

        invited = await share_service.invite_shares(db, "kb1", OWNER, [ALICE])
        await share_service.respond_share(db, invited.items[0].id, ALICE, accept=True)

        with pytest.raises(HTTPException) as exc:
            await share_service.respond_share(db, invited.items[0].id, ALICE, accept=True)
        assert exc.value.status_code == 409

    async def test_invitations_lists_pending_and_accepted(
        self, sessionmaker, db, captured_notifications,
    ):
        await seed_kb(sessionmaker, "kb1", "库一", OWNER)
        await seed_kb(sessionmaker, "kb2", "库二", OWNER)
        await seed_user(sessionmaker, ALICE, "爱丽丝")

        first = await share_service.invite_shares(db, "kb1", OWNER, [ALICE])
        await share_service.respond_share(db, first.items[0].id, ALICE, accept=True)
        await share_service.invite_shares(db, "kb2", OWNER, [ALICE])

        result = await share_service.list_invitations(db, ALICE)

        assert result.total == 2
        assert {i.status for i in result.items} == {
            SHARE_STATUS_ACCEPTED, SHARE_STATUS_PENDING,
        }


# ─── 分享管理 ────────────────────────────────────────────────────────────────


class TestShareManagement:
    async def test_owner_can_remove_single_grantee(
        self, sessionmaker, db, captured_notifications,
    ):
        await seed_kb(sessionmaker, "kb1", "我的库", OWNER)
        await seed_user(sessionmaker, ALICE, "爱丽丝")
        await seed_user(sessionmaker, BOB, "鲍勃")

        invited = await share_service.invite_shares(db, "kb1", OWNER, [ALICE, BOB])
        alice_share = next(i for i in invited.items if i.user_id == ALICE)

        await share_service.delete_share(db, "kb1", alice_share.id, OWNER)

        remaining = await share_service.list_shares(db, "kb1", OWNER)
        assert [i.user_id for i in remaining.items] == [BOB]
        # 被移除者立即不可见
        assert (await list_kbs(db, ALICE, scope="shared_with_me")).items == []

    async def test_cancel_all_revokes_every_grantee(
        self, sessionmaker, db, captured_notifications,
    ):
        await seed_kb(sessionmaker, "kb1", "我的库", OWNER)
        await seed_user(sessionmaker, ALICE, "爱丽丝")
        await seed_user(sessionmaker, BOB, "鲍勃")

        invited = await share_service.invite_shares(db, "kb1", OWNER, [ALICE, BOB])
        for item in invited.items:
            await share_service.respond_share(db, item.id, item.user_id, accept=True)

        revoked = await share_service.cancel_shares(db, "kb1", OWNER)
        assert revoked == 2

        listed = await share_service.list_shares(db, "kb1", OWNER)
        assert {i.status for i in listed.items} == {SHARE_STATUS_REVOKED}
        for grantee in (ALICE, BOB):
            assert (await list_kbs(db, grantee, scope="shared_with_me")).items == []

    async def test_reinvite_after_revoke_resets_to_pending(
        self, sessionmaker, db, captured_notifications,
    ):
        await seed_kb(sessionmaker, "kb1", "我的库", OWNER)
        await seed_user(sessionmaker, ALICE, "爱丽丝")

        invited = await share_service.invite_shares(db, "kb1", OWNER, [ALICE])
        await share_service.respond_share(db, invited.items[0].id, ALICE, accept=True)
        await share_service.cancel_shares(db, "kb1", OWNER)

        again = await share_service.invite_shares(db, "kb1", OWNER, [ALICE])
        assert again.items[0].status == SHARE_STATUS_PENDING
        assert (await list_kbs(db, ALICE, scope="shared_with_me")).items == []

    async def test_non_owner_cannot_manage_shares(
        self, sessionmaker, db, captured_notifications,
    ):
        await seed_kb(sessionmaker, "kb1", "我的库", OWNER)
        await seed_user(sessionmaker, ALICE, "爱丽丝")

        with pytest.raises(HTTPException) as exc:
            await share_service.list_shares(db, "kb1", ALICE)
        assert exc.value.status_code == 404


# ─── 公共库发布 ──────────────────────────────────────────────────────────────


class TestVisibility:
    async def test_publish_makes_kb_readable_by_others(
        self, sessionmaker, db, captured_notifications,
    ):
        await seed_kb(sessionmaker, "kb1", "我的库", OWNER)
        await seed_user(sessionmaker, OWNER, "所有者")

        result = await share_service.set_visibility(db, "kb1", OWNER, "public")
        assert result.visibility == "public"

        await seed_role_scope(sessionmaker, user_id=OTHER, scope="all")
        visible = await list_kbs(db, OTHER, scope="public")
        assert [k.id for k in visible.items] == ["kb1"]
        assert visible.items[0].owner_name == "所有者"

    async def test_unpublish_removes_from_public(
        self, sessionmaker, db, captured_notifications,
    ):
        await seed_kb(sessionmaker, "kb1", "我的库", OWNER, visibility="public")
        await seed_user(sessionmaker, OWNER, "所有者")

        await share_service.set_visibility(db, "kb1", OWNER, "private")

        assert (await list_kbs(db, OTHER, scope="public")).items == []

    async def test_non_owner_cannot_publish(
        self, sessionmaker, db, captured_notifications,
    ):
        await seed_kb(sessionmaker, "kb1", "我的库", OWNER)

        with pytest.raises(HTTPException) as exc:
            await share_service.set_visibility(db, "kb1", ALICE, "public")
        assert exc.value.status_code == 404
