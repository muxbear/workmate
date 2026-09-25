import uuid
from datetime import datetime

from sqlalchemy import JSON, BigInteger, DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


class KnowledgeBaseDocument(Base):
    __tablename__ = "knowledge_base_documents"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    kb_id: Mapped[str] = mapped_column(String(36), nullable=False)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    type: Mapped[str] = mapped_column(String(16), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    status: Mapped[str] = mapped_column(String(16), default="queued")
    progress: Mapped[int] = mapped_column(Integer, default=0)
    chunks_count: Mapped[int] = mapped_column(Integer, default=0)
    entities_count: Mapped[int] = mapped_column(Integer, default=0)
    relations_count: Mapped[int] = mapped_column(Integer, default=0)
    storage_path: Mapped[str] = mapped_column(String(512), nullable=False)
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )
    indexed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 图谱抽取失败原因——抽取失败不影响文档索引成功，此前异常被吞掉后
    #: 用户在界面上无法区分"这篇文档没有实体"与"抽取崩了"
    graph_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    config: Mapped[dict | None] = mapped_column(JSON, nullable=True, comment="文档级别的自定义索引配置")
    #: 内容哈希（原始字节的 sha256，64 位 hex）——同一知识库内按它判重，命中即跳过。
    #: 留空表示该行不参与判重（迁移前的存量文档）。**故意不加唯一约束**（理由见
    #: migrations/0002 的注释）。索引建在迁移里，ORM 侧不写 index=True：本仓索引的
    #: 事实来源是迁移文件，两处都写会让新库/老库的索引名分叉。
    content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: 来源 URL（URL/网页导入的文档才有）
    source_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
