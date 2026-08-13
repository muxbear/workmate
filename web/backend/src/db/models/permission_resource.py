import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


class PermissionResource(Base):
    __tablename__ = "permission_resources"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    parent_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("permission_resources.id", ondelete="CASCADE"), nullable=True
    )
    type: Mapped[str] = mapped_column(String(10), nullable=False)  # catalog | menu | button
    label: Mapped[str] = mapped_column(String(128), nullable=False)
    perm_key: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    path: Mapped[str | None] = mapped_column(String(256), nullable=True)
    icon: Mapped[str] = mapped_column(String(64), default="Folder")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(10), default="active")  # active | hidden | disabled
    is_builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    description: Mapped[str] = mapped_column(Text, default="")
    btn_variant: Mapped[str | None] = mapped_column(String(20), nullable=True)
    danger: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
