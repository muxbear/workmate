"""知识库链接式分享（迭代 6 T6.3）。

与"用户到用户"的邀请（``share_service``）的区别是**凭持有即得**：拿到链接的人可以先
看一眼元信息（免登录），登录后点"接受"即获得访问权。接受时**落成一条普通的已接受
分享行**——于是列表、检索、agent 工具那些读路径**零改动**，它们仍然只认"已接受的分享"。

安全要点（每一条都有对应用例）：

- token 由 ``secrets.token_urlsafe(32)`` 生成，**只存 sha256 摘要**，明文只在创建
  响应里出现一次。数据库泄露时明文 token 等于把所有库直接交出去——桌面版的
  ``knowledge_shares`` 是明文列，**不学它**；
- **免登录预览只回元信息**（库名/描述/计数/权限/有效期），不含 kb_id、不含任何正文；
- "不存在 / 已撤销 / 已过期 / 库已软删"返回**完全一致**的 404——区分它们等于给出
  一个"这个 token 曾经有效"的预言机；
- **撤销链接不回收已接受的权限**：撤销关闭的是"再拉新人"的入口。要停掉某个具体的人，
  现成入口是「已分享用户」里的单条移除，语义更精确；级联回收还会让
  ``(kb_id, grantee_id)`` 那一行的来源变得不可判定。
"""

from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import datetime, timedelta
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.models.knowledge_base import KnowledgeBase
from db.models.knowledge_base_share import (
    SHARE_STATUS_ACCEPTED,
    KnowledgeBaseShare,
)
from db.models.knowledge_base_share_link import (
    SHARE_PERMISSION_READ,
    SHARE_PERMISSION_WRITE,
    KnowledgeBaseShareLink,
)

logger = logging.getLogger(__name__)

#: 有效期档位：用枚举而不是"任意小时数"，服务端才能硬编码上限（避免填 9999 天）
EXPIRES_IN_DAYS: dict[str, int | None] = {
    "1d": 1,
    "7d": 7,
    "30d": 30,
    "never": None,
}

#: 失效统一文案：四种情形（不存在/已撤销/已过期/库已删）共用，不做区分
INVALID_LINK_MESSAGE = "分享链接不存在或已失效"


def _hash_token(token: str) -> str:
    """token → sha256 hex（库里只存这个）。"""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _link_state(link: KnowledgeBaseShareLink, now: datetime) -> str:
    """链接状态（**后端算**：别让前端自己比时钟，两处时钟一定漂移）。"""
    if link.revoked_at is not None:
        return "revoked"
    if link.expires_at is not None and link.expires_at <= now:
        return "expired"
    return "active"


def _permission_rank(permission: str | None) -> int:
    return 1 if permission == SHARE_PERMISSION_WRITE else 0


async def create_share_link(
    db: AsyncSession,
    kb_id: str,
    user_id: str,
    *,
    permission: str = SHARE_PERMISSION_READ,
    expires_in: str = "never",
) -> dict[str, Any]:
    """创建一条链接分享。

    Returns:
        含**明文 token** 的响应——这是它唯一一次出现，之后无法再取回（丢了就重建）。
        **不返回绝对 URL**：后端不知道自己的公网 origin，由前端拼。
    """
    from api.knowledge_base.service import _get_kb_or_404

    kb = await _get_kb_or_404(db, kb_id, user_id)   # 仅库主可建链接
    if permission not in (SHARE_PERMISSION_READ, SHARE_PERMISSION_WRITE):
        raise HTTPException(status_code=400, detail="权限只能是 read 或 write")
    if expires_in not in EXPIRES_IN_DAYS:
        raise HTTPException(
            status_code=400,
            detail=f"有效期只能是 {'/'.join(EXPIRES_IN_DAYS)} 之一",
        )

    days = EXPIRES_IN_DAYS[expires_in]
    now = datetime.utcnow()
    token = secrets.token_urlsafe(32)
    link = KnowledgeBaseShareLink(
        kb_id=kb.id,
        created_by=user_id,
        token_hash=_hash_token(token),    # 只存摘要
        permission=permission,
        expires_at=None if days is None else now + timedelta(days=days),
        created_at=now,
    )
    db.add(link)
    await db.flush()

    return {
        "id": link.id,
        "token": token,               # 唯一一次
        "path": f"/share/kb/{token}",
        "permission": link.permission,
        "expires_at": link.expires_at,
        "created_at": link.created_at,
    }


