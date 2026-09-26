"""知识图谱服务——基于 LangExtract 的实体/关系抽取 & 查询."""

import asyncio
import logging
import os
import textwrap
import uuid

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from api.knowledge_base.entity_norm import canonical_type, name_key_expr, normalize_name
from core.rag.loaders import create_default_loader_registry
from core.rag.splitters import create_chunk_registry
from db.models.knowledge_base_entity import KnowledgeBaseEntity
from db.models.knowledge_base_relation import KnowledgeBaseRelation

logger = logging.getLogger(__name__)

_EXTRACTION_PROMPT = textwrap.dedent("""\
    从文本中提取实体和实体之间的关系。仅提取文本中明确出现的实体和关系，不要虚构。

    实体类型必须是以下之一: 人物、组织、产品、技术、概念、算法、模型、框架、数据集、地点、时间、事件。
    每个 entity 的 extraction_text 必须是原文中出现的精确文本片段，不得改写。
    每个 entity 的 attributes 中必须包含 type 字段，写明实体类型。

    每个 relation 的 extraction_text 应为描述两个实体关系的原文片段。
    每个 relation 的 attributes 中必须包含:
      - from: 关系起始实体（必须与某个已提取 entity 的 extraction_text 完全一致）
      - to: 关系目标实体（必须与某个已提取 entity 的 extraction_text 完全一致）
      - label: 关系标签（如"开发"、"使用"、"基于"、"包含"、"发布于"、"隶属于"等）

    from 和 to 的值必须与对应 entity 的 extraction_text 精确匹配，包括标点和空格。""")

