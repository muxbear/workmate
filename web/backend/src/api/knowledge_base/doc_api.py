"""文档管理 API 路由——上传/列表/详情/删除/重试/取消/进度流。"""

import asyncio
import json

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
)
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user_id, get_db
from api.knowledge_base.doc_service import (
    cancel_document,
    delete_document,
    get_document,
    list_documents,
    retry_document,
    upload_documents,
)
from api.knowledge_base.indexing_events import IndexingEventBus
from api.knowledge_base.schemas import IndexConfigSchema
from api.knowledge_base.service import require_kb_readable

router = APIRouter(prefix="/api/knowledge-bases", tags=["知识库-文档"])


def _get_scheduler(request: Request):
    return getattr(request.app.state, "scheduler", None)


def _get_vector_store(request: Request):
    return getattr(request.app.state, "vector_store", None)


def _get_mediator(request: Request):
    """从 app state 获取知识库中介者。"""
    return getattr(request.app.state, "kb_mediator", None)


@router.post("/{kb_id}/documents/upload", response_model=dict)
async def upload_docs(
    kb_id: str,
    request: Request,
    files: list[UploadFile] = File(..., max_count=20),
    config: str | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user_id),
):
    """向指定知识库批量上传文档（最多 20 个），落盘、写库，并异步触发索引流水线。"""
    if not files:
        return {"code": 400, "data": None, "message": "请选择文件"}

    custom_config: dict | None = None
    if config:
        try:
            custom_config = json.loads(config)
            IndexConfigSchema.model_validate(custom_config)
        except (json.JSONDecodeError, ValueError) as e:
            return {"code": 400, "data": None, "message": f"索引配置无效: {e}"}

    scheduler = _get_scheduler(request)
    result = await upload_documents(db, kb_id, user_id, files, scheduler, custom_config)
    await db.commit()
    return {
        "code": 0,
        "data": [r.model_dump(mode="json") for r in result],
        "message": "ok",
    }


@router.get("/{kb_id}/documents", response_model=dict)
async def list_docs(
    kb_id: str,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    search: str | None = Query(default=None),
    status: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user_id),
):
    """获取文档列表。"""
    result = await list_documents(db, kb_id, user_id, page, page_size, search, status)
    return {"code": 0, "data": result, "message": "ok"}


@router.get("/{kb_id}/documents/{doc_id}", response_model=dict)
async def get_doc(
    kb_id: str,
    doc_id: str,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user_id),
):
    """获取文档详情（含索引流水线状态）。"""
    result = await get_document(db, kb_id, doc_id, user_id)
    return {"code": 0, "data": result.model_dump(mode="json"), "message": "ok"}


@router.delete("/{kb_id}/documents/{doc_id}", response_model=dict)
async def delete_doc(
    kb_id: str,
    doc_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user_id),
):
    """删除文档（先取消在跑的索引任务，再清理向量/文件/图谱）。"""
    vector_store = _get_vector_store(request)
    mediator = _get_mediator(request)
    await delete_document(
        db, kb_id, doc_id, user_id, vector_store,
        mediator=mediator, scheduler=_get_scheduler(request),
    )
    await db.commit()
    return {"code": 0, "data": None, "message": "ok"}


@router.post("/{kb_id}/documents/{doc_id}/retry", response_model=dict)
async def retry_doc(
    kb_id: str,
    doc_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user_id),
):
    """重试索引（失败 / 已取消 / 卡在中间态的文档均可）。"""
    scheduler = _get_scheduler(request)
    vector_store = _get_vector_store(request)
    result = await retry_document(
        db, kb_id, doc_id, user_id, scheduler, vector_store=vector_store,
    )
    return {"code": 0, "data": result.model_dump(mode="json"), "message": "ok"}


@router.post("/{kb_id}/documents/{doc_id}/cancel", response_model=dict)
async def cancel_doc(
    kb_id: str,
    doc_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user_id),
):
    """取消文档的索引任务（排队中或执行中均可）。"""
    scheduler = _get_scheduler(request)
    vector_store = _get_vector_store(request)
    result = await cancel_document(
        db, kb_id, doc_id, user_id, scheduler, vector_store=vector_store,
    )
    return {"code": 0, "data": result.model_dump(mode="json"), "message": "ok"}


@router.get("/{kb_id}/indexing/stream")
async def stream_indexing(
    kb_id: str,
    request: Request,
    token: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    """知识库索引进度事件流（SSE）。

    EventSource 无法自定义请求头，因此 token 走查询参数（与通知流一致）。
    前端订阅后只需增量更新收到的文档状态，不必再每 5 秒轮询整张列表。
    """
    from core.security import decode_token

    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = decode_token(token, "access")
    except Exception as exc:  # noqa: BLE001 - 令牌无效一律按未认证处理
        raise HTTPException(status_code=401, detail="Invalid token") from exc
    user_id = str(payload["sub"])
    await require_kb_readable(db, kb_id, user_id)

    queue = IndexingEventBus.subscribe(kb_id)

    async def event_generator():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"
                except TimeoutError:
                    # 心跳：防止中间代理把空闲连接掐断
                    yield ": ping\n\n"
        finally:
            IndexingEventBus.unsubscribe(kb_id, queue)

    return StreamingResponse(event_generator(), media_type="text/event-stream")
