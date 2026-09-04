"""公告 API：管理端公告维护 + 用户公告箱."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from api.announcements import service as announcement_service
from api.announcements.schemas import AnnouncementCreate, AnnouncementUpdate
from api.deps import get_current_user_id, get_db
from api.rbac.deps import RequirePermission
from core.decorators import handle_errors
from core.response import ok

router = APIRouter(prefix="/api/announcements", tags=["announcements"])
admin_router = APIRouter(
    prefix="/api/admin/announcements", tags=["announcements-admin"]
)


@router.get("/mine")
@handle_errors
async def my_list(
    page: int = 1,
    page_size: int = 20,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> Any:
    """查询当前用户可见的公告列表."""
    result = await announcement_service.list_my_announcements(
        db, user_id, page, page_size
    )
    return ok(result)


@router.get("/unread_count")
@handle_errors
async def unread_count(
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> Any:
    """查询当前用户的未读公告数."""
    count = await announcement_service.get_unread_count(db, user_id)
    return ok({"count": count})


@router.post("/read_all")
@handle_errors
async def read_all(
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> Any:
    """将当前用户的全部公告标记为已读."""
    updated = await announcement_service.mark_all_read(db, user_id)
    return ok({"updated": updated})


@router.patch("/{announcement_id}/read")
@handle_errors
async def read_one(
    announcement_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> Any:
    """将指定公告标记为已读."""
    success = await announcement_service.mark_read(db, announcement_id, user_id)
    if not success:
        raise HTTPException(status_code=404, detail="Announcement not found")
    return ok(None)


@admin_router.get("")
@handle_errors
async def admin_list(
    page: int = 1,
    page_size: int = 20,
    keyword: str | None = None,
    status: str | None = None,
    level: str | None = None,
    _: str = Depends(RequirePermission("admin:announcements")),
    db: AsyncSession = Depends(get_db),
) -> Any:
    """分页检索公告（管理端）."""
    result = await announcement_service.list_announcements(
        db, page, page_size, keyword, status, level
    )
    return ok(result)


@admin_router.post("")
@handle_errors
async def admin_create(
    payload: AnnouncementCreate,
    user_id: str = Depends(RequirePermission("admin:announcements")),
    db: AsyncSession = Depends(get_db),
) -> Any:
    """新建公告（草稿或发布）."""
    item = await announcement_service.create_announcement(
        db, payload.model_dump(), user_id
    )
    return ok(item)


@admin_router.get("/{announcement_id}")
@handle_errors
async def admin_detail(
    announcement_id: str,
    _: str = Depends(RequirePermission("admin:announcements")),
    db: AsyncSession = Depends(get_db),
) -> Any:
    """查询公告详情（管理端）."""
    item = await announcement_service.get_announcement(db, announcement_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Announcement not found")
    return ok(item)


@admin_router.put("/{announcement_id}")
@handle_errors
async def admin_update(
    announcement_id: str,
    payload: AnnouncementUpdate,
    _: str = Depends(RequirePermission("admin:announcements")),
    db: AsyncSession = Depends(get_db),
) -> Any:
    """编辑公告（管理端）."""
    item = await announcement_service.update_announcement(
        db, announcement_id, payload.model_dump(exclude_unset=True)
    )
    if item is None:
        raise HTTPException(status_code=404, detail="Announcement not found")
    return ok(item)


@admin_router.post("/{announcement_id}/publish")
@handle_errors
async def admin_publish(
    announcement_id: str,
    _: str = Depends(RequirePermission("admin:announcements")),
    db: AsyncSession = Depends(get_db),
) -> Any:
    """发布公告（管理端）."""
    item = await announcement_service.publish_announcement(db, announcement_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Announcement not found")
    return ok(item)


@admin_router.delete("/{announcement_id}")
@handle_errors
async def admin_delete(
    announcement_id: str,
    _: str = Depends(RequirePermission("admin:announcements")),
    db: AsyncSession = Depends(get_db),
) -> Any:
    """删除公告（管理端）."""
    success = await announcement_service.delete_announcement(db, announcement_id)
    if not success:
        raise HTTPException(status_code=404, detail="Announcement not found")
    return ok(None)
