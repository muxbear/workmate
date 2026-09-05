"""Expert-Skill junction table for many-to-many relationship."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from db.base import Base

if TYPE_CHECKING:
    from db.models.expert import Expert
    from db.models.skill import Skill


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class ExpertSkill(Base):
    """Junction table linking experts to skills."""

    __tablename__ = "expert_skills"

    expert_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("experts.id", ondelete="CASCADE"), primary_key=True
    )
    skill_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("skills.id", ondelete="CASCADE"), primary_key=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    # Relationships
    expert: Mapped[Expert] = relationship("Expert", back_populates="skill_links")
    skill: Mapped[Skill] = relationship("Skill")
