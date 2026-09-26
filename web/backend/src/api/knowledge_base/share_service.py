"""知识库分享业务逻辑——邀请 / 接受 / 拒绝 / 撤销。

权限模型：分享只授予**只读**（查询、浏览、检索）。写操作一律由
``service._get_kb_or_404``（仅所有者）把关，本模块不参与写权限判定。
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from api.knowledge_base.schemas import (
    KBResponse,
    KBShareListResponse,
    KBShareResponse,
)
from api.knowledge_base.service import (
    _get_kb_or_404,
    _kb_to_response,
    _load_owner_names,
)
from core.notification_bus import NotificationBus, NotificationEvent
from db.models.knowledge_base import KnowledgeBase
from db.models.knowledge_base_share import (
    SHARE_STATUS_ACCEPTED,
    SHARE_STATUS_PENDING,
    SHARE_STATUS_REJECTED,
    SHARE_STATUS_REVOKED,
    KnowledgeBaseShare,
)
from db.models.personnel import Personnel
from db.models.user import Account

logger = logging.getLogger(__name__)

NOTIFICATION_TYPE = "kb_shared"


def _to_share_response(
    share: KnowledgeBaseShare, account: Account | None = None
) -> KBShareResponse:
    """ORM → 响应对象，附带被邀请人展示信息。"""
    return KBShareResponse(
        id=share.id,
        kb_id=share.kb_id,
        user_id=share.grantee_id,
        username=account.username if account else None,
        nickname=(account.nickname if account else "") or "",
        avatar=(account.avatar if account else "") or "",
        status=share.status,
        permission=share.permission,
        expires_at=share.expires_at,
        created_at=share.created_at,
        accepted_at=share.accepted_at,
    )


async def _load_accounts(db: AsyncSession, user_ids: list[str]) -> dict[str, Account]:
    """按用户 ID 批量加载账号。"""
    ids = [uid for uid in dict.fromkeys(user_ids) if uid]
    if not ids:
        return {}
    rows = (await db.execute(select(Account).where(Account.id.in_(ids)))).scalars().all()
    return {a.id: a for a in rows}


async def _shares_with_accounts(
    db: AsyncSession, shares: list[KnowledgeBaseShare]
) -> list[KBShareResponse]:
    """批量装配分享记录与账号信息。"""
    accounts = await _load_accounts(db, [s.grantee_id for s in shares])
    return [_to_share_response(s, accounts.get(s.grantee_id)) for s in shares]


async def invite_shares(
    db: AsyncSession, kb_id: str, owner_id: str, user_ids: list[str],
    *,
    permission: str = "read",
    expires_in: str = "never",
) -> KBShareListResponse:
    """邀请一批用户浏览知识库（仅所有者可发起）。

    已存在的记录（含此前被拒绝/撤销的）复活为 pending，避免唯一约束冲突。
    自己不能邀请自己。

    ``permission``（read|write）与 ``expires_in``（1d|7d|30d|never）是迭代 6 T6.3
    新增的：``write`` 只放开**内容操作**（上传/删文档/改切片），改配置、重建、分享、
    删库仍仅库主——那几项会改变所有人的检索语义。
    """
    from api.knowledge_base.share_link_service import EXPIRES_IN_DAYS

    kb = await _get_kb_or_404(db, kb_id, owner_id)

    if permission not in ("read", "write"):
        raise HTTPException(status_code=400, detail="权限只能是 read 或 write")
    if expires_in not in EXPIRES_IN_DAYS:
        raise HTTPException(
            status_code=400,
            detail=f"有效期只能是 {'/'.join(EXPIRES_IN_DAYS)} 之一",
        )
    days = EXPIRES_IN_DAYS[expires_in]
    expires_at = None if days is None else datetime.utcnow() + timedelta(days=days)

    targets = [uid for uid in dict.fromkeys(user_ids) if uid and uid != owner_id]
    if not targets:
        raise HTTPException(status_code=400, detail="请选择要分享的用户")

    # 只邀请真实存在的账号，避免脏数据产生永远无法接受的邀请
    accounts = await _load_accounts(db, targets)
    targets = [uid for uid in targets if uid in accounts]
    if not targets:
        raise HTTPException(status_code=400, detail="所选用户不存在")

    existing = {
        s.grantee_id: s
        for s in (
            await db.execute(
                select(KnowledgeBaseShare).where(
                    KnowledgeBaseShare.kb_id == kb_id,
                    KnowledgeBaseShare.grantee_id.in_(targets),
                )
            )
        ).scalars().all()
    }

    owner_names = await _load_owner_names(db, [owner_id])
    owner_label = owner_names.get(owner_id, owner_id)

    # 先落库再发通知：否则通知可能先于分享记录提交，被邀请人点进去看不到邀请
    notified: list[tuple[str, KnowledgeBaseShare]] = []
    for uid in targets:
        share = existing.get(uid)
        if share is None:
            share = KnowledgeBaseShare(
                kb_id=kb_id,
                owner_id=owner_id,
                grantee_id=uid,
                status=SHARE_STATUS_PENDING,
                permission=permission,
                expires_at=expires_at,
            )
            db.add(share)
        elif share.status != SHARE_STATUS_ACCEPTED:
            # 曾被拒绝或撤销的邀请复活为待接受；已接受的保持原状，避免重复打扰
            share.status = SHARE_STATUS_PENDING
            share.accepted_at = None
            share.permission = permission
            share.expires_at = expires_at
        else:
            continue
        await db.flush()
        notified.append((uid, share))

    await db.commit()

    for uid, share in notified:
        await NotificationBus.publish(
            NotificationEvent(
                user_id=uid,
                type=NOTIFICATION_TYPE,
                level="info",
                title=f"{owner_label} 邀请你浏览知识库「{kb.name}」",
                content="在「知识库 → 共享给我的」中接受后即可查询浏览。",
                link="/knowledge-base",
                metadata={
                    "kb_id": kb_id,
                    "kb_name": kb.name,
                    "share_id": share.id,
                    "owner_id": owner_id,
                    "owner_name": owner_label,
                },
            )
        )
        logger.info("Shared kb=%s with user=%s", kb_id, uid)

    shares = (
        await db.execute(
            select(KnowledgeBaseShare)
            .where(
                KnowledgeBaseShare.kb_id == kb_id,
                KnowledgeBaseShare.grantee_id.in_(targets),
            )
            .order_by(KnowledgeBaseShare.created_at.desc())
        )
    ).scalars().all()

    items = await _shares_with_accounts(db, list(shares))
    return KBShareListResponse(items=items, total=len(items))


async def list_shares(db: AsyncSession, kb_id: str, owner_id: str) -> KBShareListResponse:
    """列出某知识库的全部分享记录（仅所有者）。"""
    await _get_kb_or_404(db, kb_id, owner_id)

    shares = (
        await db.execute(
            select(KnowledgeBaseShare)
            .where(KnowledgeBaseShare.kb_id == kb_id)
            .order_by(KnowledgeBaseShare.created_at.desc())
        )
    ).scalars().all()

    items = await _shares_with_accounts(db, list(shares))
    return KBShareListResponse(items=items, total=len(items))


async def delete_share(db: AsyncSession, kb_id: str, share_id: str, owner_id: str) -> None:
    """删除单条分享记录（仅所有者）——「单独删除某一个分享的用户」。"""
    await _get_kb_or_404(db, kb_id, owner_id)

    share = (
        await db.execute(
            select(KnowledgeBaseShare).where(
                KnowledgeBaseShare.id == share_id,
                KnowledgeBaseShare.kb_id == kb_id,
            )
        )
    ).scalar_one_or_none()
    if share is None:
        raise HTTPException(status_code=404, detail="分享记录不存在")

    await db.delete(share)


async def cancel_shares(db: AsyncSession, kb_id: str, owner_id: str) -> int:
    """取消该知识库的全部分享（仅所有者），库回到仅自己可见。

    返回被撤销的记录数。
    """
    await _get_kb_or_404(db, kb_id, owner_id)

    shares = (
        await db.execute(
            select(KnowledgeBaseShare).where(
                KnowledgeBaseShare.kb_id == kb_id,
                KnowledgeBaseShare.status != SHARE_STATUS_REVOKED,
            )
        )
    ).scalars().all()

    for share in shares:
        share.status = SHARE_STATUS_REVOKED
        share.updated_at = datetime.utcnow()
    await db.flush()
    return len(shares)


async def respond_share(
    db: AsyncSession, share_id: str, user_id: str, accept: bool
) -> KBShareResponse:
    """被邀请人接受 / 拒绝邀请。"""
    share = (
        await db.execute(
            select(KnowledgeBaseShare).where(KnowledgeBaseShare.id == share_id)
        )
    ).scalar_one_or_none()
    if share is None or share.grantee_id != user_id:
        raise HTTPException(status_code=404, detail="邀请不存在")

    if share.status != SHARE_STATUS_PENDING:
        raise HTTPException(status_code=409, detail="该邀请已被处理")

    share.status = SHARE_STATUS_ACCEPTED if accept else SHARE_STATUS_REJECTED
    share.accepted_at = datetime.utcnow() if accept else None
    share.updated_at = datetime.utcnow()
    await db.flush()

    accounts = await _load_accounts(db, [share.grantee_id])
    return _to_share_response(share, accounts.get(share.grantee_id))


async def list_invitations(db: AsyncSession, user_id: str) -> KBShareListResponse:
    """列出「共享给我的」——已接受的分享 + 待处理的邀请。

    待处理项用于左栏角标与接受/拒绝入口；已接受项即被分享的可见知识库。
    """
    shares = list(
        (
            await db.execute(
                select(KnowledgeBaseShare)
                .where(
                    KnowledgeBaseShare.grantee_id == user_id,
                    KnowledgeBaseShare.status.in_(
                        [SHARE_STATUS_ACCEPTED, SHARE_STATUS_PENDING]
                    ),
                )
                .order_by(KnowledgeBaseShare.created_at.desc())
            )
        ).scalars().all()
    )

    # 补上知识库名称：接收方可能还没有读取该库的权限，不能靠列表兜底
    kb_names: dict[str, str] = {}
    kb_ids = [s.kb_id for s in shares]
    if kb_ids:
        rows = (
            await db.execute(
                select(KnowledgeBase.id, KnowledgeBase.name).where(
                    KnowledgeBase.id.in_(kb_ids)
                )
            )
        ).all()
        kb_names = {kb_id: name for kb_id, name in rows}

    items = []
    for share in shares:
        item = _to_share_response(share)
        item.kb_name = kb_names.get(share.kb_id)
        items.append(item)

    return KBShareListResponse(items=items, total=len(items))


async def list_shares_by_owner(db: AsyncSession, owner_id: str) -> KBShareListResponse:
    """列出「我分享出去的」全部记录（跨知识库，不含已撤销）。

    左栏「我的共享知识」需要一次性拿到我所有库上的分享关系，避免前端按库逐个
    请求（N+1）。
    """
    shares = (
        await db.execute(
            select(KnowledgeBaseShare)
            .where(
                KnowledgeBaseShare.owner_id == owner_id,
                KnowledgeBaseShare.status != SHARE_STATUS_REVOKED,
            )
            .order_by(KnowledgeBaseShare.created_at.desc())
        )
    ).scalars().all()

    return KBShareListResponse(
        items=await _shares_with_accounts(db, list(shares)),
        total=len(shares),
    )


async def search_share_candidates(
    db: AsyncSession, user_id: str, search: str, limit: int = 20
) -> list[KBShareResponse]:
    """搜索可分享的用户（邀请弹窗用）。

    只返回展示所需的最小字段（ID/用户名/昵称/头像），**不返回**邮箱、手机号、
    锁定状态等管理端信息——因此不能用管理端的 ``/api/accounts`` 接口代替。
    结果中排除发起人自己。
    """
    conditions = [Account.id != user_id]

    # 只允许邀请**同部门（含子部门）**的人：跨部门分享等于绕过数据范围把库给出去
    # （公开库的可见范围已按部门收敛，分享是另一条通道，必须同样收口）。
    # 用户没有部门归属时不额外限制——此时没有"同部门"可言，保持可分享。
    from api.rbac.data_scope import dept_subtree, resolve_user_dept

    own_dept = await resolve_user_dept(db, user_id)
    if own_dept:
        dept_ids = await dept_subtree(db, own_dept)
        conditions.append(
            Account.id.in_(
                select(Personnel.account_id).where(
                    Personnel.dept_id.in_(dept_ids),
                    Personnel.account_id.is_not(None),
                )
            )
        )

    keyword = search.strip()
    if keyword:
        like = f"%{keyword}%"
        conditions.append(
            or_(
                Account.username.ilike(like),
                Account.nickname.ilike(like),
            )
        )

    rows = (
        await db.execute(
            select(Account).where(*conditions).order_by(Account.username).limit(limit)
        )
    ).scalars().all()

    return [
        KBShareResponse(
            id=a.id,          # 候选场景下 id 即用户 id
            kb_id="",
            user_id=a.id,
            username=a.username,
            nickname=a.nickname or a.username or a.id,
            avatar=a.avatar or "",
            status="",
            permission="read",
            created_at=datetime.utcnow(),
            accepted_at=None,
        )
        for a in rows
    ]


async def set_visibility(
    db: AsyncSession, kb_id: str, owner_id: str, visibility: str
) -> KBResponse:
    """发布 / 取消发布公共知识库（仅所有者）。"""
    kb = await _get_kb_or_404(db, kb_id, owner_id)
    kb.visibility = visibility
    kb.updated_at = datetime.utcnow()
    await db.flush()

    owner_names = await _load_owner_names(db, [kb.user_id])
    return _kb_to_response(
        kb, viewer_id=owner_id, owner_name=owner_names.get(kb.user_id)
    )
