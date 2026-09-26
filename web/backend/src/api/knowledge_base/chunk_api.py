"""切片管理 API 路由——查询/更新/删除切片。

所有接口都校验知识库访问权限：**查询类**放行本人 / 已接受分享 / 公共库
（``require_kb_readable``），**写入类**需可写（``require_kb_writable``：库主或被授予
写权限的人），
避免凭 kb_id 越权读写他人切片；写入类接口使用**知识库自身配置的**
embedding 模型重新向量化。
"""

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user_id, get_db
from api.knowledge_base.chunk_service import (
    batch_operation,
    delete_chunk,
    get_chunk_detail,
    list_chunks,
    refresh_counters_after_chunk_change,
    update_chunk,
)
from api.knowledge_base.model_provider import load_embedding_model_for_kb
from api.knowledge_base.schemas import BatchChunkRequest, ChunkUpdateRequest
from api.knowledge_base.service import require_kb_readable, require_kb_writable
from api.rbac.deps import RequirePermission
from core.audit import audit_scope
from core.rag.vector_store import safe_expr_id

router = APIRouter(prefix="/api/knowledge-bases", tags=["知识库-切片"])


def _invalid_id(field: str) -> dict:
    """路径/请求体中的主键格式非法时的统一响应（对外一律按"不存在"处理）。"""
    return {"code": 404, "data": None, "message": f"{field} 不存在或格式非法"}


def _valid_id(value: str) -> bool:
    """校验 ID 是否可以安全用于向量库查询表达式。"""
    try:
        safe_expr_id(value)
    except ValueError:
        return False
    return True


def _get_vector_store(request: Request):
    return getattr(request.app.state, "vector_store", None)


async def _resolve_embedding(
    request: Request, db: AsyncSession, kb_id: str,
) -> object | None:
    """解析该知识库应使用的 embedding 模型（回退到全局默认实例）。"""
    fallback = getattr(request.app.state, "embedding_model", None)
    return await load_embedding_model_for_kb(db, kb_id, fallback=fallback)


@router.get("/{kb_id}/documents/{doc_id}/chunks")
async def api_list_chunks(
    kb_id: str,
    doc_id: str,
    request: Request,
    search: str | None = None,
    db: AsyncSession = Depends(get_db),
    # 切片是文档正文的一部分，改切片等同改库内容
    user_id: str = Depends(RequirePermission("knowledge:upload")),
):
    """列出文档所有切片。可读即可浏览。"""
    await require_kb_readable(db, kb_id, user_id)
    if not _valid_id(doc_id):
        return _invalid_id("文档")
    vs = _get_vector_store(request)
    if vs is None:
        return {"code": 500, "data": [], "message": "向量库未初始化"}
    chunks = await list_chunks(vs, kb_id, doc_id, search)
    return {"code": 0, "data": [c.model_dump() for c in chunks], "message": "ok"}


@router.get("/{kb_id}/documents/{doc_id}/chunks/{chunk_id}")
async def api_get_chunk_detail(
    kb_id: str,
    doc_id: str,
    chunk_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    # 切片是文档正文的一部分，改切片等同改库内容
    user_id: str = Depends(RequirePermission("knowledge:upload")),
):
    """获取切片详情（含上下文）。可读即可查看。"""
    await require_kb_readable(db, kb_id, user_id)
    if not _valid_id(doc_id) or not _valid_id(chunk_id):
        return _invalid_id("切片")
    vs = _get_vector_store(request)
    if vs is None:
        return {"code": 500, "data": None, "message": "向量库未初始化"}
    try:
        detail = await get_chunk_detail(vs, kb_id, doc_id, chunk_id)
        return {"code": 0, "data": detail.model_dump(), "message": "ok"}
    except ValueError as e:
        return {"code": 404, "data": None, "message": str(e)}


