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
        String(16), default="read", comment="read 只读 | write 可写（仅内容操作）"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    #: 有效期（迭代 6 T6.3）：为空表示永久。过期是**派生态**（读条件现算），
    #: 不写 status='expired'——否则每处消费 status 的地方都要多一个分支
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    #: 这条分享由哪条链接落成（仅溯源；不建外键，链接软撤销、永不硬删）
    link_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
