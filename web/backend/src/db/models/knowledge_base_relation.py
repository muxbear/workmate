import uuid

from sqlalchemy import Float, String
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


class KnowledgeBaseRelation(Base):
    __tablename__ = "knowledge_base_relations"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    kb_id: Mapped[str] = mapped_column(String(36), nullable=False)
    doc_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    from_entity: Mapped[str] = mapped_column(String(256), nullable=False)
    to_entity: Mapped[str] = mapped_column(String(256), nullable=False)
    #: 两端的归一键（迭代 6 T6.5）。关系存的是端点的**名字**而不是外键，所以键就是
    #: 那个名字的归一形式。读侧按 (from_key, to_key, label) 分组——两个只差大小写的
    #: 端点于是自动并成一条边，边也永远能对上节点（这是此前边被前端静默丢弃的成因）。
    from_key: Mapped[str | None] = mapped_column(String(256), nullable=True)
    to_key: Mapped[str | None] = mapped_column(String(256), nullable=True)
    label: Mapped[str] = mapped_column(String(256), nullable=False)
    weight: Mapped[float] = mapped_column(Float, default=1.0)
    source_entity_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    target_entity_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
