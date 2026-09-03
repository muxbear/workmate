import asyncio
import json
import logging

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user_id
from core.decorators import handle_errors
from core.notification_bus import NotificationBus
from core.response import ok
from db import get_db
from api.notification.service import (
    delete_notification,
    get_unread_count,
    list_notifications,
    mark_all_read,
    mark_read,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


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
        from fastapi import HTTPException
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
                    payload = {
                        "type": event.type,
                        "title": event.title,
                        "content": event.content,
                        "level": event.level,
                        "link": event.link,
                    }
                    yield "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            NotificationBus.unregister_user(user_id)

    return StreamingResponse(event_generator(), media_type="text/event-stream")
