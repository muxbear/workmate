"""Provider ORM model for storing AI service provider metadata."""
import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class Provider(Base):
    """AI model provider — stores API endpoint and credential configuration."""

    __tablename__ = "providers"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(128), nullable=False, unique=True, comment="提供商名称")
    logo: Mapped[str] = mapped_column(String(16), default="🤖", comment="图标 emoji")
    status: Mapped[str] = mapped_column(String(16), default="unconfigured", comment="连接状态: connected, error, unconfigured")
    api_base: Mapped[str] = mapped_column(String(512), nullable=False, default="", comment="OpenAI Chat Completion 协议 URL")
    response_url: Mapped[str] = mapped_column(String(512), default="", comment="OpenAI Response 协议 URL")
    anthropic_url: Mapped[str] = mapped_column(String(512), default="", comment="Anthropic Message 协议 URL")
    api_key: Mapped[str] = mapped_column(String(512), default="", comment="API 密钥")
    description: Mapped[str] = mapped_column(Text, default="", comment="描述")
    website: Mapped[str] = mapped_column(String(512), default="", comment="官网 URL")
    sort_order: Mapped[int] = mapped_column(Integer, default=0, index=True, comment="排序值")
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True, comment="所属用户ID")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, comment="创建时间")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow, comment="更新时间")
