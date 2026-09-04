import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user_id
from api.notification.schemas import (
    NotificationSendRequest,
    NotificationUpdate,
)
from api.notification.service import (
    delete_notification,
    delete_notification_any,
    get_notification_detail,
    get_unread_count,
    list_all_notifications,
    list_notifications,
    mark_all_read,
    mark_read,
    send_notifications,
    update_notification,
)
from api.rbac.deps import RequirePermission
from core.decorators import handle_errors
from core.notification_bus import NotificationBus
from core.response import ok
from db import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/notifications", tags=["notifications"])
admin_router = APIRouter(
    prefix="/api/admin/notifications", tags=["notifications-admin"]
)


@router.get("")
@handle_errors
async def list_(
    page: int = 1,
    page_size: int = 20,
    type: str | None = None,
    is_read: bool | None = None,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    result = await list_notifications(db, user_id, page, page_size, type, is_read)
    return ok(result)


@router.get("/unread_count")
@handle_errors
async def unread_count(
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    count = await get_unread_count(db, user_id)
    return ok({"count": count})


@router.patch("/{notification_id}/read")
@handle_errors
async def read_one(
    notification_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    success = await mark_read(db, notification_id, user_id)
    if not success:
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail="Notification not found")
    return ok(None)


@router.post("/read_all")
@handle_errors
async def read_all(
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    count = await mark_all_read(db, user_id)
    return ok({"updated": count})


@router.delete("/{notification_id}")
@handle_errors
async def delete_one(
    notification_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    success = await delete_notification(db, notification_id, user_id)
    if not success:
        raise HTTPException(status_code=404, detail="Notification not found")
    return ok(None)


@admin_router.get("")
@handle_errors
async def admin_list(
    page: int = 1,
    page_size: int = 20,
    keyword: str | None = None,
    type: str | None = None,
    level: str | None = None,
    user_id: str | None = None,
    is_read: bool | None = None,
    _: str = Depends(RequirePermission("admin:announcements")),
    db: AsyncSession = Depends(get_db),
) -> Any:
    """管理端分页检索全部通知."""
    result = await list_all_notifications(
        db, page, page_size, keyword, type, level, user_id, is_read
    )
    return ok(result)


@admin_router.post("/send")
@handle_errors
async def admin_send(
    payload: NotificationSendRequest,
    sender_id: str = Depends(RequirePermission("admin:announcements")),
    db: AsyncSession = Depends(get_db),
) -> Any:
    """向指定用户或组织（部门及下级）发送通知."""
    if not payload.user_ids and not payload.department_ids:
        raise HTTPException(
            status_code=400,
            detail="请至少选择一位接收用户或一个接收组织",
        )
    result = await send_notifications(db, payload.model_dump(), sender_id)
    return ok(result)


@admin_router.get("/{notification_id}")
@handle_errors
async def admin_detail(
    notification_id: str,
    _: str = Depends(RequirePermission("admin:announcements")),
    db: AsyncSession = Depends(get_db),
) -> Any:
    """管理端查询通知详情."""
    item = await get_notification_detail(db, notification_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Notification not found")
    return ok(item)


@admin_router.put("/{notification_id}")
@handle_errors
async def admin_update(
    notification_id: str,
    payload: NotificationUpdate,
    _: str = Depends(RequirePermission("admin:announcements")),
    db: AsyncSession = Depends(get_db),
) -> Any:
    """管理端编辑通知."""
    item = await update_notification(
        db, notification_id, payload.model_dump(exclude_unset=True)
    )
    if item is None:
        raise HTTPException(status_code=404, detail="Notification not found")
    return ok(item)


@admin_router.delete("/{notification_id}")
@handle_errors
async def admin_delete(
    notification_id: str,
    _: str = Depends(RequirePermission("admin:announcements")),
    db: AsyncSession = Depends(get_db),
) -> Any:
    """管理端删除通知."""
    success = await delete_notification_any(db, notification_id)
    if not success:
        raise HTTPException(status_code=404, detail="Notification not found")
    return ok(None)


@router.get("/stream")
async def stream(
    request: Request,
    token: str | None = None,
):
    # EventSource cannot set Authorization header, so accept token via query param
    from core.security import decode_token

    if not token:
        from fastapi import HTTPException

        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = decode_token(token, "access")
    user_id = str(payload["sub"])

    queue = NotificationBus.register_user(user_id)

    async def event_generator():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30.0)
                    metadata = event.metadata or {}
                    payload = {
                        "source": event.source,
                        "type": event.type,
                        "title": event.title,
                        "content": event.content,
                        "level": event.level,
                        "link": event.link,
                        "announcement_id": metadata.get("announcement_id"),
                    }
                    yield "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"
                except TimeoutError:
                    yield ": ping\n\n"
        finally:
            NotificationBus.unregister_user(user_id)

    return StreamingResponse(event_generator(), media_type="text/event-stream")
