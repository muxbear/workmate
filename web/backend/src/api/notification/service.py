from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from core.notification_bus import NotificationBus, NotificationEvent
from db.models.department import Department
from db.models.notification import Notification
from db.models.personnel import Personnel
from db.models.user import Account

logger = logging.getLogger(__name__)


async def create_notification(
    db: AsyncSession, event: NotificationEvent
) -> Notification:
    notif = Notification(
        user_id=event.user_id,
        type=event.type,
        title=event.title,
        content=event.content,
        level=event.level,
        link=event.link,
        metadata_=event.metadata,
        is_read=False,
    )
    db.add(notif)
    await db.commit()
    await db.refresh(notif)
    return notif


async def _handle_notification_event(event: NotificationEvent) -> None:
    from db.engine import async_session

    async with async_session() as db:
        await create_notification(db, event)


def init_notification_bus() -> None:
    NotificationBus.subscribe(_handle_notification_event)


async def list_notifications(
    db: AsyncSession,
    user_id: str,
    page: int = 1,
    page_size: int = 20,
    type_filter: str | None = None,
    is_read: bool | None = None,
) -> dict:
    conditions = [Notification.user_id == user_id]
    if type_filter:
        conditions.append(Notification.type == type_filter)
    if is_read is not None:
        conditions.append(Notification.is_read == is_read)

    total = (
        await db.execute(
            select(func.count()).select_from(Notification).where(*conditions)
        )
    ).scalar() or 0

    rows = (
        (
            await db.execute(
                select(Notification)
                .where(*conditions)
                .order_by(Notification.created_at.desc())
                .offset((page - 1) * page_size)
                .limit(page_size)
            )
        )
        .scalars()
        .all()
    )

    items = [_to_item(n) for n in rows]
    return {"items": items, "total": total, "page": page, "page_size": page_size}


async def get_unread_count(db: AsyncSession, user_id: str) -> int:
    result = await db.execute(
        select(func.count())
        .select_from(Notification)
        .where(
            Notification.user_id == user_id,
            Notification.is_read == False,
        )
    )
    return result.scalar() or 0


async def mark_read(db: AsyncSession, notification_id: str, user_id: str) -> bool:
    result = await db.execute(
        select(Notification).where(
            Notification.id == notification_id,
            Notification.user_id == user_id,
        )
    )
    notif = result.scalar_one_or_none()
    if notif is None:
        return False
    notif.is_read = True
    notif.read_at = datetime.utcnow()
    await db.commit()
    return True


async def mark_all_read(db: AsyncSession, user_id: str) -> int:
    result = await db.execute(
        update(Notification)
        .where(Notification.user_id == user_id, Notification.is_read == False)
        .values(is_read=True, read_at=datetime.utcnow())
    )
    await db.commit()
    return result.rowcount


async def delete_notification(
    db: AsyncSession, notification_id: str, user_id: str
) -> bool:
    result = await db.execute(
        select(Notification).where(
            Notification.id == notification_id,
            Notification.user_id == user_id,
        )
    )
    notif = result.scalar_one_or_none()
    if notif is None:
        return False
    await db.delete(notif)
    await db.commit()
    return True


async def list_all_notifications(
    db: AsyncSession,
    page: int = 1,
    page_size: int = 20,
    keyword: str | None = None,
    type_filter: str | None = None,
    level: str | None = None,
    user_id_filter: str | None = None,
    is_read: bool | None = None,
) -> dict[str, Any]:
    """管理端分页查询全部用户通知."""
    conditions: list[Any] = []
    if keyword:
        like = f"%{keyword}%"
        title_cond = or_(
            Notification.title.ilike(like),
            Notification.content.ilike(like),
            Notification.type.ilike(like),
        )
        user_result = await db.execute(
            select(Account.id).where(
                or_(
                    Account.username.ilike(like),
                    Account.nickname.ilike(like),
                )
            )
        )
        user_ids = list(user_result.scalars().all())
        if user_ids:
            conditions.append(or_(title_cond, Notification.user_id.in_(user_ids)))
        else:
            conditions.append(title_cond)
    if type_filter:
        conditions.append(Notification.type == type_filter)
    if level:
        conditions.append(Notification.level == level)
    if user_id_filter:
        conditions.append(Notification.user_id == user_id_filter)
    if is_read is not None:
        conditions.append(Notification.is_read == is_read)

    total = (
        await db.execute(
            select(func.count()).select_from(Notification).where(*conditions)
        )
    ).scalar() or 0
    rows = (
        (
            await db.execute(
                select(Notification)
                .where(*conditions)
                .order_by(Notification.created_at.desc())
                .offset((page - 1) * page_size)
                .limit(page_size)
            )
        )
        .scalars()
        .all()
    )
    user_map = await _load_user_map(db, [n.user_id for n in rows])
    items = [_to_admin_item(n, user_map.get(n.user_id)) for n in rows]
    return {"items": items, "total": total, "page": page, "page_size": page_size}


async def get_notification_detail(
    db: AsyncSession, notification_id: str
) -> dict[str, Any] | None:
    """管理端查询通知详情."""
    result = await db.execute(
        select(Notification).where(Notification.id == notification_id)
    )
    notif = result.scalar_one_or_none()
    if notif is None:
        return None
    user_map = await _load_user_map(db, [notif.user_id])
    return _to_admin_item(notif, user_map.get(notif.user_id))


