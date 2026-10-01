"""System setting ORM model."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


class SystemSetting(Base):
    """全局系统设置，键值对存储.

    与 ``system_params``（面向管理员的通用参数树）不同，本表只承载
    运行期需要按固定语义读取的全局配置，目前仅系统标识两项：

    - ``system.name``：系统名称
    - ``system.logo``：LOGO 在产物存储中的 key（含扩展名）
    """

    __tablename__ = "system_settings"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    setting_key: Mapped[str] = mapped_column(
        String(64), unique=True, nullable=False, comment="设置键"
    )
    setting_value: Mapped[str | None] = mapped_column(
        Text, nullable=True, comment="设置值"
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
