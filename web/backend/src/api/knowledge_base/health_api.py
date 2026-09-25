"""知识库依赖健康检查——`GET /health/kb`（迭代 5 T5.5）。

回答一个具体问题：**知识库现在能不能用？不能的话卡在哪个依赖上？**

三个依赖各探一次，**任一不可用都不影响其它项的报告**（探测本身不能因为一个依赖挂了
就整体崩掉）：

- ``vector_store``：向量库连通性（Milvus / Chroma）；
- ``embedding``：embedding 模型可用性（检索与入库都要它）；
- ``reranker``：精排模型可用性（可选依赖，挂了只是不精排，**不算整体不可用**）。

返回 ``status`` 分三档，避免"一挂全红"的误报：

- ``ok``：核心依赖（向量库、embedding）都可用；
- ``degraded``：核心可用但可选依赖（reranker）不可用——检索仍可用，只是没有精排；
- ``unavailable``：核心依赖不可用。

探测都很轻（不做全量扫描），但**不缓存**：健康检查缓存的过期窗口恰好会让你在最需要
它的时候看到旧结论。调用频率由抓取方控制（Prometheus/探针通常 15~30 秒一次）。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Request

logger = logging.getLogger(__name__)

router = APIRouter(tags=["知识库-健康检查"])

STATUS_OK = "ok"
STATUS_DEGRADED = "degraded"
STATUS_UNAVAILABLE = "unavailable"


async def _check_vector_store(store) -> dict:
    """探向量库：能列集合即视为连通。"""
    if store is None:
        return {"ready": False, "detail": "向量库未初始化（应用启动时创建失败？）"}
    try:
        ready = await store.health_check()
        return {
            "ready": ready,
            "backend": type(store).__name__,
            **({} if ready else {"detail": "向量库探测未通过"}),
        }
    except Exception as exc:  # noqa: BLE001 - 健康检查只报告，不抛
        logger.warning("健康检查：向量库探测失败", exc_info=True)
        return {"ready": False, "detail": f"{type(exc).__name__}: {exc}"[:200]}


async def _check_embedding(db) -> dict:
    """探 embedding：能解析出模型实例即视为可用（不真的发起一次向量化，省配额）。"""
    try:
        from api.knowledge_base.model_provider import load_embedding_model

        model = await load_embedding_model(db)
        return {"ready": model is not None, "model": getattr(model, "model", None)}
    except Exception as exc:  # noqa: BLE001
        return {"ready": False, "detail": f"{type(exc).__name__}: {exc}"[:200]}


async def _check_reranker(db) -> dict:
    """探 reranker：可选依赖，不可用只降级不报错。"""
    try:
        from api.knowledge_base.model_provider import load_reranker_model

        model = await load_reranker_model(db)
        return {"ready": model is not None}
    except Exception as exc:  # noqa: BLE001
        return {"ready": False, "detail": f"{type(exc).__name__}: {exc}"[:200]}


@router.get("/health/kb")
async def kb_health(request: Request) -> dict:
    """知识库依赖健康检查（供探针与运维看板使用）。"""
    from db.engine import async_session

    store = getattr(request.app.state, "vector_store", None)

    async with async_session() as db:
        vector = await _check_vector_store(store)
        embedding = await _check_embedding(db)
        reranker = await _check_reranker(db)

    core_ready = vector["ready"] and embedding["ready"]
    if not core_ready:
        status = STATUS_UNAVAILABLE
    elif not reranker["ready"]:
        status = STATUS_DEGRADED
    else:
        status = STATUS_OK

    return {
        "code": 0,
        "data": {
            "status": status,
            "dependencies": {
                "vector_store": vector,
                "embedding": embedding,
                "reranker": reranker,
            },
            # 如实说明降级的影响范围，避免运维看到 degraded 就以为是故障
            "impact": _impact(status, reranker),
        },
        "message": "ok",
    }


def _impact(status: str, reranker: dict) -> str:
    if status == STATUS_OK:
        return "全部依赖可用"
    if status == STATUS_DEGRADED:
        return (
            "核心依赖可用，检索与索引正常；精排不可用，检索结果按召回顺序返回"
            f"（{reranker.get('detail', '未配置重排序模型')}）"
        )
    return "核心依赖不可用：检索与索引会失败，请先检查向量库与 embedding 模型配置"


__all__ = ["router"]
