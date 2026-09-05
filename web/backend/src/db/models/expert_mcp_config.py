"""ExpertMcpConfig ORM 模型——专家级 MCP 运行配置。."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from db.base import Base

if TYPE_CHECKING:
    from db.models.expert import Expert
    from db.models.mcp_tool import McpTool


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class ExpertMcpConfig(Base):
    """专家级 MCP 运行配置（per-expert）。."""

    __tablename__ = "expert_mcp_configs"

    id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        default=lambda: str(uuid.uuid4()),
    )
    expert_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("experts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
        comment="关联 Expert",
    )
    mcp_tool_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("mcp_tools.id", ondelete="CASCADE"),
        nullable=False,
        comment="关联 mcp_tools.id",
    )
    config: Mapped[dict] = mapped_column(JSON, default=dict, comment="运行配置")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, comment="是否启用")
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=_utcnow, comment="创建时间"
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=_utcnow, onupdate=_utcnow, comment="更新时间"
    )

    __table_args__ = (
        UniqueConstraint("expert_id", "mcp_tool_id", name="uq_expert_mcp_config"),
    )

    # Relationships
    expert: Mapped[Expert] = relationship("Expert", back_populates="mcp_configs")
    mcp_tool: Mapped[McpTool] = relationship("McpTool")
