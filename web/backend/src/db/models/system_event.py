"""SystemEvent ORM model — 系统事件审计日志."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime, String, Text
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class SystemEvent(Base):
    """系统事件日志——Agent 执行、工具调用、定时任务、模型切换等审计事件."""

    __tablename__ = "system_events"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    type: Mapped[str] = mapped_column(String(16), nullable=False)  # info/success/warn/error
    category: Mapped[str] = mapped_column(String(32), nullable=False)  # agent/tool/cron/model/mcp/system
    message: Mapped[str] = mapped_column(Text, nullable=False)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSON, nullable=True)
    #: 动作 / 操作者 / 来源 IP / 操作对象 / 结果——审计的检索维度。
    #: 单独建列而不是塞进 metadata_：审计最常见的查询就是"某人做了哪些事"与
    #: "某个库被谁动过"，JSON 里过滤既写不直观也索引不到。
    action: Mapped[str | None] = mapped_column(
        String(64), nullable=True, index=True, comment="动作键，如 knowledge.delete"
    )
    user_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    target: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    result: Mapped[str | None] = mapped_column(
        String(16), nullable=True, comment="success | failed | denied"
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, index=True)
