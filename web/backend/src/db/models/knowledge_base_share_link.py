"""知识库链接式分享（迭代 6 T6.3）。

与"用户到用户"的邀请（``knowledge_base_shares``）不同，链接分享是**凭持有即得**：
拿到 token 的人预览 + 登录接受后，落成一条普通的已接受分享行——因此后续所有读路径
（列表/检索/agent 工具）**零改动**，它们仍然只认"已接受的分享"。

token **只存 sha256 摘要**（对照 ``oauth2_refresh_token`` 的存法）：明文入库意味着
数据库泄露即等于把所有库交出去；桌面版的 ``knowledge_shares`` 是明文列，**不学它**。
明文只在创建响应里出现一次，之后无法再取回（丢了就重新生成）。
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base

#: 分享权限：只读 / 可写（可写只放开内容操作，见 service.require_kb_writable）
SHARE_PERMISSION_READ = "read"
SHARE_PERMISSION_WRITE = "write"


class KnowledgeBaseShareLink(Base):
    __tablename__ = "knowledge_base_share_links"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    kb_id: Mapped[str] = mapped_column(String(36), nullable=False)
    created_by: Mapped[str] = mapped_column(String(36), nullable=False)
    #: sha256 hex（64 字符）——不存明文
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    permission: Mapped[str] = mapped_column(
        String(16), nullable=False, default=SHARE_PERMISSION_READ,
        comment="read|write",
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    #: 软撤销：**删行会让"谁是通过链接进来的"失去痕迹**，而且已接受者不该被牵连
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    accept_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_accepted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
