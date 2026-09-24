"""知识库检索工具——供 Agent 在对话中搜索已索引的知识库内容。

**权限边界**：所有查询都限定在当前会话用户（从运行时上下文读取 ``user_id``）
**可读**的知识库范围内——即「自己创建的 ∪ 已接受的分享 ∪ 公共库」，与
``api.knowledge_base.service._readable_condition`` 共用同一条判定，避免两套
权限口径漂移。即使模型自行编造或猜中了他人的 ``kb_id``，也会被拒绝——此前该
工具只按 ``kb_id`` 查询，且缺省时会「自动取第一个 ready 的知识库」，等于把
其他用户的知识库暴露给任意会话。
"""

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)


def _current_user_id() -> str:
    """从 LangGraph 运行时上下文读取当前用户 ID；不可用时返回空串。"""
    try:
        from langgraph.runtime import get_runtime

        runtime = get_runtime()
        context = getattr(runtime, "context", None) if runtime is not None else None
        return str(getattr(context, "user_id", "") or "")
    except Exception:
        logger.debug("读取运行时上下文失败", exc_info=True)
        return ""


def kb_search(
    query: str,
    kb_id: str = "",
    kb_name: str = "",
    mode: str = "hybrid",
    top_k: int = 5,
) -> dict[str, Any]:
    """搜索知识库中的内容，支持混合检索、向量检索和 BM25 关键词检索。

    只能检索当前用户可读的知识库（自己的、别人分享给自己且已接受的、公共库）。
    调用前请先用 list_knowledge_bases 获取可用的知识库列表，再传入正确的 kb_id。
    如果不知道 kb_id，可以传入 kb_name 按名称匹配。

    Args:
        query: 搜索查询，使用关键词而非完整句子。
        kb_id: 知识库 ID（优先使用）。不知道时传空字符串，通过 kb_name 匹配。
        kb_name: 知识库名称（模糊匹配）。仅 kb_id 为空时生效。
        mode: 检索模式，"hybrid"（RRF 混合，推荐）、"vector"（语义）、"bm25"（关键词）。
        top_k: 返回结果数量，默认 5。

    Returns:
        {"total": int, "results": [{"doc": str, "content": str, "score": float, ...}]}
        如果 kb_id 无效，返回 {"error": str, "available_kbs": [...]}
    """
    return asyncio.run(_kb_search_async(query, kb_id, kb_name, mode, top_k))


async def _load_readable_kbs(user_id: str) -> list[Any]:
    """列出该用户可读且 ready 状态的知识库。"""
    from sqlalchemy import select

    from api.knowledge_base.service import _readable_condition
    from db.engine import async_session
    from db.models.knowledge_base import KnowledgeBase

    async with async_session() as db:
        return list(
            (
                await db.execute(
                    select(KnowledgeBase).where(
                        _readable_condition(user_id),
                        KnowledgeBase.status == "ready",
                    )
                )
            ).scalars().all()
        )


def _summarize_kbs(rows: list[Any]) -> list[dict[str, Any]]:
    return [
        {"kb_id": r.id, "name": r.name, "docs": r.docs_count or 0}
        for r in rows
    ]


async def _resolve_kb_id(user_id: str, kb_id: str, kb_name: str) -> tuple[str, dict | None]:
    """解析并校验知识库可读性。

    Returns:
        ``(kb_id, error_payload)``——解析失败时 kb_id 为空串，error_payload 为提示。
    """
    from sqlalchemy import select

    from api.knowledge_base.service import _readable_condition
    from db.engine import async_session
    from db.models.knowledge_base import KnowledgeBase

    resolved = kb_id.strip()
    if resolved:
        async with async_session() as db:
            owned = (
                await db.execute(
                    select(KnowledgeBase).where(
                        KnowledgeBase.id == resolved,
                        _readable_condition(user_id),
                    )
                )
            ).scalar_one_or_none()
        if owned is not None:
            return resolved, None

        available = await _load_readable_kbs(user_id)
        return "", {
            "error": f"知识库 {resolved} 不存在或当前用户无权访问。",
            "available_kbs": _summarize_kbs(available),
            "total": 0,
            "results": [],
            "hint": "请先调用 list_knowledge_bases 查看当前用户可用的知识库，再用正确的 kb_id 重新调用。",
        }

    async with async_session() as db:
        if kb_name.strip():
            rows = list(
                (
                    await db.execute(
                        select(KnowledgeBase).where(
                            KnowledgeBase.name.contains(kb_name.strip()),
                            _readable_condition(user_id),
                            KnowledgeBase.status == "ready",
                        )
                    )
                ).scalars().all()
            )
        else:
            rows = list(
                (
                    await db.execute(
                        select(KnowledgeBase).where(
                            _readable_condition(user_id),
                            KnowledgeBase.status == "ready",
                        ).limit(1)
                    )
                ).scalars().all()
            )

    if rows:
        return rows[0].id, None

    available = await _load_readable_kbs(user_id)
    return "", {
        "error": (
            f"未找到匹配的知识库'{kb_name}'。"
            if kb_name.strip()
            else "未指定知识库且当前用户没有 ready 状态的知识库。"
        ),
        "available_kbs": _summarize_kbs(available),
        "total": 0,
        "results": [],
        "hint": "请先调用 list_knowledge_bases 查看可用的知识库，然后用正确的 kb_id 重新调用 kb_search。",
    }


