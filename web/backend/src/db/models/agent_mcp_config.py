"""AgentMcpConfig ORM 模型——专家级 MCP 运行配置。."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class AgentMcpConfig(Base):
    """专家级 MCP 运行配置（per-agent）。.

    与 mcp_installations（per-user）互补：
    - agent_mcp_configs 存储专家绑定的 MCP 运行参数（command/args/env/transport）
    - MCP 工具仍通过 agent_tools 关联表绑定到专家，本表提供额外运行参数
    """

    __tablename__ = "agent_mcp_configs"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4()),
    )
    agent_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("agents.id", ondelete="CASCADE"), nullable=False, index=True,
        comment="关联 Agent",
    )
    mcp_tool_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("mcp_tools.id", ondelete="CASCADE"), nullable=False,
        comment="关联 mcp_tools.id",
    )
    config: Mapped[dict] = mapped_column(JSON, default=dict, comment="运行配置")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, comment="是否启用")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, comment="创建时间")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow, comment="更新时间")

    __table_args__ = (
        UniqueConstraint("agent_id", "mcp_tool_id", name="uq_agent_mcp_config"),
    )
