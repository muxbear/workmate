from __future__ import annotations

import logging
from datetime import datetime

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from core.notification_bus import NotificationBus, NotificationEvent
from db.models.notification import Notification

logger = logging.getLogger(__name__)


async def create_notification(db: AsyncSession, event: NotificationEvent) -> Notification:
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
        await db.execute(
            select(Notification)
            .where(*conditions)
            .order_by(Notification.created_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).scalars().all()

    items = [_to_item(n) for n in rows]
    return {"items": items, "total": total, "page": page, "page_size": page_size}


async def get_unread_count(db: AsyncSession, user_id: str) -> int:
    result = await db.execute(
        select(func.count()).select_from(Notification).where(
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


async def delete_notification(db: AsyncSession, notification_id: str, user_id: str) -> bool:
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
