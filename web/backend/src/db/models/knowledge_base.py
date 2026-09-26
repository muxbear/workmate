import uuid
from datetime import datetime

from sqlalchemy import JSON, BigInteger, Boolean, DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


class KnowledgeBase(Base):
    __tablename__ = "knowledge_bases"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="draft")
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    docs_count: Mapped[int] = mapped_column(Integer, default=0)
    chunks_count: Mapped[int] = mapped_column(Integer, default=0)
    entities_count: Mapped[int] = mapped_column(Integer, default=0)
    relations_count: Mapped[int] = mapped_column(Integer, default=0)
    size_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    visibility: Mapped[str] = mapped_column(
        String(16), default="private", comment="private 私有 | public 公共（部门范围内可只读浏览）"
    )
    #: 归属部门（创建时取创建者的部门，见 T5.2）。
    #: 用于把"公开库"的可见范围收敛到**部门范围内**，而不是全站可见；
    #: 为空表示无法判定归属（创建者没有人员档案），此时只对本人与被分享人可见。
    dept_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, index=True, comment="归属部门 ID（数据范围的判定依据）"
    )
    #: 软删除时间戳（迭代 5 T5.6）：删除知识库会清空向量与磁盘文件，误删不可逆，
    #: 因此先标记、再由人工或定期任务真正清理。为空表示未删除。
    #: **查询侧不用逐个改**：见 `db.soft_delete` 的全局过滤器——漏掉一处的后果是
    #: "删掉的库又冒出来"，那种错误很难被发现，所以做成漏不掉。
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True, index=True, comment="软删除时间；为空表示未删除"
    )
    #: 置顶与手工排序（迭代 6 T6.2）——**属于"我的列表视图偏好"**，不是知识库的
    #: 公共属性：同一个人置顶不影响别人。列表排序：is_pinned DESC, sort_order ASC,
    #: updated_at DESC。索引建在迁移里（本仓约定），ORM 侧不写 index=True。
    is_pinned: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false",
        comment="是否置顶（仅影响本人的列表顺序）",
    )
    sort_order: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0",
        comment="手工排序值，越小越靠前",
    )
    #: 自定义分组（用户私有）；删分组时置空而不是删库，见迁移 0003 的说明
    group_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
