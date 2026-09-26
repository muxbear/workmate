"""知识图谱服务——基于 LangExtract 的实体/关系抽取 & 查询."""

import asyncio
import contextlib
import logging
import textwrap
import uuid
from collections.abc import Iterator
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from api.knowledge_base.doc_state import is_graph_enabled
from api.knowledge_base.entity_norm import (
    ENTITY_TYPES,
    canonical_type,
    name_key_expr,
    normalize_name,
)
from db.models.knowledge_base_entity import KnowledgeBaseEntity
from db.models.knowledge_base_relation import KnowledgeBaseRelation

logger = logging.getLogger(__name__)

#: 提示词里的类型白名单**从词表派生**，而不是再抄一遍——此前正是三处各写一份
#: （提示词 12 类、设计文档 8 类、前端配色 5 类），谁也不跟谁走。
_TYPE_WHITELIST = "、".join(ENTITY_TYPES)

_EXTRACTION_PROMPT = textwrap.dedent(f"""\
    从文本中提取实体和实体之间的关系。仅提取文本中明确出现的实体和关系，不要虚构。

    实体类型必须是以下之一: {_TYPE_WHITELIST}。
    软件框架、模型、数据集这类**具体的产物**归"产品"；技术方案、方法这类**抽象概念**归"概念"。
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
            {"extraction_class": "entity", "extraction_text": "Transformer", "attributes": {"type": "产品"}},
            {"extraction_class": "entity", "extraction_text": "Vaswani", "attributes": {"type": "人物"}},
            {"extraction_class": "entity", "extraction_text": "Self-Attention", "attributes": {"type": "算法"}},
            {"extraction_class": "entity", "extraction_text": "BERT", "attributes": {"type": "产品"}},
            {"extraction_class": "entity", "extraction_text": "Google", "attributes": {"type": "组织"}},
            {"extraction_class": "entity", "extraction_text": "GPT", "attributes": {"type": "产品"}},
            {"extraction_class": "entity", "extraction_text": "OpenAI", "attributes": {"type": "组织"}},
            {"extraction_class": "entity", "extraction_text": "HuggingFace", "attributes": {"type": "组织"}},
            {"extraction_class": "entity", "extraction_text": "Transformers", "attributes": {"type": "产品"}},
            {"extraction_class": "entity", "extraction_text": "PyTorch", "attributes": {"type": "产品"}},
            {"extraction_class": "entity", "extraction_text": "TensorFlow", "attributes": {"type": "产品"}},
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
            {"extraction_class": "entity", "extraction_text": "RAG", "attributes": {"type": "概念"}},
            {"extraction_class": "entity", "extraction_text": "Milvus", "attributes": {"type": "产品"}},
            {"extraction_class": "entity", "extraction_text": "Chroma", "attributes": {"type": "产品"}},
            {"extraction_class": "entity", "extraction_text": "Embedding", "attributes": {"type": "概念"}},
            {"extraction_class": "entity", "extraction_text": "LangChain", "attributes": {"type": "产品"}},
            {"extraction_class": "entity", "extraction_text": "LlamaIndex", "attributes": {"type": "产品"}},
            {"extraction_class": "entity", "extraction_text": "Ke-Hermes", "attributes": {"type": "产品"}},
            {"extraction_class": "entity", "extraction_text": "FastAPI", "attributes": {"type": "产品"}},
            {"extraction_class": "entity", "extraction_text": "DeepSeek", "attributes": {"type": "产品"}},
            {"extraction_class": "entity", "extraction_text": "DashScope", "attributes": {"type": "产品"}},
            {"extraction_class": "entity", "extraction_text": "LangExtract", "attributes": {"type": "产品"}},
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
        # 按**表达式**分组而不是按别名 text("from_key")：关系表里真有一列叫 from_key，
        # Postgres 会把 GROUP BY 里的 from_key 解析成那个**输入列**，与 SELECT 里的
        # coalesce(...) 表达式不匹配，直接报 GroupingError。SQLite 更宽松，所以单测
        # 全绿也放过它——这个错只有连真库跑才会露出来。
        .group_by(rel_from, rel_to, KnowledgeBaseRelation.label)
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


def _chunk_text(chunk: Any) -> str:
    """取切片正文：Document 用 ``page_content``，向量库返回的行用 ``chunk_text``。

    显式认这两种形态，**不能**靠 ``str(chunk)`` 兜底——对 dict 求 str 会得到字典的
    repr（``{'id': ..., 'chunk_text': ...}``），把库里的元数据一起喂给 LLM 抽取。
    """
    if hasattr(chunk, "page_content"):
        return chunk.page_content or ""
    if isinstance(chunk, dict):
        # `or ""` 而不是默认参数：字段存在但值为 None 时，`str(None)` 会得到字面量
        # "None" 并被当成正文喂给模型
        return chunk.get("chunk_text") or ""
    return str(chunk)


async def _replace_document_graph(
    db: AsyncSession,
    kb_id: str,
    doc_id: str,
    texts: list[str],
    entity_model: str | None,
) -> tuple[int, int]:
    """用给定文本重建**单篇文档**的图谱：删旧行 → 抽取 → 落库。

    先删后插是必须的：删掉一段切片后，那段里抽出的实体与关系必须一起消失，
    否则图谱会残留已经被用户删掉的内容。
    """
    await db.execute(
        text("DELETE FROM knowledge_base_relations WHERE kb_id = :kb_id AND doc_id = :doc_id"),
        {"kb_id": kb_id, "doc_id": doc_id},
    )
    await db.execute(
        text("DELETE FROM knowledge_base_entities WHERE kb_id = :kb_id AND doc_id = :doc_id"),
        {"kb_id": kb_id, "doc_id": doc_id},
    )
    await db.flush()

    if not texts:
        return 0, 0
    entities, relations = await GraphExtractionService().extract_entities_and_relations(
        kb_id, doc_id, texts, model_name=entity_model,
    )
    return len(entities), len(relations)


async def rebuild_graph_for_kb(
    db: AsyncSession,
    kb_config: dict | None,
    kb_id: str,
    vector_store: Any,
) -> tuple[int, int]:
    """清除 KB 下的旧实体和关系，从**已存切片**重新抽取。

    **从已存切片抽，而不是重新解析文件**（迭代 6 T6.5）：此前这里会把每篇文档重新
    解析、并按硬编码的 ``"recursive"`` 切分——而索引期用的是知识库配置里的策略。于是
    "重建出来的图谱"与"索引时的图谱"可能来自**不同的文本**，重建还要重跑一遍解析
    （慢且贵）。已存切片就是索引时真正入库的那份文本，用它既一致又便宜。

    ``vector_store`` 取不到切片时该文档会被跳过并记日志——宁可少一篇，也不要用一份
    与索引不一致的文本去改图谱。
    """
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

    entity_model = (kb_config or {}).get("entity_model")

    total_entities = 0
    total_relations = 0

    for doc in doc_rows:
        try:
            rows = await vector_store.get_chunks_by_doc_id(kb_id, doc.id)
        except Exception:
            logger.exception("取已存切片失败，跳过该文档的图谱重建 doc=%s", doc.id)
            continue
        texts = [t for t in (_chunk_text(r) for r in rows) if t.strip()]
        if not texts:
            logger.warning("文档 %s 没有可用的已存切片，跳过图谱重建", doc.id)
            continue
        try:
            entities_count, relations_count = await _replace_document_graph(
                db, kb_id, doc.id, texts, entity_model,
            )
            total_entities += entities_count
            total_relations += relations_count
            # 成功就清掉上一次的失败标记，否则界面会一直挂着旧错误
            doc.graph_error = None
        except Exception as exc:
            logger.exception("Graph rebuild failed for doc=%s", doc.id)
            # 如实落到文档行上：此前只写日志，于是"重建少了几篇"在界面上看不出来，
            # 而 KB 计数只按侥幸成功的那几篇重算，反而显得一切正常。
            doc.graph_error = f"图谱重建失败: {exc}"
            continue

    result = await get_graph_data(db, kb_id)
    kb = (
        await db.execute(select(KnowledgeBase).where(KnowledgeBase.id == kb_id))
    ).scalar_one_or_none()
    if kb:
        kb.entities_count = len(result["entities"])
        kb.relations_count = len(result["relations"])

    return total_entities, total_relations


#: 正在重抽图谱的文档，以及"跑完之后还需要再跑一次"的标记。
#:
#: 切片可能被连续编辑（`batch_operation` 一次保存多片、用户连着改好几处），每敲一次
#: 就烧一次 LLM 抽取既慢又贵。用这两个集合把连续编辑**合并**：进行中时只记一个待办，
#: 跑完再看一眼要不要补一次——最多两次抽取覆盖任意多次编辑。
_reextract_inflight: set[tuple[str, str]] = set()
_reextract_pending: set[tuple[str, str]] = set()

#: 后台重抽任务的强引用。`asyncio.create_task` 只持弱引用，不存着可能在完成前被 GC。
_reextract_tasks: set[asyncio.Task] = set()


async def reextract_document_graph(
    vector_store: Any,
    kb_id: str,
    doc_id: str,
) -> None:
    """按文档重抽图谱——从**已存切片**抽，不重新解析文件。

    自开 session（后台任务里不能借用请求的 session，请求结束它就关了），失败只记
    ``graph_error`` 与日志、**不抛**——切片编辑已经成功提交了，图谱跟不上是次要问题，
    不该反过来把用户的操作判成失败。
    """
    from db.engine import async_session
    from db.models.knowledge_base import KnowledgeBase
    from db.models.knowledge_base_document import KnowledgeBaseDocument

    try:
        async with async_session() as db:
            kb = (
                await db.execute(select(KnowledgeBase).where(KnowledgeBase.id == kb_id))
            ).scalar_one_or_none()
            if kb is None or not is_graph_enabled(kb.config):
                return
            rows = await vector_store.get_chunks_by_doc_id(kb_id, doc_id)
            texts = [t for t in (_chunk_text(r) for r in rows) if t.strip()]

            await _replace_document_graph(
                db, kb_id, doc_id, texts, (kb.config or {}).get("entity_model"),
            )
            # 文档级计数与 graph_error 一起写回：抽取成功就把上一次的失败清掉
            doc = (
                await db.execute(
                    select(KnowledgeBaseDocument).where(KnowledgeBaseDocument.id == doc_id)
                )
            ).scalar_one_or_none()
            if doc is not None:
                doc.graph_error = None
            await db.commit()

        from api.knowledge_base.doc_service import (
            recalc_doc_counters,
            recalc_kb_counters,
        )

        # 文档级计数也要重算：只更新 KB 级的话，文档行上的 entities_count 会一直
        # 停在旧值，而界面正是按它显示每篇文档的实体数。
        async with async_session() as db:
            await recalc_doc_counters(db, doc_id)
            await recalc_kb_counters(db, kb_id)
            await db.commit()
    except Exception as exc:  # noqa: BLE001 - 后台任务，任何异常都不能逃逸
        logger.exception("按文档重抽图谱失败 kb=%s doc=%s", kb_id, doc_id)
        await _record_graph_error(kb_id, doc_id, f"切片改动后的图谱重抽失败: {exc}")


async def _record_graph_error(kb_id: str, doc_id: str, message: str) -> None:
    """把重抽失败写到文档行上，让它在界面上可见（而不是只躺在日志里）。"""
    from db.engine import async_session
    from db.models.knowledge_base_document import KnowledgeBaseDocument

    try:
        async with async_session() as db:
            doc = (
                await db.execute(
                    select(KnowledgeBaseDocument).where(KnowledgeBaseDocument.id == doc_id)
                )
            ).scalar_one_or_none()
            if doc is not None:
                doc.graph_error = message
                await db.commit()
    except Exception:  # noqa: BLE001 - 记录失败时不再尝试补救，避免无限下沉
        logger.exception("写入 graph_error 失败 doc=%s", doc_id)


async def _reextract_loop(vector_store: Any, kb_id: str, doc_id: str) -> None:
    """跑重抽，并在期间又有编辑时补跑一次。"""
    key = (kb_id, doc_id)
    try:
        while True:
            _reextract_pending.discard(key)
            await reextract_document_graph(vector_store, kb_id, doc_id)
            if key not in _reextract_pending:
                return
    finally:
        _reextract_inflight.discard(key)
        _reextract_pending.discard(key)


def schedule_document_graph_reextract(
    vector_store: Any, kb_id: str, doc_id: str,
) -> bool:
    """安排"切片改动后按文档重抽图谱"，**后台执行**。

    **为什么必须是后台**：抽取是 LLM 调用，单篇几十秒到几分钟都有过（既有的一次重建
    里 7 篇有 3 篇撞上 300s 预算），而切片保存是用户在等的请求、前端走默认 15s 超时。
    放同步路径上必然"假失败"——服务端成功、界面报错。这个坑项目在文件上传上踩过一次，
    当时的结论同样是"把慢活挪出请求路径"。

    Returns:
        是否安排了新任务；已在跑（编辑被合并进这一轮）时返回 ``False``。
    """
    key = (kb_id, doc_id)
    if key in _reextract_inflight:
        _reextract_pending.add(key)
        return False
    _reextract_inflight.add(key)
    task = asyncio.create_task(_reextract_loop(vector_store, kb_id, doc_id))
    _reextract_tasks.add(task)
    task.add_done_callback(_reextract_tasks.discard)
    return True


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

    # 提成变量是为了让 SELECT 与 GROUP BY 用**同一个表达式对象**（理由见下面的 group_by）
    rel_from = name_key_expr(
        KnowledgeBaseRelation.from_key, KnowledgeBaseRelation.from_entity,
    )
    rel_to = name_key_expr(
        KnowledgeBaseRelation.to_key, KnowledgeBaseRelation.to_entity,
    )

    rel_stmt = (
        select(
            func.min(KnowledgeBaseRelation.id).label("id"),
            rel_from.label("from_key"),
            rel_to.label("to_key"),
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
        # 按**表达式**分组而不是按别名 text("from_key")：关系表里真有一列叫 from_key，
        # Postgres 会把 GROUP BY 里的 from_key 解析成那个**输入列**，与 SELECT 里的
        # coalesce(...) 表达式不匹配，直接报 GroupingError。SQLite 更宽松，所以单测
        # 全绿也放过它——这个错只有连真库跑才会露出来。
        .group_by(rel_from, rel_to, KnowledgeBaseRelation.label)
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


class GraphExtractionError(RuntimeError):
    """图谱抽取失败——调用方据此把原因记入 ``graph_error``，但**不**让文档索引失败。

    图谱是增强项、索引才是产品（见 ``doc_state.ExtractingState``）：抽取失败不该把
    整篇文档判成 failed，但也**绝不能再静默**。此前抽取函数把异常吞成 ``[], []``，
    于是"模型欠费""解析格式不匹配"这类失败全部表现为"这篇文档没有实体"，7 篇文档
    就这样在大半天里无任何错误痕迹地空着图谱。
    """


@contextlib.contextmanager
def _capture_parse_errors() -> Iterator[list[str]]:
    """临时收集 langextract 的静默解析失败。

    langextract 默认 ``suppress_parse_errors=True``：某个窗口解析不出来时，它只留一行
    ``Skipping chunk: parse error`` 日志然后返回空列表——**返回值与"这篇文档确实没有
    实体"完全一样**，调用方无从分辨。2026-09-26 实测的格式不一致（提示词要 YAML、
    解析按 JSON）正是借这条把 7 篇文档的图谱变成了静默的空。

    这里在抽取期间挂一个 handler 把那些告警收下来，让"解析失败"重新成为可上报的失败。
    匹配用的是 langextract 的告警文案；文案若变化只会让本机制退化为"没有额外信号"，
    不会引入误报。
    """
    caught: list[str] = []

    class _Collector(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            message = record.getMessage()
            lowered = message.lower()
            if "parse error" in lowered or "schema error" in lowered:
                caught.append(message)

    handler = _Collector(level=logging.WARNING)
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        yield caught
    finally:
        root.removeHandler(handler)


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

        Raises:
            GraphExtractionError: 模型不可用、抽取调用抛异常、或模型输出解析不出来。
                调用方应把原因记入 ``graph_error`` 后继续——图谱是增强项，
                但失败必须可见（``doc_state.ExtractingState`` 已按此约定处理）。
        """
        import langextract as lx

        combined = "\n\n".join(_chunk_text(c) for c in chunks)
        if not combined.strip():
            # 没有正文不是失败：空文档本来就该没有图谱
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
            logger.warning("知识库图谱抽取模型不可用: %s", exc)
            raise GraphExtractionError(f"图谱抽取模型不可用: {exc}") from exc

        config = self._build_model_config(llm_name, api_base, api_key)

        # 解析格式必须与提示词侧**同为一档**：`_build_model_config` 已把
        # `format_type=YAML` 交给 provider（模型因此按 ```yaml 围栏输出），
        # 而 `lx.extract` 的 `format_type` 若缺席会默认按 JSON 解析 —— 于是
        # "模型老老实实按 YAML 输出"反而解析失败，langextract 静默跳过该窗口，
        # 抽取结果为 0 且不报错（实测：同一片文本不传该参数得 0 条、传 YAML 得 41 条）。
        from langextract.core.data import FormatType

        try:
            with _capture_parse_errors() as parse_errors:
                result = await asyncio.to_thread(
                    lx.extract,
                    text_or_documents=combined,
                    prompt_description=_EXTRACTION_PROMPT,
                    examples=self._examples,
                    config=config,
                    use_schema_constraints=False,
                    fence_output=True,
                    format_type=FormatType.YAML,
                    max_char_buffer=2000,
                    max_workers=5,
                    extraction_passes=2,
                    show_progress=False,
                )
        except Exception as exc:
            logger.exception("LangExtract extraction failed for doc=%s", doc_id)
            raise GraphExtractionError(f"抽取调用失败: {exc}") from exc

        if isinstance(result, list):
            result = result[0] if result else None
        if not result or not result.extractions:
            if parse_errors:
                # 有内容却一条都没解析出来：这是失败，不是"这篇没有实体"
                raise GraphExtractionError(
                    f"模型输出无法解析（{len(parse_errors)} 个窗口被跳过）: {parse_errors[0]}"
                )
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
