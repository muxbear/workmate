"""OAuth2Consent ORM model：用户级授权记忆（已授权 / 主动关闭的 scope）."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


def _utcnow() -> datetime:
    """返回无时区的 UTC 时间（与 DateTime 列存储保持一致）."""
    return datetime.now(UTC).replace(tzinfo=None)


class OAuth2Consent(Base):
    """用户在某个 OAuth2 客户端下的授权记忆.

    - ``scope``：已授权 scope 并集（空格分隔）。
    - ``denied_scope``：用户主动关闭的 scope，用于区分“从未请求”与“明确不要”。
    - ``denied_expires_at``：关闭项过期时间，到期后恢复默认开启。
    """

    __tablename__ = "oauth2_consents"
    __table_args__ = (
        UniqueConstraint("client_id", "user_id", name="uq_oauth2_consents_client_user"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    client_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    scope: Mapped[str] = mapped_column(Text, nullable=False, default="")
    denied_scope: Mapped[str] = mapped_column(Text, nullable=False, default="")
    denied_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    granted_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)
