"""知识图谱 API 路由——实体/关系查询 & 重建。"""

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user_id, get_db, get_vector_store
from api.knowledge_base.graph_service import (
    get_entity_detail,
    get_graph_data,
    rebuild_graph_for_kb,
)
from api.knowledge_base.service import (
    _get_kb_or_404,
    require_kb_readable,
)
from api.rbac.deps import RequirePermission

router = APIRouter(prefix="/api/knowledge-bases", tags=["知识库-图谱"])


@router.get("/{kb_id}/graph", response_model=dict)
async def get_graph(
    kb_id: str,
    entity_type: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user_id),
):
    """获取知识图谱数据（实体 + 关系）。可读即可查看。"""
    await require_kb_readable(db, kb_id, user_id)
    result = await get_graph_data(db, kb_id, entity_type)
    return {"code": 0, "data": result, "message": "ok"}


@router.get("/{kb_id}/graph/entities/{entity_key}", response_model=dict)
async def get_entity(
    kb_id: str,
    entity_key: str,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user_id),
):
    """获取实体详情。

    ``entity_key`` 是**归一键**（迭代 6 T6.5）——与图谱接口给出的节点 id 同一个值。
    此前这里收的是实体行的 UUID，而图谱的节点 id 是分组值 `min(行 id)`：两者口径不同，
    "点节点看详情"在构造上就对不上，只是没人调用过所以没暴露。
    """
    # 该接口此前只按 kb_id 查询、未做归属校验，等于把任意知识库的实体暴露给
    # 任何已登录用户；补上可读校验（本人 / 已接受分享 / 公共库）。
    await require_kb_readable(db, kb_id, user_id)
    result = await get_entity_detail(db, kb_id, entity_key)
    if result is None:
        return {"code": 404, "data": None, "message": "实体不存在"}
    return {"code": 0, "data": result, "message": "ok"}


@router.post("/{kb_id}/graph/re-extract", response_model=dict)
async def re_extract_graph(
    kb_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    # 重抽图谱会清掉该库现有实体与关系并用 LLM 重建：属于库级写操作
    user_id: str = Depends(RequirePermission("knowledge:edit")),
):
    """重新抽取知识图谱——遍历所有已索引文档，从**已存切片**重建实体和关系。"""
    kb = await _get_kb_or_404(db, kb_id, user_id)
    vector_store = get_vector_store(request)
    if vector_store is None:
        return {"code": 500, "data": None, "message": "向量库未就绪，无法重建图谱"}
    entities_count, relations_count = await rebuild_graph_for_kb(
        db, kb.config, kb_id, vector_store,
    )
    await db.commit()
    return {
        "code": 0,
        "data": {
            "entities": entities_count,
            "relations": relations_count,
        },
        "message": "ok",
    }
