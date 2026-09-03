"""系统事件记录工具——在关键流程中写入审计事件."""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from db.models.system_event import SystemEvent

logger = logging.getLogger(__name__)


async def log_event(
    db: AsyncSession,
    event_type: str,
    category: str,
    message: str,
    metadata: dict[str, Any] | None = None,
) -> None:
    """记录一条系统事件.

    Args:
        db: 数据库会话。
        event_type: 事件类型 (info/success/warn/error)。
        category: 事件分类 (agent/tool/cron/model/mcp/system)。
        message: 事件描述。
        metadata: 附加元数据。
    """
    try:
        event = SystemEvent(
            type=event_type,
            category=category,
            message=message,
            metadata_=metadata,
        )
        db.add(event)
        await db.commit()
    except Exception:
        logger.exception("Failed to log system event")
        await db.rollback()
