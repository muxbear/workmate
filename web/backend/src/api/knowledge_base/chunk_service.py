"""切片业务逻辑——查询/更新/删除文档切片。"""

import logging

from api.knowledge_base.schemas import (
    BatchChunkRequest,
    ChunkDetailResponse,
    ChunkResponse,
)
from core.rag.vector_store import BaseVectorStore

logger = logging.getLogger(__name__)


def _build_chunk_response(raw: dict, fallback_index: int = 0) -> ChunkResponse:
    """将 Milvus 原始记录转为前端 ChunkResponse。"""
    text = raw.get("chunk_text", "")
    meta = raw.get("metadata_", {}) or {}
    return ChunkResponse(
        id=raw.get("id", ""),
        index=raw.get("chunk_index", fallback_index),
        content=text,
        token_count=max(1, len(text) // 2),
        char_count=len(text),
        page_ref=meta.get("page", meta.get("page_ref", "")),
        section=meta.get("section", meta.get("h1", meta.get("h2", ""))),
        entities=meta.get("entities", []),
    )


async def list_chunks(
    vector_store: BaseVectorStore,
    kb_id: str,
    doc_id: str,
    search: str | None = None,
) -> list[ChunkResponse]:
    """列出文档所有切片，支持本地搜索过滤。"""
    raws = await vector_store.get_chunks_by_doc_id(kb_id, doc_id)
    chunks = [_build_chunk_response(r) for r in raws]

    if search:
        q = search.lower()
        chunks = [
            c for c in chunks
            if q in c.content.lower() or q in c.section.lower()
        ]

    return chunks


async def get_chunk_detail(
    vector_store: BaseVectorStore,
    kb_id: str,
    doc_id: str,
    chunk_id: str,
) -> ChunkDetailResponse:
    """获取切片详情 + 上下文（前一/后一切片）。"""
    all_raws = await vector_store.get_chunks_by_doc_id(kb_id, doc_id)

    target: dict | None = None
    prev_raw: dict | None = None
    next_raw: dict | None = None

    for i, r in enumerate(all_raws):
        if r.get("id") == chunk_id:
            target = r
            if i > 0:
                prev_raw = all_raws[i - 1]
            if i < len(all_raws) - 1:
                next_raw = all_raws[i + 1]
            break

    if target is None:
        raise ValueError(f"Chunk not found: {chunk_id}")

    return ChunkDetailResponse(
        chunk=_build_chunk_response(target),
        prev_chunk=_build_chunk_response(prev_raw) if prev_raw else None,
        next_chunk=_build_chunk_response(next_raw) if next_raw else None,
    )


async def _load_chunk_in_doc(
    vector_store: BaseVectorStore,
    kb_id: str,
    doc_id: str,
    chunk_id: str,
) -> dict:
    """取出切片并校验它确实属于 ``doc_id``。

    路径里的 ``doc_id`` 与 ``chunk_id`` 此前互不校验，改一份文档的切片时可以传
    另一份文档的 chunk_id（同库内跨文档改写/删除）。

    Raises:
        ValueError: 切片不存在或不属于给定文档。
    """
    raws = await vector_store.get_chunks_by_ids(kb_id, [chunk_id])
    if not raws:
        raise ValueError(f"Chunk not found: {chunk_id}")
    chunk = raws[0]
    owner_doc = chunk.get("doc_id", "")
    if owner_doc and owner_doc != doc_id:
        raise ValueError(f"Chunk not found: {chunk_id}")
    return chunk


async def update_chunk(
    vector_store: BaseVectorStore,
    embedding_model,
    kb_id: str,
    doc_id: str,
    chunk_id: str,
    content: str,
) -> ChunkResponse:
    """更新切片内容 → 重新向量化 → 更新 Milvus。"""
    await _load_chunk_in_doc(vector_store, kb_id, doc_id, chunk_id)
    new_embedding = (await embedding_model.aembed_documents([content]))[0]
    await vector_store.update_chunk(kb_id, chunk_id, content, new_embedding)
    return ChunkResponse(
        id=chunk_id,
        index=0,
        content=content,
        token_count=max(1, len(content) // 2),
        char_count=len(content),
    )


async def delete_chunk(
    vector_store: BaseVectorStore,
    kb_id: str,
    doc_id: str,
    chunk_id: str,
) -> None:
    """删除单个切片（校验切片归属后再删）。"""
    await _load_chunk_in_doc(vector_store, kb_id, doc_id, chunk_id)
    await vector_store.delete_chunk_by_id(kb_id, chunk_id)


async def refresh_counters_after_chunk_change(
    vector_store: BaseVectorStore,
    db,
    kb_id: str,
    doc_id: str,
) -> None:
    """切片增删改后同步计数（并提交事务）。

    切片是直接改向量库的，关系库里的 ``chunks_count`` 只是快照——不重算就会一直
    虚高，知识库的分片总数也跟着错（此前切片级增删改完全不更新任何计数）。
    """
    from sqlalchemy import select

    from api.knowledge_base.doc_service import recalc_doc_counters, recalc_kb_counters
    from db.models.knowledge_base_document import KnowledgeBaseDocument

    try:
        rows = await vector_store.get_chunks_by_doc_id(kb_id, doc_id)
        doc = (
            await db.execute(
                select(KnowledgeBaseDocument).where(KnowledgeBaseDocument.id == doc_id)
            )
        ).scalar_one_or_none()
        if doc is not None:
            doc.chunks_count = len(rows)
    except Exception:  # noqa: BLE001 - 计数校正失败不应让写操作报错
        logger.warning("重算切片数失败 kb=%s doc=%s", kb_id, doc_id, exc_info=True)

    await recalc_doc_counters(db, doc_id)
    await recalc_kb_counters(db, kb_id)
    await db.commit()

    # 图谱跟着切片改动走（迭代 6 T6.5）。**后台执行**：抽取是 LLM 调用，单篇几十秒到
    # 几分钟，而这里是用户在等的请求、前端走默认 15s 超时——同步做必然"假失败"（服务端
    # 成功、界面报错）。安排失败同样只记日志，不影响已经提交的切片操作。
    try:
        from api.knowledge_base.graph_service import schedule_document_graph_reextract

        schedule_document_graph_reextract(vector_store, kb_id, doc_id)
    except Exception:  # noqa: BLE001 - 图谱是次要派生数据，不该反过来让切片操作失败
        logger.warning("安排图谱重抽失败 kb=%s doc=%s", kb_id, doc_id, exc_info=True)


async def batch_operation(
    vector_store: BaseVectorStore,
    embedding_model,
    kb_id: str,
    doc_id: str,
    req: BatchChunkRequest,
) -> dict:
    """批量操作：保存所有编辑 或 批量删除。"""
    if req.action == "save_all":
        saved = 0
        for ch in req.chunks:
            chunk_id = ch.get("id", "")
            content = ch.get("content", "")
            if chunk_id and content:
                await update_chunk(
                    vector_store, embedding_model, kb_id, doc_id, chunk_id, content,
                )
                saved += 1
        return {"saved": saved, "deleted": 0}

    if req.action == "delete":
        deleted = 0
        for chunk_id in req.chunk_ids:
            if chunk_id:
                await delete_chunk(vector_store, kb_id, doc_id, chunk_id)
                deleted += 1
        return {"saved": 0, "deleted": deleted}

    raise ValueError(f"Unknown batch action: {req.action}")