async def update_notification(
    db: AsyncSession, notification_id: str, values: dict[str, Any]
) -> dict[str, Any] | None:
    """管理端编辑通知（标题/内容/级别/链接/已读状态）."""
    result = await db.execute(
        select(Notification).where(Notification.id == notification_id)
    )
    notif = result.scalar_one_or_none()
    if notif is None:
        return None
    if "title" in values and values["title"] is not None:
        notif.title = values["title"]
    if "content" in values and values["content"] is not None:
        notif.content = values["content"]
    if "level" in values and values["level"] is not None:
        notif.level = values["level"]
    if "link" in values:
        notif.link = values["link"] or None
    if "is_read" in values:
        read_flag = bool(values["is_read"])
        notif.is_read = read_flag
        notif.read_at = datetime.utcnow() if read_flag else None
    await db.commit()
    await db.refresh(notif)
    user_map = await _load_user_map(db, [notif.user_id])
    return _to_admin_item(notif, user_map.get(notif.user_id))


async def delete_notification_any(db: AsyncSession, notification_id: str) -> bool:
    """管理端删除任意用户的通知."""
    result = await db.execute(
        select(Notification).where(Notification.id == notification_id)
    )
    notif = result.scalar_one_or_none()
    if notif is None:
        return False
    await db.delete(notif)
    await db.commit()
    return True


async def send_notifications(
    db: AsyncSession,
    data: dict[str, Any],
    sender_id: str,
) -> dict[str, Any]:
    """向指定账号或组织（部门及下级）成员发送通知."""
    recipient_ids: list[str] = []
    for user_id in data.get("user_ids") or []:
        if isinstance(user_id, str) and user_id not in recipient_ids:
            recipient_ids.append(user_id)

    dept_ids = [
        str(did)
        for did in (data.get("department_ids") or [])
        if isinstance(did, str) and did
    ]
    all_dept_ids = await _expand_department_ids(db, dept_ids)
    if all_dept_ids:
        result = await db.execute(
            select(Personnel.account_id).where(
                Personnel.dept_id.in_(all_dept_ids),
                Personnel.account_id.is_not(None),
                Personnel.status == "active",
            )
        )
        for account_id in result.scalars().all():
            if account_id and account_id not in recipient_ids:
                recipient_ids.append(account_id)

    if not recipient_ids:
        return {"sent": 0, "recipients": []}

    title = str(data.get("title") or "")
    content = str(data.get("content") or "")
    level = str(data.get("level") or "info")
    link_value = data.get("link")
    link = str(link_value) if link_value else None
    for user_id in recipient_ids:
        db.add(
            Notification(
                user_id=user_id,
                type="manual",
                title=title,
                content=content,
                level=level,
                link=link,
                metadata_={"sender_id": sender_id, "kind": "manual"},
                is_read=False,
            )
        )
    await db.commit()

    event = NotificationEvent(
        user_id="",
        type="manual",
        title=title,
        content=content,
        level=level,
        link=link,
        metadata={"kind": "manual"},
        source="notification",
    )
    NotificationBus.deliver_to_users(recipient_ids, event)
    return {"sent": len(recipient_ids), "recipients": recipient_ids}


async def _expand_department_ids(
    db: AsyncSession, dept_ids: list[str]
) -> list[str]:
    """展开部门 ID，包含全部下级部门."""
    if not dept_ids:
        return []
    result = await db.execute(select(Department.id, Department.parent_id))
    children_by_parent: dict[str | None, list[str]] = {}
    for dept_id, parent_id in result.all():
        children_by_parent.setdefault(parent_id, []).append(dept_id)

    expanded: list[str] = []
    stack = list(dict.fromkeys(dept_ids))
    while stack:
        current = stack.pop()
        if current in expanded:
            continue
        expanded.append(current)
        for child_id in children_by_parent.get(current, []):
            if child_id not in expanded:
                stack.append(child_id)
    return expanded


async def _load_user_map(
    db: AsyncSession, user_ids: list[str]
) -> dict[str, dict[str, str | None]]:
    """按用户 ID 批量加载账号展示信息."""
    if not user_ids:
        return {}
    result = await db.execute(select(Account).where(Account.id.in_(user_ids)))
    return {
        account.id: {
            "id": account.id,
            "username": account.username,
            "nickname": account.nickname,
        }
        for account in result.scalars().all()
    }


def _to_admin_item(
    notif: Notification, user: dict[str, str | None] | None
) -> dict[str, Any]:
    """转换为管理端通知响应（附带用户信息）."""
    item = _to_item(notif)
    item["user"] = user or {
        "id": notif.user_id,
        "username": None,
        "nickname": None,
    }
    return item


def _to_item(n: Notification) -> dict:
    return {
        "id": n.id,
        "type": n.type,
        "title": n.title,
        "content": n.content,
        "level": n.level,
        "link": n.link,
        "metadata": n.metadata_,
        "is_read": n.is_read,
        "created_at": n.created_at.isoformat() if n.created_at else "",
        "read_at": n.read_at.isoformat() if n.read_at else None,
    }
