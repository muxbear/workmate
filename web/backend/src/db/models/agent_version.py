"""Agent 版本快照模型（改进4）— 记录 Agent 配置的每次变更历史。"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class AgentVersion(Base):
    """Agent 配置版本快照。"""

    __tablename__ = "agent_versions"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    agent_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("agents.id", ondelete="CASCADE"),
        nullable=False, index=True, comment="关联的 Agent ID"
    )
    version: Mapped[int] = mapped_column(
        Integer, nullable=False, comment="版本号，从 1 递增"
    )
    snapshot: Mapped[dict] = mapped_column(
        JSON, nullable=False,
        comment="Agent 配置快照 JSON"
    )
    changed_by: Mapped[str] = mapped_column(
        String(36), default="", comment="操作者用户 ID"
    )
    change_summary: Mapped[str] = mapped_column(
        Text, default="", comment="变更摘要"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=_utcnow, comment="快照创建时间"
    )
