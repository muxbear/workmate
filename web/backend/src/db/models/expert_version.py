"""ExpertVersion ORM 模型——记录专家配置的每次变更历史。."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from db.base import Base

if TYPE_CHECKING:
    from db.models.expert import Expert


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class ExpertVersion(Base):
    """专家配置版本快照。."""

    __tablename__ = "expert_versions"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    expert_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("experts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
        comment="关联的 Expert ID",
    )
    version: Mapped[int] = mapped_column(
        Integer, nullable=False, comment="版本号，从 1 递增"
    )
    snapshot: Mapped[dict] = mapped_column(
        JSON, nullable=False, comment="专家配置快照 JSON"
    )
    changed_by: Mapped[str] = mapped_column(
        String(36), default="", comment="操作者用户 ID"
    )
    change_summary: Mapped[str] = mapped_column(Text, default="", comment="变更摘要")
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=_utcnow, comment="快照创建时间"
    )

    # Relationships
    expert: Mapped[Expert] = relationship("Expert", back_populates="versions")
