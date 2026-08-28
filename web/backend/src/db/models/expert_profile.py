"""ExpertProfile ORM 模型——专家展示元数据（1:1 关联 agents）。."""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from db.base import Base


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class ExpertProfile(Base):
    """专家展示元数据，与 agents 表 1:1 关联。.

    专家 = agents.type='sub' 且存在对应的 expert_profiles 记录。
    本表只存储「门面」展示信息，核心配置（模型/提示词/工具/技能）复用 agents 及其关联表。
    """

    __tablename__ = "expert_profiles"

    agent_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("agents.id", ondelete="CASCADE"), primary_key=True,
        comment="关联的 Agent ID（1:1）",
    )
    title: Mapped[str] = mapped_column(String(128), default="", comment="头衔")
    category: Mapped[str] = mapped_column(String(32), default="custom", index=True, comment="分类 key")
    tags: Mapped[list] = mapped_column(JSON, default=list, comment="标签数组")
    icon: Mapped[str] = mapped_column(String(64), default="", comment="图标 emoji 或图标名")
    color: Mapped[str] = mapped_column(String(128), default="", comment="头像渐变色 CSS")
    initials: Mapped[str] = mapped_column(String(8), default="", comment="头像文字")
    avatar_url: Mapped[str | None] = mapped_column(String(512), nullable=True, comment="头像图片 URL")
    rating: Mapped[float] = mapped_column(Float, default=0.0, comment="评分 0-5")
    usage_count: Mapped[int] = mapped_column(Integer, default=0, comment="使用次数")
    featured: Mapped[bool] = mapped_column(Boolean, default=False, comment="是否精选")
    scene: Mapped[str | None] = mapped_column(String(32), nullable=True, comment="所属精选场景 key")
    sort_order: Mapped[int] = mapped_column(Integer, default=0, comment="排序权重")
    is_published: Mapped[bool] = mapped_column(Boolean, default=True, comment="是否已发布")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, comment="创建时间")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow, comment="更新时间")

    # Relationship
    agent: Mapped[object] = relationship("Agent", backref="expert_profile")