_EXTRACTION_EXAMPLES = [
    # 示例 1：企业/人物场景
    {
        "text": (
            "2024年3月，张明加入阿里巴巴达摩院，担任NLP研究科学家。"
            "他主导开发了大规模语言模型「通义千问」，该模型在多项基准测试中表现优异。"
            "阿里巴巴总部位于杭州，由马云于1999年创立。"
        ),
        "extractions": [
            {"extraction_class": "entity", "extraction_text": "张明", "attributes": {"type": "人物"}},
            {"extraction_class": "entity", "extraction_text": "阿里巴巴达摩院", "attributes": {"type": "组织"}},
            {"extraction_class": "entity", "extraction_text": "NLP研究科学家", "attributes": {"type": "概念"}},
            {"extraction_class": "entity", "extraction_text": "通义千问", "attributes": {"type": "产品"}},
            {"extraction_class": "entity", "extraction_text": "大规模语言模型", "attributes": {"type": "概念"}},
            {"extraction_class": "entity", "extraction_text": "杭州", "attributes": {"type": "地点"}},
            {"extraction_class": "entity", "extraction_text": "马云", "attributes": {"type": "人物"}},
            {"extraction_class": "entity", "extraction_text": "1999年", "attributes": {"type": "时间"}},
            {"extraction_class": "entity", "extraction_text": "2024年3月", "attributes": {"type": "时间"}},
            {"extraction_class": "relation", "extraction_text": "张明加入阿里巴巴达摩院", "attributes": {"from": "张明", "to": "阿里巴巴达摩院", "label": "任职于"}},
            {"extraction_class": "relation", "extraction_text": "张明主导开发通义千问", "attributes": {"from": "张明", "to": "通义千问", "label": "开发"}},
            {"extraction_class": "relation", "extraction_text": "阿里巴巴总部位于杭州", "attributes": {"from": "阿里巴巴达摩院", "to": "杭州", "label": "位于"}},
            {"extraction_class": "relation", "extraction_text": "马云创立阿里巴巴", "attributes": {"from": "马云", "to": "阿里巴巴达摩院", "label": "创立"}},
        ],
    },
    # 示例 2：AI/技术文档场景
    {
        "text": (
            "Transformer 架构由 Vaswani 等人在 2017 年的论文《Attention Is All You Need》中提出。"
            "该架构完全基于自注意力机制（Self-Attention），摒弃了传统的 RNN 和 CNN 结构。"
            "BERT 模型由 Google 在 2018 年发布，采用 Transformer 的编码器部分进行预训练。"
            "随后 OpenAI 推出了 GPT 系列模型，使用 Transformer 的解码器部分，"
            "在文本生成任务上取得了突破性进展。HuggingFace 提供了 Transformers 开源库，"
            "支持 PyTorch 和 TensorFlow 两大深度学习框架。"
        ),
        "extractions": [
            {"extraction_class": "entity", "extraction_text": "Transformer", "attributes": {"type": "模型"}},
            {"extraction_class": "entity", "extraction_text": "Vaswani", "attributes": {"type": "人物"}},
            {"extraction_class": "entity", "extraction_text": "Self-Attention", "attributes": {"type": "算法"}},
            {"extraction_class": "entity", "extraction_text": "BERT", "attributes": {"type": "模型"}},
            {"extraction_class": "entity", "extraction_text": "Google", "attributes": {"type": "组织"}},
            {"extraction_class": "entity", "extraction_text": "GPT", "attributes": {"type": "模型"}},
            {"extraction_class": "entity", "extraction_text": "OpenAI", "attributes": {"type": "组织"}},
            {"extraction_class": "entity", "extraction_text": "HuggingFace", "attributes": {"type": "组织"}},
            {"extraction_class": "entity", "extraction_text": "Transformers", "attributes": {"type": "框架"}},
            {"extraction_class": "entity", "extraction_text": "PyTorch", "attributes": {"type": "框架"}},
            {"extraction_class": "entity", "extraction_text": "TensorFlow", "attributes": {"type": "框架"}},
            {"extraction_class": "entity", "extraction_text": "2017 年", "attributes": {"type": "时间"}},
            {"extraction_class": "entity", "extraction_text": "2018 年", "attributes": {"type": "时间"}},
            {"extraction_class": "relation", "extraction_text": "Vaswani 等人提出 Transformer 架构", "attributes": {"from": "Vaswani", "to": "Transformer", "label": "提出"}},
            {"extraction_class": "relation", "extraction_text": "Transformer 基于 Self-Attention", "attributes": {"from": "Transformer", "to": "Self-Attention", "label": "基于"}},
            {"extraction_class": "relation", "extraction_text": "BERT 使用 Transformer 编码器", "attributes": {"from": "BERT", "to": "Transformer", "label": "基于"}},
            {"extraction_class": "relation", "extraction_text": "Google 发布 BERT", "attributes": {"from": "Google", "to": "BERT", "label": "发布"}},
            {"extraction_class": "relation", "extraction_text": "OpenAI 推出 GPT", "attributes": {"from": "OpenAI", "to": "GPT", "label": "开发"}},
            {"extraction_class": "relation", "extraction_text": "GPT 使用 Transformer 解码器", "attributes": {"from": "GPT", "to": "Transformer", "label": "基于"}},
            {"extraction_class": "relation", "extraction_text": "HuggingFace 提供 Transformers", "attributes": {"from": "HuggingFace", "to": "Transformers", "label": "开发"}},
            {"extraction_class": "relation", "extraction_text": "Transformers 支持 PyTorch", "attributes": {"from": "Transformers", "to": "PyTorch", "label": "支持"}},
            {"extraction_class": "relation", "extraction_text": "Transformers 支持 TensorFlow", "attributes": {"from": "Transformers", "to": "TensorFlow", "label": "支持"}},
        ],
    },
    # 示例 3：RAG/知识库系统场景
    {
        "text": (
            "RAG（Retrieval-Augmented Generation）系统由检索器和生成器两部分组成。"
            "检索器通常基于向量数据库（如 Milvus 或 Chroma）实现，使用 Embedding 模型"
            "将文档转换为向量进行相似度搜索。LangChain 和 LlamaIndex 是两个主流的 "
            "RAG 开发框架。本文介绍的 Ke-Hermes 系统采用 FastAPI 作为 Web 框架，"
            "使用 DeepSeek 作为大语言模型，DashScope 提供 Embedding 服务，"
            "LangExtract 负责知识图谱的实体关系抽取。"
        ),
        "extractions": [
            {"extraction_class": "entity", "extraction_text": "RAG", "attributes": {"type": "技术"}},
            {"extraction_class": "entity", "extraction_text": "Milvus", "attributes": {"type": "产品"}},
            {"extraction_class": "entity", "extraction_text": "Chroma", "attributes": {"type": "产品"}},
            {"extraction_class": "entity", "extraction_text": "Embedding", "attributes": {"type": "技术"}},
            {"extraction_class": "entity", "extraction_text": "LangChain", "attributes": {"type": "框架"}},
            {"extraction_class": "entity", "extraction_text": "LlamaIndex", "attributes": {"type": "框架"}},
            {"extraction_class": "entity", "extraction_text": "Ke-Hermes", "attributes": {"type": "产品"}},
            {"extraction_class": "entity", "extraction_text": "FastAPI", "attributes": {"type": "框架"}},
            {"extraction_class": "entity", "extraction_text": "DeepSeek", "attributes": {"type": "模型"}},
            {"extraction_class": "entity", "extraction_text": "DashScope", "attributes": {"type": "产品"}},
            {"extraction_class": "entity", "extraction_text": "LangExtract", "attributes": {"type": "框架"}},
            {"extraction_class": "relation", "extraction_text": "RAG 基于 Milvus", "attributes": {"from": "RAG", "to": "Milvus", "label": "使用"}},
            {"extraction_class": "relation", "extraction_text": "RAG 基于 Chroma", "attributes": {"from": "RAG", "to": "Chroma", "label": "使用"}},
            {"extraction_class": "relation", "extraction_text": "RAG 使用 Embedding", "attributes": {"from": "RAG", "to": "Embedding", "label": "使用"}},
            {"extraction_class": "relation", "extraction_text": "Ke-Hermes 采用 FastAPI", "attributes": {"from": "Ke-Hermes", "to": "FastAPI", "label": "基于"}},
            {"extraction_class": "relation", "extraction_text": "Ke-Hermes 使用 DeepSeek", "attributes": {"from": "Ke-Hermes", "to": "DeepSeek", "label": "使用"}},
            {"extraction_class": "relation", "extraction_text": "DashScope 提供 Embedding", "attributes": {"from": "DashScope", "to": "Embedding", "label": "提供"}},
            {"extraction_class": "relation", "extraction_text": "LangExtract 负责实体关系抽取", "attributes": {"from": "LangExtract", "to": "Ke-Hermes", "label": "应用于"}},
        ],
    },
]


