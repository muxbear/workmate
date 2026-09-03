from datetime import datetime
from typing import Any

from pydantic import BaseModel


class NotificationItem(BaseModel):
    id: str
    type: str
    title: str
    content: str
    level: str
    link: str | None = None
    metadata: dict[str, Any] | None = None
    is_read: bool
    created_at: str
    read_at: str | None = None


class UnreadCountResponse(BaseModel):
    count: int