async def list_share_links(
    db: AsyncSession, kb_id: str, user_id: str,
) -> list[dict[str, Any]]:
    """列出该库的链接（**不含 token 与摘要**）。"""
    from api.knowledge_base.service import _get_kb_or_404

    await _get_kb_or_404(db, kb_id, user_id)
    rows = (
        await db.execute(
            select(KnowledgeBaseShareLink)
            .where(KnowledgeBaseShareLink.kb_id == kb_id)
            .order_by(KnowledgeBaseShareLink.created_at.desc())
        )
    ).scalars().all()

    now = datetime.utcnow()
    return [
        {
            "id": link.id,
            "permission": link.permission,
            "expires_at": link.expires_at,
            "revoked_at": link.revoked_at,
            "accept_count": link.accept_count,
            "last_accepted_at": link.last_accepted_at,
            "created_at": link.created_at,
            # 状态由后端算：前端自己比时钟会因时区/漂移给出与判定不一致的显示
            "state": _link_state(link, now),
        }
        for link in rows
    ]


async def revoke_share_link(db: AsyncSession, kb_id: str, link_id: str, user_id: str) -> None:
    """撤销一条链接。

    **只关闭"再拉新人"的入口**：已经通过它接受的人**保留**访问权（要停掉具体某人，
    用「已分享用户」里的单条移除）。这一点与直觉相反，UI 的确认文案必须写明。
    """
    from api.knowledge_base.service import _get_kb_or_404

    await _get_kb_or_404(db, kb_id, user_id)
    link = (
        await db.execute(
            select(KnowledgeBaseShareLink).where(
                KnowledgeBaseShareLink.id == link_id,
                KnowledgeBaseShareLink.kb_id == kb_id,
            )
        )
    ).scalar_one_or_none()
    if link is None:
        raise HTTPException(status_code=404, detail="分享链接不存在")
    if link.revoked_at is None:
        link.revoked_at = datetime.utcnow()
        await db.flush()


async def _resolve_link(
    db: AsyncSession, token: str,
) -> KnowledgeBaseShareLink:
    """按 token 取**有效**链接，否则统一 404。

    四种失效情形（不存在 / 已撤销 / 已过期 / 库已软删除）走同一条出口——区分它们
    等于给出一个"这个 token 曾经有效"的预言机。库的软删除由全局过滤器兜住：
    库查不到时与"链接不存在"同码同文案。
    """
    digest = _hash_token(token or "")
    link = (
        await db.execute(
            select(KnowledgeBaseShareLink).where(
                KnowledgeBaseShareLink.token_hash == digest,
            )
        )
    ).scalar_one_or_none()
    if link is None:
        raise HTTPException(status_code=404, detail=INVALID_LINK_MESSAGE)

    now = datetime.utcnow()
    if _link_state(link, now) != "active":
        raise HTTPException(status_code=404, detail=INVALID_LINK_MESSAGE)

    # 库是否还在（软删除的库全局过滤器会把它藏起来）——同样落到同一个 404
    kb = (
        await db.execute(select(KnowledgeBase.id).where(KnowledgeBase.id == link.kb_id))
    ).scalar_one_or_none()
    if kb is None:
        raise HTTPException(status_code=404, detail=INVALID_LINK_MESSAGE)
    return link