def _build_example_data():
    """从字典列表构建 langextract ExampleData 对象。."""
    import langextract as lx

    examples = []
    for ex in _EXTRACTION_EXAMPLES:
        extractions = [
            lx.data.Extraction(
                extraction_class=e["extraction_class"],
                extraction_text=e["extraction_text"],
                attributes=e.get("attributes"),
            )
            for e in ex["extractions"]
        ]
        examples.append(lx.data.ExampleData(text=ex["text"], extractions=extractions))
    return examples


def _convert_extractions(extractions: list) -> tuple[list[dict], list[dict]]:
    """将 langextract 结果转为内部 entity/relation 列表，保留 source grounding 信息。."""
    entities: list[dict] = []
    relations: list[dict] = []

    for e in extractions:
        if e.char_interval is None:
            continue
        if e.extraction_class == "entity":
            entities.append(
                {
                    "name": e.extraction_text,
                    "type": (e.attributes or {}).get("type", "概念"),
                    "source_text": e.extraction_text,
                    "char_start": e.char_interval.start_pos,
                    "char_end": e.char_interval.end_pos,
                }
            )
        elif e.extraction_class == "relation":
            attrs = e.attributes or {}
            from_ent = attrs.get("from", "")
            to_ent = attrs.get("to", "")
            label = attrs.get("label", e.extraction_text)
            if from_ent and to_ent and label:
                relations.append(
                    {
                        "from": from_ent,
                        "to": to_ent,
                        "label": label,
                    }
                )

    return entities, relations


