from typing import Any

from pydantic import BaseModel, Field


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


class NotificationSendRequest(BaseModel):
    """管理端定向发送通知（个人/组织）的请求体."""

    title: str = Field(min_length=1, max_length=128)
    content: str = ""
    level: str = Field(
        default="info", pattern=r"^(info|success|warning|error)$"
    )
    link: str | None = Field(default=None, max_length=512)
    user_ids: list[str] = Field(default_factory=list)
    department_ids: list[str] = Field(default_factory=list)


class NotificationUpdate(BaseModel):
    """管理端编辑通知的请求体."""

    title: str | None = Field(default=None, max_length=128)
    content: str | None = None
    level: str | None = Field(default=None, pattern=r"^(info|success|warning|error)$")
    link: str | None = Field(default=None, max_length=512)
    is_read: bool | None = None


class UnreadCountResponse(BaseModel):
    count: int
