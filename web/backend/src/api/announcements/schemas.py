"""公告 API 的请求 Schema."""

from typing import Literal

from pydantic import BaseModel, Field

AnnouncementLevel = Literal["info", "success", "warning", "error"]
AnnouncementStatus = Literal["draft", "published"]


class AnnouncementCreate(BaseModel):
    """创建公告的请求体."""

    title: str = Field(min_length=1, max_length=200)
    content: str = ""
    level: AnnouncementLevel = "info"
    link: str | None = Field(default=None, max_length=512)
    status: AnnouncementStatus = "draft"


class AnnouncementUpdate(BaseModel):
    """更新公告的请求体（字段可选，按需更新）."""

    title: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = None
    level: AnnouncementLevel | None = None
    link: str | None = Field(default=None, max_length=512)
    status: AnnouncementStatus | None = None