async def get_graph_data(
    db: AsyncSession,
    kb_id: str,
    entity_type: str | None = None,
) -> dict:
    """获取知识图谱数据（实体 + 关系），按**归一键**聚合跨文档的重复实体/关系。

    与旧行为的三处差别（迭代 6 T6.5）：

    1. 节点按 ``name_key`` 分组，所以 ``LangChain`` 与 ``langchain`` 是同一个节点；
       节点的 ``id`` 就是归一键——**稳定、可复现、可直接用于详情路由**。此前是
       ``min(行 id)``，与详情接口按原始行 id 查的口径对不上，"点节点看详情"在构造
       上就是断的。
    2. ``mentions`` 改为 ``count(distinct doc_id)``——"多少篇文档提到它"。此前是
       ``sum(mentions)``，而那个值因为写侧的跳过逻辑恒为 1。
    3. 关系按 ``(from_key, to_key, label)`` 分组，因此两个只差大小写的端点会并成
       一条边，边也不再引用对不上节点的 id（``source_entity_id`` 是另一套分组下的
       ``min()``，前端拿到后会把端点找不到的边静默丢掉）。
    """
    entity_key = name_key_expr(
        KnowledgeBaseEntity.name_key, KnowledgeBaseEntity.name,
    ).label("key")
    entity_stmt = (
        select(
            entity_key,
            # 展示名与类型取组内第一行（按 id 稳定排序），保证同一份数据每次渲一致
            func.min(KnowledgeBaseEntity.name).label("name"),
            func.min(KnowledgeBaseEntity.type).label("type"),
            func.count(func.distinct(KnowledgeBaseEntity.doc_id)).label("doc_count"),
        )
        .where(KnowledgeBaseEntity.kb_id == kb_id)
        .group_by(text("key"))
    )
    if entity_type:
        # 对分组后的类型过滤：此前按行过滤会把端点不在节点集里的边一起返回，
        # 前端只好自己再交一次（KbGraphTab.vue 的 filteredRelations）
        entity_stmt = entity_stmt.having(
            func.min(KnowledgeBaseEntity.type) == entity_type
        )
    entity_stmt = entity_stmt.order_by(text("doc_count DESC"))
    entity_rows = (await db.execute(entity_stmt)).all()

    rel_from = name_key_expr(
        KnowledgeBaseRelation.from_key, KnowledgeBaseRelation.from_entity,
    ).label("from_key")
    rel_to = name_key_expr(
        KnowledgeBaseRelation.to_key, KnowledgeBaseRelation.to_entity,
    ).label("to_key")
    rel_stmt = (
        select(
            func.min(KnowledgeBaseRelation.id).label("id"),
            rel_from,
            rel_to,
            func.min(KnowledgeBaseRelation.from_entity).label("from_entity"),
            func.min(KnowledgeBaseRelation.to_entity).label("to_entity"),
            KnowledgeBaseRelation.label,
            func.sum(KnowledgeBaseRelation.weight).label("weight"),
        )
        .where(KnowledgeBaseRelation.kb_id == kb_id)
        .group_by(text("from_key"), text("to_key"), KnowledgeBaseRelation.label)
        .order_by(text("weight DESC"))
    )
    relation_rows = (await db.execute(rel_stmt)).all()

    return {
        "entities": [
            {
                "id": row.key,
                "name": row.name,
                "type": row.type,
                "mentions": int(row.doc_count or 0),
            }
            for row in entity_rows
        ],
        "relations": [
            {
                "id": row.id,
                "from_key": row.from_key,
                "to_key": row.to_key,
                "from_entity": row.from_entity,
                "to_entity": row.to_entity,
                "label": row.label,
                "weight": float(row.weight or 0),
            }
            for row in relation_rows
        ],
    }


