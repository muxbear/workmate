"""OAuth2Client ORM model for client registration."""

import uuid
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


class OAuth2Client(Base):
    """OAuth2 客户端注册信息."""

    __tablename__ = "oauth2_clients"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    client_id: Mapped[str] = mapped_column(
        String(64), unique=True, nullable=False, index=True
    )
    client_name: Mapped[str] = mapped_column(String(128), nullable=False)
    client_type: Mapped[str] = mapped_column(
        String(16), nullable=False, default="public"
    )
    redirect_uris: Mapped[list[str]] = mapped_column(
        JSON, nullable=False, default=list
    )
    allowed_scopes: Mapped[list[str]] = mapped_column(
        JSON, nullable=False, default=list
    )
    grant_types: Mapped[list[str]] = mapped_column(
        JSON, nullable=False, default=lambda: ["authorization_code"]
    )
    client_secret_hash: Mapped[str | None] = mapped_column(
        String(255), nullable=True
    )
    description: Mapped[str] = mapped_column(Text, default="")
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
