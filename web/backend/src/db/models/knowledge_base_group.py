"""知识库自定义分组（迭代 6 T6.2）。

分组是**用户私有**的：同一个人可以把同一个库归到"产品资料"或"运维手册"，别人
不受影响。因此 user_id 挂在这里，而不是把分组做成知识库的全局属性。
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


class KnowledgeBaseGroup(Base):
    __tablename__ = "knowledge_base_groups"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    # 注：``uq_kb_group_user_name`` 这个唯一索引只建在迁移里（本仓的约定是
    # "索引的事实来源是迁移文件"），ORM 侧刻意不写 UniqueConstraint，否则新库走
    # create_all 会建出另一个名字的索引，两份 schema 从此分叉。