async def rebuild_graph_for_kb(
    db: AsyncSession,
    kb_config: dict | None,
    kb_id: str,
) -> tuple[int, int]:
    """清除 KB 下的旧实体和关系，从剩余已索引文档重新抽取。"""
    from db.models.knowledge_base import KnowledgeBase
    from db.models.knowledge_base_document import KnowledgeBaseDocument

    await db.execute(
        text("DELETE FROM knowledge_base_relations WHERE kb_id = :kb_id"),
        {"kb_id": kb_id},
    )
    await db.execute(
        text("DELETE FROM knowledge_base_entities WHERE kb_id = :kb_id"),
        {"kb_id": kb_id},
    )
    await db.flush()

    doc_rows = (
        await db.execute(
            select(KnowledgeBaseDocument).where(
                KnowledgeBaseDocument.kb_id == kb_id,
                KnowledgeBaseDocument.status == "indexed",
            )
        )
    ).scalars().all()

    if not doc_rows:
        kb = (
            await db.execute(select(KnowledgeBase).where(KnowledgeBase.id == kb_id))
        ).scalar_one_or_none()
        if kb:
            kb.entities_count = 0
            kb.relations_count = 0
        return 0, 0

    loader_registry = create_default_loader_registry()
    chunk_registry = create_chunk_registry(kb_config or {})
    extractor = GraphExtractionService()

    total_entities = 0
    total_relations = 0

    for doc in doc_rows:
        if not doc.storage_path or not os.path.exists(doc.storage_path):
            logger.warning("File not found for graph rebuild: %s", doc.storage_path)
            continue
        try:
            documents = loader_registry.load(doc.storage_path, doc.type)
            chunks = chunk_registry.split("recursive", documents)
            entities, relations = await extractor.extract_entities_and_relations(
                kb_id,
                doc.id,
                chunks,
                model_name=(kb_config or {}).get("entity_model"),
            )
            total_entities += len(entities)
            total_relations += len(relations)
        except Exception:
            logger.exception("Graph rebuild failed for doc=%s", doc.id)
            continue

    result = await get_graph_data(db, kb_id)
    kb = (
        await db.execute(select(KnowledgeBase).where(KnowledgeBase.id == kb_id))
    ).scalar_one_or_none()
    if kb:
        kb.entities_count = len(result["entities"])
        kb.relations_count = len(result["relations"])

    return total_entities, total_relations


async def get_entity_detail(
    db: AsyncSession, kb_id: str, entity_key: str
) -> dict | None:
    """按**归一键**取实体详情及关联关系（聚合跨文档数据）。

    入参从"原始行 id"改成归一键，是修掉"点节点看详情"断裂的关键：图谱接口给的节点
    id 是分组值，而详情按行 id 查——两者永远对不上。现在两边用的是同一个键。

    返回里带上**来源文档**：详情面板此前只能吃列表里已有的数组，看不到"这个实体
    出自哪几篇文档"，而那正是用户点开一个节点最想知道的。
    """
    from db.models.knowledge_base_document import KnowledgeBaseDocument

    entity_key = normalize_name(entity_key)
    if not entity_key:
        return None

    entity_rows = (
        await db.execute(
            select(KnowledgeBaseEntity).where(
                KnowledgeBaseEntity.kb_id == kb_id,
                KnowledgeBaseEntity.name_key == entity_key,
            )
        )
    ).scalars().all()
    if not entity_rows:
        return None

    doc_ids = {row.doc_id for row in entity_rows if row.doc_id}
    doc_names = {
        doc_id: name
        for doc_id, name in (
            await db.execute(
                select(KnowledgeBaseDocument.id, KnowledgeBaseDocument.name).where(
                    KnowledgeBaseDocument.id.in_(doc_ids)
                )
            )
        ).all()
    } if doc_ids else {}

    import sqlalchemy as sa

    rel_stmt = (
        select(
            func.min(KnowledgeBaseRelation.id).label("id"),
            name_key_expr(
                KnowledgeBaseRelation.from_key, KnowledgeBaseRelation.from_entity,
            ).label("from_key"),
            name_key_expr(
                KnowledgeBaseRelation.to_key, KnowledgeBaseRelation.to_entity,
            ).label("to_key"),
            func.min(KnowledgeBaseRelation.from_entity).label("from_entity"),
            func.min(KnowledgeBaseRelation.to_entity).label("to_entity"),
            KnowledgeBaseRelation.label,
            func.sum(KnowledgeBaseRelation.weight).label("weight"),
        )
        .where(
            KnowledgeBaseRelation.kb_id == kb_id,
            sa.or_(
                KnowledgeBaseRelation.from_key == entity_key,
                KnowledgeBaseRelation.to_key == entity_key,
            ),
        )
        .group_by(text("from_key"), text("to_key"), KnowledgeBaseRelation.label)
        .order_by(text("weight DESC"))
    )
    rel_rows = (await db.execute(rel_stmt)).all()

    # 展示名取组内最早写入的那一行（按 id 稳定），保证同一实体每次渲染同一个写法
    display = sorted(entity_rows, key=lambda r: r.id)[0]

    return {
        "id": entity_key,
        "name": display.name,
        "type": display.type,
        "mentions": len(doc_ids) or len(entity_rows),
        "metadata_": display.metadata_,
        "source_text": display.source_text,
        "documents": [
            {"id": doc_id, "name": doc_names.get(doc_id, "")}
            for doc_id in sorted(doc_ids)
        ],
        "relations": [
            {
                "id": row.id,
                "from_key": row.from_key,
                "to_key": row.to_key,
                "from_entity": row.from_entity,
                "to_entity": row.to_entity,
                "label": row.label,
                "weight": float(row.weight or 0),
            }
            for row in rel_rows
        ],
    }


