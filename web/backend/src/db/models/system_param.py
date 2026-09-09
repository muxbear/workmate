"""System parameter ORM model."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


class SystemParam(Base):
    """System parameter with two-level parent/child structure.

    父级参数（parent_code 为空）仅作为分组；子级参数（parent_code 指向父级
    param_code）承载实际的参数键值。
    """

    __tablename__ = "system_params"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    param_code: Mapped[str] = mapped_column(
        String(128), unique=True, nullable=False, comment="参数编码"
    )
    parent_code: Mapped[str | None] = mapped_column(
        String(128),
        nullable=True,
        index=True,
        comment="父级参数编码，为空表示父级参数",
    )
    param_label: Mapped[str] = mapped_column(
        String(128), nullable=False, comment="参数标签"
    )
    param_name: Mapped[str] = mapped_column(
        String(128), nullable=False, comment="参数名称"
    )
    param_value: Mapped[str | None] = mapped_column(
        Text, nullable=True, comment="参数值"
    )
    param_type: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default="string",
        comment="参数类型: group/string/number/boolean/json",
    )
    description: Mapped[str | None] = mapped_column(Text, nullable=True, comment="描述")
    sort_order: Mapped[int] = mapped_column(Integer, default=0, comment="同级排序")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