@router.put("/{kb_id}/documents/{doc_id}/chunks/{chunk_id}")
async def api_update_chunk(
    kb_id: str,
    doc_id: str,
    chunk_id: str,
    body: ChunkUpdateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    # 切片是文档正文的一部分，改切片等同改库内容
    user_id: str = Depends(RequirePermission("knowledge:upload")),
):
    """更新切片内容（重新向量化）。"""
    await require_kb_writable(db, kb_id, user_id)
    if not _valid_id(doc_id) or not _valid_id(chunk_id):
        return _invalid_id("切片")
    vs = _get_vector_store(request)
    if vs is None:
        return {"code": 500, "data": None, "message": "向量库未初始化"}
    emb = await _resolve_embedding(request, db, kb_id)
    if emb is None:
        return {
            "code": 500,
            "data": None,
            "message": "未找到可用的 Embedding 模型，请在“模型”页面配置 type=embedding 的模型",
        }
    try:
        # 审计包住"改切片"这一步：异常会先被记成 failed 再原样抛出，
        # 由下面的 except 转成接口返回码——两者互不干扰
        async with audit_scope(
            "knowledge.chunk.update", user_id, request, target=chunk_id,
        ) as entry:
            entry.detail["kb_id"] = kb_id
            chunk = await update_chunk(vs, emb, kb_id, doc_id, chunk_id, body.content)
    except ValueError as e:
        return {"code": 404, "data": None, "message": str(e)}
    except Exception:
        return {"code": 500, "data": None, "message": "切片更新失败，请查看后端日志"}
    await refresh_counters_after_chunk_change(vs, db, kb_id, doc_id)
    return {"code": 0, "data": chunk.model_dump(), "message": "ok"}


@router.delete("/{kb_id}/documents/{doc_id}/chunks/{chunk_id}")
async def api_delete_chunk(
    kb_id: str,
    doc_id: str,
    chunk_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    # 切片是文档正文的一部分，改切片等同改库内容
    user_id: str = Depends(RequirePermission("knowledge:upload")),
):
    """删除单个切片。"""
    await require_kb_writable(db, kb_id, user_id)
    if not _valid_id(doc_id) or not _valid_id(chunk_id):
        return _invalid_id("切片")
    vs = _get_vector_store(request)
    if vs is None:
        return {"code": 500, "data": None, "message": "向量库未初始化"}
    try:
        async with audit_scope(
            "knowledge.chunk.delete", user_id, request, target=chunk_id,
        ) as entry:
            entry.detail["kb_id"] = kb_id
            await delete_chunk(vs, kb_id, doc_id, chunk_id)
    except ValueError as e:
        return {"code": 404, "data": None, "message": str(e)}
    await refresh_counters_after_chunk_change(vs, db, kb_id, doc_id)
    return {"code": 0, "data": None, "message": "ok"}


@router.post("/{kb_id}/documents/{doc_id}/chunks/batch")
async def api_batch_chunk_operation(
    kb_id: str,
    doc_id: str,
    body: BatchChunkRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    # 切片是文档正文的一部分，改切片等同改库内容
    user_id: str = Depends(RequirePermission("knowledge:upload")),
):
    """批量操作：保存或删除切片。"""
    await require_kb_writable(db, kb_id, user_id)
    if not _valid_id(doc_id):
        return _invalid_id("文档")
    requested_ids = (
        [c.get("id", "") for c in body.chunks]
        if body.action == "save_all"
        else list(body.chunk_ids)
    )
    if any(not _valid_id(cid) for cid in requested_ids if cid):
        return _invalid_id("切片")
    vs = _get_vector_store(request)
    if vs is None:
        return {"code": 500, "data": None, "message": "向量库未初始化"}

    emb = None
    if body.action == "save_all":
        emb = await _resolve_embedding(request, db, kb_id)
        if emb is None:
            return {
                "code": 500,
                "data": None,
                "message": "未找到可用的 Embedding 模型，请在“模型”页面配置 type=embedding 的模型",
            }

    try:
        async with audit_scope(
            f"knowledge.chunk.batch.{body.action}", user_id, request,
            target=doc_id, kb_id=kb_id, count=len(requested_ids),
        ):
            result = await batch_operation(vs, emb, kb_id, doc_id, body)
    except ValueError as e:
        return {"code": 404, "data": None, "message": str(e)}
    await refresh_counters_after_chunk_change(vs, db, kb_id, doc_id)
    return {"code": 0, "data": result, "message": "ok"}