class GraphExtractionService:
    """实体/关系抽取服务——使用 LangExtract 框架。."""

    def __init__(self) -> None:
        """初始化抽取服务，构建 few-shot 示例."""
        self._examples = _build_example_data()

    def _build_model_config(self, model_name: str, api_base: str, api_key: str):
        """构建连接指定 LLM 的 ModelConfig（OpenAI 兼容模式）。.

        OpenAI 兼容服务不支持 response_format 参数时，通过 format_type=YAML
        阻止发送该参数。实际输出仍由 lx.extract 的 format_type 控制为 JSON。
        """
        from langextract.core.data import FormatType
        from langextract.factory import ModelConfig

        return ModelConfig(
            model_id=model_name,
            provider="openai",
            provider_kwargs={
                "api_key": api_key,
                "base_url": api_base,
                "format_type": FormatType.YAML,
            },
        )

    async def extract_entities_and_relations(
        self,
        kb_id: str,
        doc_id: str,
        chunks: list,
        model_name: str | None = None,
        provider_id: str | None = None,
    ) -> tuple[list[dict], list[dict]]:
        """使用 LangExtract 从文档分片中抽取实体和关系。.

        合并 chunks 文本，通过 lx.extract() 调用 LLM 进行结构化抽取，
        再利用 asyncio.to_thread 避免阻塞事件循环。
        """
        import langextract as lx

        combined = "\n\n".join(
            c.page_content if hasattr(c, "page_content") else str(c) for c in chunks
        )
        if not combined.strip():
            return [], []

        from api.knowledge_base.model_provider import load_llm_model
        from db.engine import async_session
        try:
            async with async_session() as session:
                llm_name, api_base, api_key = await load_llm_model(
                    session,
                    model_name=model_name,
                    provider_id=provider_id,
                )
        except RuntimeError as exc:
            logger.warning("知识库图谱抽取模型不可用，跳过: %s", exc)
            return [], []

        config = self._build_model_config(llm_name, api_base, api_key)

        try:
            result = await asyncio.to_thread(
                lx.extract,
                text_or_documents=combined,
                prompt_description=_EXTRACTION_PROMPT,
                examples=self._examples,
                config=config,
                use_schema_constraints=False,
                fence_output=True,
                max_char_buffer=2000,
                max_workers=5,
                extraction_passes=2,
                show_progress=False,
            )
        except Exception:
            logger.exception("LangExtract extraction failed for doc=%s", doc_id)
            return [], []

        if isinstance(result, list):
            result = result[0] if result else None
        if not result or not result.extractions:
            return [], []

        entities, relations = _convert_extractions(result.extractions)

        grounded = sum(1 for e in result.extractions if e.char_interval is not None)
        logger.info(
            "Extracted %d entities, %d relations for doc=%s (%d/%d grounded)",
            len(entities),
            len(relations),
            doc_id,
            grounded,
            len(result.extractions),
        )

        await self._persist(kb_id, doc_id, entities, relations)
        return entities, relations

    async def _persist(
        self,
        kb_id: str,
        doc_id: str,
        entities: list[dict],
        relations: list[dict],
    ) -> None:
        """将实体和关系写入数据库，关系引用实体 ID 而非仅名称。."""
        from db.engine import async_session

        async with async_session() as db:
            try:
                # Phase 1: Upsert 实体，构建 name_key -> id 映射
                #
                # 查重键用**归一键**而不是原始名：`LangChain` 与 `langchain` 是同一个
                # 实体，写成两行就是此前实测到的"并存"缺陷。展示名保留首次出现的写法。
                entity_map: dict[str, str] = {}
                name_by_key: dict[str, str] = {}
                for e in entities:
                    name = e.get("name", "").strip()
                    key = normalize_name(name)
                    if not key:
                        continue
                    if key in entity_map:
                        continue

                    existing = (
                        await db.execute(
                            select(KnowledgeBaseEntity).where(
                                KnowledgeBaseEntity.kb_id == kb_id,
                                KnowledgeBaseEntity.doc_id == doc_id,
                                KnowledgeBaseEntity.name_key == key,
                            )
                        )
                    ).scalar_one_or_none()

                    if existing:
                        # 不再自增 mentions：它的语义已改为"多少篇文档提到"，由读侧
                        # count(distinct doc_id) 现算。留着自增会诱导下一个人以为它在
                        # 计数——而它恒为 1 的原因正是这里（同一文档内的重复被上面的
                        # 跳过挡掉了）。
                        entity_map[key] = existing.id
                        name_by_key[key] = existing.name
                    else:
                        ent_id = str(uuid.uuid4())
                        db.add(
                            KnowledgeBaseEntity(
                                id=ent_id,
                                kb_id=kb_id,
                                doc_id=doc_id,
                                name=name,
                                name_key=key,
                                type=canonical_type(e.get("type")),
                                mentions=1,
                                source_text=e.get("source_text"),
                                char_start=e.get("char_start"),
                                char_end=e.get("char_end"),
                            )
                        )
                        entity_map[key] = ent_id
                        name_by_key[key] = name

                await db.flush()  # 确保实体 ID 已持久化

                # Phase 2: Upsert 关系，使用实体 ID
                for r in relations:
                    from_key = normalize_name(r.get("from"))
                    to_key = normalize_name(r.get("to"))
                    label = r.get("label", "").strip()
                    if not from_key or not to_key or not label:
                        continue

                    source_id = entity_map.get(from_key)
                    target_id = entity_map.get(to_key)

                    if not source_id or not target_id:
                        logger.warning(
                            "跳过关系 '%s' -> '%s': 实体端点未找到",
                            r.get("from"), r.get("to"),
                        )
                        continue

                    # 端点写归一后的展示名：读侧按 key 分组、展示用 name，两者要一致，
                    # 否则同一个实体在图上会出现两种写法。
                    from_name = name_by_key.get(from_key, r.get("from", "").strip())
                    to_name = name_by_key.get(to_key, r.get("to", "").strip())

                    existing_rel = (
                        await db.execute(
                            select(KnowledgeBaseRelation).where(
                                KnowledgeBaseRelation.kb_id == kb_id,
                                KnowledgeBaseRelation.doc_id == doc_id,
                                KnowledgeBaseRelation.from_key == from_key,
                                KnowledgeBaseRelation.to_key == to_key,
                                KnowledgeBaseRelation.label == label,
                            )
                        )
                    ).scalar_one_or_none()

                    if existing_rel:
                        existing_rel.weight = (existing_rel.weight or 1.0) + 1.0
                        if existing_rel.source_entity_id is None:
                            existing_rel.source_entity_id = source_id
                        if existing_rel.target_entity_id is None:
                            existing_rel.target_entity_id = target_id
                    else:
                        db.add(
                            KnowledgeBaseRelation(
                                id=str(uuid.uuid4()),
                                kb_id=kb_id,
                                doc_id=doc_id,
                                from_entity=from_name,
                                to_entity=to_name,
                                from_key=from_key,
                                to_key=to_key,
                                label=label,
                                weight=1.0,
                                source_entity_id=source_id,
                                target_entity_id=target_id,
                            )
                        )

                await db.commit()
            except Exception:
                await db.rollback()
                logger.exception(
                    "Failed to persist entities/relations for kb=%s", kb_id
                )
