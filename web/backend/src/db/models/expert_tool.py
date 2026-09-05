"""Expert-Tool junction table for many-to-many relationship."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from db.base import Base

if TYPE_CHECKING:
    from db.models.expert import Expert
    from db.models.tool import Tool


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class ExpertTool(Base):
    """Junction table linking experts to tools."""

    __tablename__ = "expert_tools"

    expert_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("experts.id", ondelete="CASCADE"), primary_key=True
    )
    tool_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("tools.id", ondelete="CASCADE"), primary_key=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    # Relationships
    expert: Mapped[Expert] = relationship("Expert", back_populates="tool_links")
    tool: Mapped[Tool] = relationship("Tool")
