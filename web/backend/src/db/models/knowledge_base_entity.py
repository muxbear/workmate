import uuid

from sqlalchemy import JSON, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


class KnowledgeBaseEntity(Base):
    __tablename__ = "knowledge_base_entities"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    kb_id: Mapped[str] = mapped_column(String(36), nullable=False)
    doc_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    #: 归一键（迭代 6 T6.5）——空白折叠 + 小写，见 ``api.knowledge_base.entity_norm``。
    #: 实体的**稳定身份**就是它：图谱接口的节点 id 用它，跨文档/跨大小写写法的同一个
    #: 实体靠它合并成一张节点。``name`` 保留原始写法用于展示。
    #: 可空是为了兼容迁移与代码部署之间写入的行，读侧用 coalesce 兜底（见迁移 0006）。
    name_key: Mapped[str | None] = mapped_column(String(256), nullable=True)
    type: Mapped[str] = mapped_column(String(64), nullable=False)
    mentions: Mapped[int] = mapped_column(Integer, default=0)
    metadata_: Mapped[dict] = mapped_column("metadata_", JSON, default=dict)
    source_text: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    char_start: Mapped[int | None] = mapped_column(Integer, nullable=True)
    char_end: Mapped[int | None] = mapped_column(Integer, nullable=True)
