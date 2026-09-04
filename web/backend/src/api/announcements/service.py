"""公告业务逻辑层."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from sqlalchemy import delete, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.notification_bus import NotificationBus, NotificationEvent
from db.models.announcement import Announcement, AnnouncementRead

logger = logging.getLogger(__name__)

STATUS_DRAFT = "draft"
STATUS_PUBLISHED = "published"


async def list_announcements(
    db: AsyncSession,
    page: int = 1,
    page_size: int = 20,
    keyword: str | None = None,
    status: str | None = None,
    level: str | None = None,
) -> dict[str, Any]:
    """按标题/内容关键字、状态与级别分页查询公告."""
    conditions: list[Any] = []
    if keyword:
        like = f"%{keyword}%"
        conditions.append(
            or_(
                Announcement.title.ilike(like),
                Announcement.content.ilike(like),
            )
        )
    if status:
        conditions.append(Announcement.status == status)
    if level:
        conditions.append(Announcement.level == level)

    total = (
        await db.execute(
            select(func.count()).select_from(Announcement).where(*conditions)
        )
    ).scalar() or 0
    rows = (
        (
            await db.execute(
                select(Announcement)
                .where(*conditions)
                .order_by(Announcement.created_at.desc())
                .offset((page - 1) * page_size)
                .limit(page_size)
            )
        )
        .scalars()
        .all()
    )
    read_counts = await _read_counts(db, [a.id for a in rows])
    items = [_to_admin_item(a, read_counts.get(a.id, 0)) for a in rows]
    return {"items": items, "total": total, "page": page, "page_size": page_size}


async def get_announcement(
    db: AsyncSession, announcement_id: str
) -> dict[str, Any] | None:
    """获取公告详情."""
    announcement = await _get_announcement_row(db, announcement_id)
    if announcement is None:
        return None
    read_counts = await _read_counts(db, [announcement.id])
    return _to_admin_item(announcement, read_counts.get(announcement.id, 0))


async def create_announcement(
    db: AsyncSession, data: dict[str, Any], user_id: str
) -> dict[str, Any]:
    """创建公告，可按草稿或直接发布."""
    status = data.get("status") or STATUS_DRAFT
    announcement = Announcement(
        title=data["title"],
        content=data.get("content") or "",
        level=data.get("level") or "info",
        link=(data.get("link") or None),
        status=status,
        created_by=user_id,
        published_at=datetime.utcnow() if status == STATUS_PUBLISHED else None,
    )
    db.add(announcement)
    await db.commit()
    await db.refresh(announcement)
    if status == STATUS_PUBLISHED:
        _notify_new_announcement(announcement)
    return _to_admin_item(announcement, 0)


async def update_announcement(
    db: AsyncSession, announcement_id: str, data: dict[str, Any]
) -> dict[str, Any] | None:
    """更新公告信息，并处理草稿/发布状态切换."""
    announcement = await _get_announcement_row(db, announcement_id)
    if announcement is None:
        return None
    was_draft = (
        announcement.status == STATUS_DRAFT or announcement.published_at is None
    )
    if "title" in data and data["title"] is not None:
        announcement.title = data["title"]
    if "content" in data and data["content"] is not None:
        announcement.content = data["content"]
    if "level" in data and data["level"] is not None:
        announcement.level = data["level"]
    if "link" in data:
        announcement.link = data["link"] or None
    if "status" in data and data["status"] in (STATUS_DRAFT, STATUS_PUBLISHED):
        new_status = data["status"]
        announcement.status = new_status
        if new_status == STATUS_PUBLISHED and announcement.published_at is None:
            announcement.published_at = datetime.utcnow()
        elif new_status == STATUS_DRAFT:
            announcement.published_at = None
    await db.commit()
    await db.refresh(announcement)
    if (
        announcement.status == STATUS_PUBLISHED
        and was_draft
        and announcement.published_at is not None
    ):
        _notify_new_announcement(announcement)
    read_counts = await _read_counts(db, [announcement.id])
    return _to_admin_item(announcement, read_counts.get(announcement.id, 0))


async def publish_announcement(
    db: AsyncSession, announcement_id: str
) -> dict[str, Any] | None:
    """将草稿公告发布为对所有用户可见."""
    announcement = await _get_announcement_row(db, announcement_id)
    if announcement is None:
        return None
    was_draft = announcement.published_at is None
    announcement.status = STATUS_PUBLISHED
    if announcement.published_at is None:
        announcement.published_at = datetime.utcnow()
    await db.commit()
    await db.refresh(announcement)
    if was_draft:
        _notify_new_announcement(announcement)
    read_counts = await _read_counts(db, [announcement.id])
    return _to_admin_item(announcement, read_counts.get(announcement.id, 0))


async def delete_announcement(db: AsyncSession, announcement_id: str) -> bool:
    """删除公告及其全部已读记录."""
    announcement = await _get_announcement_row(db, announcement_id)
    if announcement is None:
        return False
    await db.execute(
        delete(AnnouncementRead).where(
            AnnouncementRead.announcement_id == announcement_id
        )
    )
    await db.delete(announcement)
    await db.commit()
    return True


async def list_my_announcements(
    db: AsyncSession, user_id: str, page: int = 1, page_size: int = 20
) -> dict[str, Any]:
    """列出当前用户可见的已发布公告，并标注是否已读."""
    conditions = [Announcement.status == STATUS_PUBLISHED]
    total = (
        await db.execute(
            select(func.count()).select_from(Announcement).where(*conditions)
        )
    ).scalar() or 0
    rows = (
        (
            await db.execute(
                select(Announcement)
                .where(*conditions)
                .order_by(
                    Announcement.published_at.desc(), Announcement.created_at.desc()
                )
                .offset((page - 1) * page_size)
                .limit(page_size)
            )
        )
        .scalars()
        .all()
    )
    read_map = await _read_states(db, [a.id for a in rows], user_id)
    items = [_to_mine_item(a, read_map.get(a.id)) for a in rows]
    return {"items": items, "total": total, "page": page, "page_size": page_size}


async def get_unread_count(db: AsyncSession, user_id: str) -> int:
    """统计当前用户未读公告数量."""
    not_read = ~exists(
        select(AnnouncementRead.id).where(
            AnnouncementRead.announcement_id == Announcement.id,
            AnnouncementRead.user_id == user_id,
        )
    )
    total = (
        await db.execute(
            select(func.count())
            .select_from(Announcement)
            .where(Announcement.status == STATUS_PUBLISHED, not_read)
        )
    ).scalar() or 0
    return int(total)


async def mark_read(db: AsyncSession, announcement_id: str, user_id: str) -> bool:
    """将单条公告标记为已读."""
    announcement = await _get_announcement_row(db, announcement_id)
    if announcement is None or announcement.status != STATUS_PUBLISHED:
        return False
    existing = (
        await db.execute(
            select(AnnouncementRead).where(
                AnnouncementRead.announcement_id == announcement_id,
                AnnouncementRead.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        db.add(
            AnnouncementRead(
                announcement_id=announcement_id,
                user_id=user_id,
                read_at=datetime.utcnow(),
            )
        )
        await db.commit()
    return True


async def mark_all_read(db: AsyncSession, user_id: str) -> int:
    """将当前用户所有已发布公告标记为已读."""
    published_ids = (
        (
            await db.execute(
                select(Announcement.id).where(Announcement.status == STATUS_PUBLISHED)
            )
        )
        .scalars()
        .all()
    )
    read_ids = set(
        (
            await db.execute(
                select(AnnouncementRead.announcement_id).where(
                    AnnouncementRead.user_id == user_id
                )
            )
        )
        .scalars()
        .all()
    )
    created = 0
    for announcement_id in published_ids:
        if announcement_id not in read_ids:
            db.add(
                AnnouncementRead(
                    announcement_id=announcement_id,
                    user_id=user_id,
                    read_at=datetime.utcnow(),
                )
            )
            created += 1
    if created:
        await db.commit()
    return created


def _notify_new_announcement(announcement: Announcement) -> None:
    """向在线用户实时推送新发布的公告（不写个人通知副本）."""
    event = NotificationEvent(
        user_id="",
        type="announcement",
        title=announcement.title,
        content=announcement.content,
        level=announcement.level,
        link=announcement.link,
        metadata={"announcement_id": announcement.id},
        source="announcement",
    )
    NotificationBus.deliver_to_users(NotificationBus.online_user_ids(), event)


async def _get_announcement_row(
    db: AsyncSession, announcement_id: str
) -> Announcement | None:
    """按 ID 查询公告."""
    result = await db.execute(
        select(Announcement).where(Announcement.id == announcement_id)
    )
    return result.scalar_one_or_none()


async def _read_counts(db: AsyncSession, announcement_ids: list[str]) -> dict[str, int]:
    """统计公告的已读人数."""
    if not announcement_ids:
        return {}
    result = await db.execute(
        select(
            AnnouncementRead.announcement_id,
            func.count(AnnouncementRead.id),
        )
        .where(AnnouncementRead.announcement_id.in_(announcement_ids))
        .group_by(AnnouncementRead.announcement_id)
    )
    return {row[0]: int(row[1]) for row in result.all()}


async def _read_states(
    db: AsyncSession, announcement_ids: list[str], user_id: str
) -> dict[str, datetime]:
    """查询用户对指定公告的已读时间."""
    if not announcement_ids:
        return {}
    result = await db.execute(
        select(AnnouncementRead).where(
            AnnouncementRead.announcement_id.in_(announcement_ids),
            AnnouncementRead.user_id == user_id,
        )
    )
    return {row.announcement_id: row.read_at for row in result.scalars().all()}


def _to_admin_item(announcement: Announcement, read_count: int) -> dict[str, Any]:
    """转换为管理端公告响应."""
    return {
        "id": announcement.id,
        "title": announcement.title,
        "content": announcement.content,
        "level": announcement.level,
        "link": announcement.link,
        "status": announcement.status,
        "created_by": announcement.created_by,
        "published_at": (
            announcement.published_at.isoformat() if announcement.published_at else None
        ),
        "created_at": announcement.created_at.isoformat(),
        "updated_at": announcement.updated_at.isoformat(),
        "read_count": read_count,
    }


def _to_mine_item(
    announcement: Announcement, read_at: datetime | None
) -> dict[str, Any]:
    """转换为用户在通知面板看到的公告项."""
    created_at = announcement.published_at or announcement.created_at
    return {
        "id": announcement.id,
        "title": announcement.title,
        "content": announcement.content,
        "level": announcement.level,
        "link": announcement.link,
        "is_read": read_at is not None,
        "created_at": created_at.isoformat(),
        "read_at": read_at.isoformat() if read_at else None,
    }
