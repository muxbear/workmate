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
