"""知识库检索 API 路由——向量 / BM25 / 混合检索."""

import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user_id, get_db
from api.knowledge_base.schemas import SearchRequest, SearchResponse
from api.knowledge_base.service import require_kb_readable
from core.decorators import rate_limit
from core.metrics import KB_SEARCH_REQUESTS, KB_SEARCH_SECONDS

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/knowledge-bases", tags=["知识库-检索"])


@router.post("/{kb_id}/search", response_model=dict)
# 检索要打向量库 + 可能的精排/改写（都会花钱），按 IP 限流
@rate_limit(max_calls=60, period_seconds=60, key_prefix="kb_search")
async def search_knowledge_base(
    kb_id: str,
    req_body: SearchRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user_id),
):
    """在知识库中检索内容。

    支持三种检索模式:
    - hybrid: 混合检索（向量 + BM25 融合，alpha 控制权重）
    - vector: 纯向量语义检索
    - bm25: 纯关键词检索
    """
    # 检索为只读操作：本人所有 / 已接受的分享 / 公共库均可检索
    await require_kb_readable(db, kb_id, user_id)
    # 跨库检索时逐个校验——任一个不可读即拒绝，避免"顺带"读到无权限的库
    for extra_id in req_body.kb_ids or []:
        if extra_id != kb_id:
            await require_kb_readable(db, extra_id, user_id)

    orchestrator = request.app.state.search_orchestrator
    if orchestrator is None:
        raise HTTPException(status_code=503, detail="检索服务未就绪")

    started = time.perf_counter()
    try:
        result: SearchResponse = await orchestrator.search(db, kb_id, req_body)
    except ValueError as e:
        KB_SEARCH_REQUESTS.labels(mode=req_body.mode, result="invalid").inc()
        raise HTTPException(status_code=422, detail=str(e)) from e
    except RuntimeError as e:
        KB_SEARCH_REQUESTS.labels(mode=req_body.mode, result="error").inc()
        raise HTTPException(status_code=500, detail=str(e)) from e
    except Exception:
        KB_SEARCH_REQUESTS.labels(mode=req_body.mode, result="error").inc()
        logger.exception("Unhandled search error for kb=%s", kb_id)
        raise HTTPException(status_code=500, detail="检索服务内部错误") from None

    # 按模式分开记：混合/向量/关键词三路的延迟与错误率不可混为一谈
    # （纯 BM25 不打向量库，天然快得多）
    KB_SEARCH_REQUESTS.labels(mode=req_body.mode, result="success").inc()
    KB_SEARCH_SECONDS.labels(mode=req_body.mode).observe(time.perf_counter() - started)
    return {"code": 0, "data": result.model_dump(), "message": "ok"}
