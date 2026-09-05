"""Expert ORM 模型——专家独立主表（不再依赖 agents/expert_profiles）。."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from db.base import Base

if TYPE_CHECKING:
    from db.models.expert_mcp_config import ExpertMcpConfig
    from db.models.expert_skill import ExpertSkill
    from db.models.expert_tool import ExpertTool
    from db.models.expert_version import ExpertVersion


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class Expert(Base):
    """专家主表，聚合运行配置与展示元数据。.

    历史数据由 agents + expert_profiles 迁移而来，id 与原有 Agent ID
    保持一致，便于桌面端同步、技能目录与历史引用平滑过渡。
    """

    __tablename__ = "experts"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False, comment="专家名称")
    title: Mapped[str] = mapped_column(String(128), default="", comment="头衔")
    description: Mapped[str] = mapped_column(Text, default="", comment="专家描述")
    category: Mapped[str] = mapped_column(
        String(32), default="custom", index=True, comment="分类 key"
    )
    tags: Mapped[list] = mapped_column(JSON, default=list, comment="标签列表")
    icon: Mapped[str] = mapped_column(
        String(64), default="", comment="图标 emoji 或图标名"
    )
    color: Mapped[str] = mapped_column(
        String(128), default="", comment="头像渐变色 CSS"
    )
    initials: Mapped[str] = mapped_column(String(8), default="", comment="头像文字")
    avatar_url: Mapped[str | None] = mapped_column(
        String(512), nullable=True, comment="头像图片 URL"
    )
    rating: Mapped[float] = mapped_column(Float, default=0.0, comment="评分 0-5")
    usage_count: Mapped[int] = mapped_column(Integer, default=0, comment="使用次数")
    featured: Mapped[bool] = mapped_column(Boolean, default=False, comment="是否精选")
    scene: Mapped[str | None] = mapped_column(
        String(32), nullable=True, comment="精选场景 key"
    )
    sort_order: Mapped[int] = mapped_column(Integer, default=0, comment="排序权重")
    is_published: Mapped[bool] = mapped_column(
        Boolean, default=True, comment="是否已发布"
    )
    status: Mapped[str] = mapped_column(
        String(16), default="inactive", comment="状态: active/inactive"
    )
    system_prompt: Mapped[str] = mapped_column(Text, default="", comment="系统提示词")
    provider_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, comment="模型提供方 ID"
    )
    model_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, comment="AI 模型 ID"
    )
    files: Mapped[list] = mapped_column(JSON, default=list, comment="文件配置列表")
    undeletable: Mapped[bool] = mapped_column(
        Boolean, default=False, comment="是否不可删除"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=_utcnow, comment="创建时间"
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=_utcnow, onupdate=_utcnow, comment="更新时间"
    )

    # Relationships：专家关联资源随专家删除级联清理
    tool_links: Mapped[list[ExpertTool]] = relationship(
        "ExpertTool", back_populates="expert", cascade="all, delete-orphan"
    )
    skill_links: Mapped[list[ExpertSkill]] = relationship(
        "ExpertSkill", back_populates="expert", cascade="all, delete-orphan"
    )
    mcp_configs: Mapped[list[ExpertMcpConfig]] = relationship(
        "ExpertMcpConfig", back_populates="expert", cascade="all, delete-orphan"
    )
    versions: Mapped[list[ExpertVersion]] = relationship(
        "ExpertVersion", back_populates="expert", cascade="all, delete-orphan"
    )
