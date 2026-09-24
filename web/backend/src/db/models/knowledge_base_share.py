"""知识库分享记录——把知识库只读授权给指定用户。

与桌面版 ``knowledge_shares``（单向链接分享，无接收方字段）不同，Web 版是
「用户到用户」的定向邀请：``grantee_id`` 指明被邀请人，``status`` 记录
待接受 / 已接受 / 已拒绝 / 已取消四种状态。
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base

# 分享状态
SHARE_STATUS_PENDING = "pending"
SHARE_STATUS_ACCEPTED = "accepted"
SHARE_STATUS_REJECTED = "rejected"
SHARE_STATUS_REVOKED = "revoked"


class KnowledgeBaseShare(Base):
    """知识库分享记录——(kb_id, grantee_id) 唯一。"""

    __tablename__ = "knowledge_base_shares"
    __table_args__ = (
        UniqueConstraint("kb_id", "grantee_id", name="uq_kb_share_kb_grantee"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    kb_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    owner_id: Mapped[str] = mapped_column(
        String(36), nullable=False, index=True, comment="分享发起者（知识库所有者）"
    )
    grantee_id: Mapped[str] = mapped_column(
        String(36), nullable=False, index=True, comment="被邀请人"
    )
    status: Mapped[str] = mapped_column(
        String(16), default=SHARE_STATUS_PENDING, comment="pending|accepted|rejected|revoked"
    )
    permission: Mapped[str] = mapped_column(
        String(16), default="read", comment="本期恒为 read（只读：查询/浏览/检索）"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