async def preview_share_link(db: AsyncSession, token: str) -> dict[str, Any]:
    """免登录预览：**只回元信息**。

    字段用显式白名单（在 schema 里）而不是 ``dict`` 拼装——白名单是"漏字段"的唯一
    可靠防线。这里**不含** kb_id、token、任何文档名与正文；``owner_name`` 只给昵称，
    不回退到用户名（回退会泄漏登录名）。
    """
    from api.knowledge_base.service import _load_owner_names

    link = await _resolve_link(db, token)
    kb = (
        await db.execute(select(KnowledgeBase).where(KnowledgeBase.id == link.kb_id))
    ).scalar_one()
    names = await _load_owner_names(db, [kb.user_id])

    return {
        "valid": True,
        "kb_name": kb.name,
        "description": kb.description,
        "docs_count": kb.docs_count,
        "chunks_count": kb.chunks_count,
        "owner_name": names.get(kb.user_id),
        "permission": link.permission,
        "expires_at": link.expires_at,
    }


async def accept_share_link(db: AsyncSession, token: str, user_id: str) -> dict[str, Any]:
    """登录后接受链接：落成一条**普通的已接受分享行**（幂等）。

    幂等与"不降级"是这里最容易写错的两点：

    - 已有行（任意状态——包括被库主撤销过的）不该被**降级**：``permission`` 取较强者，
      ``expires_at`` 取"永久优先，否则较晚者"；
    - ``link_id`` 只在这条链接是"他此刻权限的来源或升级者"时写入。否则会出现：
      A 先被邀请、又点了链接，随后库主撤销链接——若把 link_id 当作回收依据，A 会
      莫名失去本应保留的邀请授权。这是这类实现最典型的翻车方式。
    """
    link = await _resolve_link(db, token)
    now = datetime.utcnow()

    kb = (
        await db.execute(select(KnowledgeBase).where(KnowledgeBase.id == link.kb_id))
    ).scalar_one()
    if kb.user_id == user_id:
        # 库主点自己的链接：不落行（对照 invite_shares 的"不邀请自己"）
        return {"accepted": True, "already": True, "permission": link.permission}

    existing = (
        await db.execute(
            select(KnowledgeBaseShare).where(
                KnowledgeBaseShare.kb_id == link.kb_id,
                KnowledgeBaseShare.grantee_id == user_id,
            )
        )
    ).scalar_one_or_none()

    if existing is not None and existing.status == SHARE_STATUS_ACCEPTED:
        upgraded = _permission_rank(link.permission) > _permission_rank(existing.permission)
        if upgraded or existing.expires_at is None:
            existing.permission = (
                SHARE_PERMISSION_WRITE if upgraded else existing.permission
            )
        if existing.expires_at is not None and (
            link.expires_at is None or link.expires_at > existing.expires_at
        ):
            existing.expires_at = link.expires_at
        if upgraded:
            existing.link_id = link.id
        await db.flush()
        return {
            "accepted": True, "already": True,
            "permission": existing.permission,
        }

    if existing is None:
        share = KnowledgeBaseShare(
            kb_id=link.kb_id, owner_id=kb.user_id, grantee_id=user_id,
            status=SHARE_STATUS_ACCEPTED, permission=link.permission,
            expires_at=link.expires_at, link_id=link.id,
            accepted_at=now,
        )
        db.add(share)
    else:
        # 曾经被邀请/拒绝/撤销过：复活并取较强者，accepted_at 保留"最早何时被授权"
        existing.status = SHARE_STATUS_ACCEPTED
        if _permission_rank(link.permission) > _permission_rank(existing.permission):
            existing.permission = link.permission
            existing.link_id = link.id
        if existing.expires_at is None or (
            link.expires_at is not None and link.expires_at > existing.expires_at
        ):
            existing.expires_at = link.expires_at
        if existing.accepted_at is None:
            existing.accepted_at = now

    link.accept_count = int(link.accept_count or 0) + 1
    link.last_accepted_at = now
    await db.flush()
    logger.info(
        "通过链接加入知识库：kb=%s user=%s permission=%s",
        link.kb_id, user_id, link.permission,
    )
    return {
        "accepted": True, "already": False, "permission": link.permission,
        "kb_id": link.kb_id,
    }