async def _kb_search_async(
    query: str, kb_id: str, kb_name: str, mode: str, top_k: int
) -> dict[str, Any]:
    from api.knowledge_base.schemas import SearchRequest
    from api.knowledge_base.search_service import get_search_orchestrator
    from db.engine import async_session

    orch = get_search_orchestrator()
    if orch is None:
        return {"error": "搜索服务未就绪，请稍后重试", "total": 0, "results": []}

    if not query.strip():
        return {"total": 0, "results": []}

    user_id = _current_user_id()
    if not user_id:
        # 无会话上下文时无法判定归属，拒绝检索而不是放行
        logger.warning("kb_search 缺少用户上下文，已拒绝检索")
        return {
            "error": "缺少用户会话上下文，无法确定知识库访问权限。",
            "total": 0,
            "results": [],
        }

    resolved_id, error_payload = await _resolve_kb_id(user_id, kb_id, kb_name)
    if not resolved_id:
        return error_payload or {"error": "未解析到知识库", "total": 0, "results": []}

    req = SearchRequest(query=query.strip(), mode=mode, top_k=top_k)

    async with async_session() as db:
        try:
            resp = await orch.search(db, resolved_id, req)
        except RuntimeError as e:
            available = await _load_readable_kbs(user_id)
            return {
                "error": f"检索失败（kb_id={resolved_id}）：{e}",
                "available_kbs": _summarize_kbs(available),
                "total": 0,
                "results": [],
                "hint": "该知识库可能不存在或未完成索引，请使用 list_knowledge_bases 确认可用的知识库。",
            }

        return {
            "total": resp.total,
            "results": [
                {
                    "doc": r.doc_name,
                    "content": r.content,
                    "score": r.score,
                    "vec_score": r.vec_score,
                    "bm25_score": r.bm25_score,
                }
                for r in resp.results
            ],
        }


def list_knowledge_bases() -> dict[str, Any]:
    """列出当前用户可用的知识库及其 ID（含公共库与已接受的分享）。

    Returns:
        {"total": int, "knowledge_bases": [{"kb_id": str, "name": str, "docs": int, "chunks": int}]}
    """
    return asyncio.run(_list_kb_async())


async def _list_kb_async() -> dict[str, Any]:
    from sqlalchemy import select

    from api.knowledge_base.service import _readable_condition
    from db.engine import async_session
    from db.models.knowledge_base import KnowledgeBase

    user_id = _current_user_id()
    if not user_id:
        logger.warning("list_knowledge_bases 缺少用户上下文，已拒绝查询")
        return {"total": 0, "knowledge_bases": [], "error": "缺少用户会话上下文"}

    async with async_session() as db:
        rows = (
            await db.execute(
                select(KnowledgeBase).where(
                    _readable_condition(user_id),
                    KnowledgeBase.status == "ready",
                )
            )
        ).scalars().all()

    return {
        "total": len(rows),
        "knowledge_bases": [
            {
                "kb_id": r.id,
                "name": r.name,
                "docs": r.docs_count or 0,
                "chunks": r.chunks_count or 0,
            }
            for r in rows
        ],
    }


__all__ = ["kb_search", "list_knowledge_bases"]
