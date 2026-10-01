"""User preference ORM model."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


class UserPreference(Base):
    """按用户存储的界面偏好（语言、字号、通知开关等）.

    一位用户 + 一个偏好键只有一行，写入走 upsert。与全局配置
    ``system_settings`` 分表存放：全局行若用 ``user_id`` 为空表示，
    NULL 在 SQLite/PostgreSQL 的唯一约束下语义不一致，会重复插入。
    """

    __tablename__ = "user_preferences"
    __table_args__ = (
        UniqueConstraint("user_id", "pref_key", name="uq_user_preference_key"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(36), nullable=False, index=True, comment="用户 ID"
    )
    pref_key: Mapped[str] = mapped_column(String(64), nullable=False, comment="偏好键")
    pref_value: Mapped[str | None] = mapped_column(
        Text, nullable=True, comment="偏好值"
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
