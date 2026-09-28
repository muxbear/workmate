"""云知识库检索 MCP Server.

对「知识库」页面配置的知识库提供检索服务，暴露 4 个工具：

- ``list_knowledge_bases``：列出当前调用方可读的知识库；
- ``kb_search``：混合 / 向量 / BM25 检索，支持跨库与查询改写；
- ``kb_get_chunk_context``：按命中位置取回上下文，供核对原文与引用；
- ``kb_graph_lookup``：知识图谱实体与关系查询。

**权限**：所有工具都限定在调用方**可读**的知识库范围内（自己的 ∪ 部门范围内公开的
∪ 已接受的分享 ∪ 授权），与网页检索共用 ``api.knowledge_base.service._readable_condition``
与 ``agent.tools.kb_search`` 的同一条判定——本模块只做身份解析与结果整形，
**不自己拼权限条件**，否则就会出现"网页里搜不到、MCP 里却搜得到"的越权。

**身份**：调用方身份由 ``agent.tools.kb_search._current_user_id`` 统一解析
（Agent 运行时上下文，或 MCP 请求头里的 access token）；解析不出来即拒绝，
绝不放行无身份的请求。
"""

from __future__ import annotations

import logging
from typing import Any

from mcp.server.fastmcp import FastMCP

from mcp_servers.transport_security import transport_security_settings

logger = logging.getLogger(__name__)

#: 广场卡片名与 ``register_local_mcp_server`` 的注册名必须一致（按名称匹配库内配置）
SERVER_NAME = "云知识库检索"

#: ``kb_get_chunk_context`` 单侧最多取几片——窗口再大就不如直接读文档了
_MAX_CONTEXT_WINDOW = 5

mcp = FastMCP("ke-hermes-kb", transport_security=transport_security_settings())


def _require_user_id() -> tuple[str, dict[str, Any] | None]:
    """解析调用方用户 ID。

    Returns:
        ``(user_id, error_payload)``；身份不可确定时 user_id 为空串，error_payload 为提示。
    """
    from agent.tools.kb_search import _current_user_id

    user_id = _current_user_id()
    if user_id:
        return user_id, None
    logger.warning("知识库 MCP 工具缺少身份信息，已拒绝调用")
    return "", {
        "error": "缺少身份信息，无法确定知识库访问权限。",
        "total": 0,
        "results": [],
        "hint": (
            "通过 HTTP 调用本 MCP 服务时，请在请求头携带 "
            "Authorization: Bearer <access token>；Web 版智能体在对话中调用无需额外配置。"
        ),
    }


async def _readable(db: Any, kb_id: str, user_id: str) -> dict[str, Any] | None:
    """校验知识库可读性；不可读时返回结构化的错误载荷（而不是抛异常）。"""
    from fastapi import HTTPException

    from api.knowledge_base.service import require_kb_readable

    try:
        await require_kb_readable(db, kb_id, user_id)
    except HTTPException:
        return {
            "error": f"知识库 {kb_id} 不存在或当前调用方无权访问。",
            "hint": "请先调用 list_knowledge_bases 查看可用的知识库，再用正确的 kb_id 重新调用。",
        }
    return None


@mcp.tool()
async def list_knowledge_bases() -> dict[str, Any]:
    """列出当前调用方可读的知识库及其 ID（含公共库与已接受的分享）。

    Returns:
        {"total": int, "knowledge_bases": [{"kb_id", "name", "docs", "chunks"}]}
    """
    from agent.tools.kb_search import list_knowledge_bases as _list_kbs

    # 先在本层判身份：Agent 工具的拒绝文案面向会话语境（"缺少用户会话上下文"），
    # 而 MCP 的调用方多是外部客户端，需要的是"该怎么补凭据"的提示。
    # 本层统一拒绝口径，4 个工具的失败契约保持一致。
    _user_id, error = _require_user_id()
    if error is not None:
        return error

    return await _list_kbs()


@mcp.tool()
async def kb_search(
    query: str,
    kb_id: str = "",
    kb_name: str = "",
    mode: str = "hybrid",
    top_k: int | None = None,
    kb_ids: list[str] | None = None,
    use_rewrite: bool | None = None,
    history: list[str] | None = None,
) -> dict[str, Any]:
    """检索知识库内容，支持混合、向量与 BM25 关键词检索。

    只能检索当前调用方可读的知识库。不知道 kb_id 时先用 list_knowledge_bases 获取，
    或传 kb_name 按名称匹配（匹配到多个时不会猜测，而是返回 candidates 要求显式指定）。

    Args:
        query: 检索查询，建议用关键词而非完整句子。
        kb_id: 知识库 ID（优先使用）。
        kb_name: 知识库名称（模糊匹配），仅 kb_id 为空时生效。
        mode: "hybrid"（RRF 混合，推荐）/ "vector"（语义）/ "bm25"（关键词）。
        top_k: 返回条数；不传则用该知识库配置的 Top-K，越界值夹到 [1, 50]。
        kb_ids: 跨知识库联合检索（最多 5 个），结果按排名融合并标注来源库。
        use_rewrite: 是否做查询改写（指代消解 + 多查询扩展，多一次 LLM 调用）。
            多轮追问建议开启。
        history: 最近几轮的用户提问（从旧到新，最多 3 轮），配合 use_rewrite 做指代消解。

    Returns:
        {"total": int, "results": [{"doc", "kb_id", "content", "score", "score_kind",
         "page", "section", "chunk_index", ...}]}；
        ``no_relevant_result=True`` 表示库中没有相关内容（而非检索失败），
        此时应如实告知用户，不要编造答案。
    """
    from agent.tools.kb_search import _kb_search_async

    # 与其余 3 个工具统一拒绝口径，见 list_knowledge_bases 的说明
    _user_id, error = _require_user_id()
    if error is not None:
        return error

    return await _kb_search_async(
        query,
        kb_id,
        kb_name,
        mode,
        top_k,
        kb_ids,
        use_rewrite,
        history,
    )


@mcp.tool()
async def kb_get_chunk_context(
    kb_id: str,
    doc_id: str,
    chunk_index: int,
    window: int = 1,
) -> dict[str, Any]:
    """取回某个命中切片的前后文，用于核对原文、补全被切断的语义。

    检索返回的是切片，内容可能被截断；要判断"这段话到底在讲什么"或给出可核对的
    引用时，用它把上下文补回来。``window`` 是单侧取的切片数（0 表示只要命中切片本身）。

    Args:
        kb_id: 知识库 ID。
        doc_id: 文档 ID（取自检索结果里的 ``doc_id``）。
        chunk_index: 切片序号（取自检索结果里的 ``chunk_index``）。
        window: 单侧额外取回的切片数，夹到 [0, 5]。

    Returns:
        {"kb_id", "doc_id", "doc_name", "chunk_index",
         "chunks": [{"index", "content", "section", "page"}], "truncated": bool}
    """
    from db.engine import async_session

    user_id, error = _require_user_id()
    if error is not None:
        return error

    try:
        index = max(0, int(chunk_index))
    except (TypeError, ValueError):
        return {"error": f"chunk_index 必须是整数，收到 {chunk_index!r}"}
    try:
        half = max(0, min(int(window), _MAX_CONTEXT_WINDOW))
    except (TypeError, ValueError):
        half = 1

    from api.knowledge_base.facade import get_vector_store

    vector_store = get_vector_store()
    if vector_store is None:
        return {"error": "向量库未就绪，请稍后重试"}

    async with async_session() as db:
        denied = await _readable(db, kb_id, user_id)
        if denied is not None:
            return denied

        try:
            raws = await vector_store.get_chunks_by_doc_id(kb_id, doc_id)
        except Exception as exc:  # noqa: BLE001 - 工具边界必须兜住任何异常
            logger.exception("读取切片失败 kb=%s doc=%s", kb_id, doc_id)
            return {"error": f"读取切片失败：{type(exc).__name__}", "chunks": []}

    if not raws:
        return {
            "error": f"文档 {doc_id} 在知识库 {kb_id} 中没有切片（可能已删除或未完成索引）。",
            "chunks": [],
        }

    # 原始记录按 chunk_index 排序后再开窗：向量库返回顺序不保证，直接按下标切片会错位
    ordered = sorted(raws, key=lambda r: int(r.get("chunk_index") or 0))
    position = next(
        (i for i, r in enumerate(ordered) if int(r.get("chunk_index") or 0) == index),
        None,
    )
    if position is None:
        available = [int(r.get("chunk_index") or 0) for r in ordered]
        return {
            "error": f"文档 {doc_id} 中不存在切片 {index}。",
            "available_chunk_indices": available[:50],
            "chunks": [],
        }

    start = max(0, position - half)
    end = min(len(ordered), position + half + 1)

    return {
        "kb_id": kb_id,
        "doc_id": doc_id,
        "chunk_index": index,
        "chunks": [
            {
                "index": int(r.get("chunk_index") or 0),
                "content": r.get("chunk_text", ""),
                "section": (r.get("metadata_") or {}).get("section", ""),
                "page": (r.get("metadata_") or {}).get("page"),
                "is_hit": int(r.get("chunk_index") or 0) == index,
            }
            for r in ordered[start:end]
        ],
        "truncated": start > 0 or end < len(ordered),
        "total_chunks": len(ordered),
    }


@mcp.tool()
async def kb_graph_lookup(kb_id: str, entity_key: str = "") -> dict[str, Any]:
    """查询知识库的图谱实体。

    Args:
        kb_id: 知识库 ID。
        entity_key: 实体归一键（取自实体列表里的 ``id``）。不传则返回实体与关系概览。

    Returns:
        传 entity_key 时返回该实体的类型、出现次数、来源文档与关联关系；
        不传时返回 {"entities": [...], "relations": [...], "total_entities": int}。
        知识库未抽取图谱时返回 entities 为空并附提示——这不是失败。
    """
    from api.knowledge_base.graph_service import get_entity_detail, get_graph_data
    from db.engine import async_session

    user_id, error = _require_user_id()
    if error is not None:
        return error

    async with async_session() as db:
        denied = await _readable(db, kb_id, user_id)
        if denied is not None:
            return denied

        try:
            if entity_key.strip():
                detail = await get_entity_detail(db, kb_id, entity_key.strip())
                if detail is None:
                    return {
                        "error": f"知识库 {kb_id} 中没有实体 {entity_key!r}。",
                        "hint": "可先不传 entity_key 获取实体列表，再从其中取 id。",
                    }
                return detail
            graph = await get_graph_data(db, kb_id)
        except Exception as exc:  # noqa: BLE001 - 工具边界必须兜住任何异常
            logger.exception("查询图谱失败 kb=%s", kb_id)
            return {"error": f"查询图谱失败：{type(exc).__name__}"}

    entities = graph.get("entities") or []
    return {
        "entities": entities,
        "relations": graph.get("relations") or [],
        "total_entities": len(entities),
        # 图谱是抽取产物，可能尚未跑或抽取失败——如实说明，避免模型据此下结论
        "hint": ""
        if entities
        else "该知识库暂无图谱实体（可能未开启图谱抽取或抽取失败）。",
    }


__all__ = [
    "SERVER_NAME",
    "kb_get_chunk_context",
    "kb_graph_lookup",
    "kb_search",
    "list_knowledge_bases",
    "mcp",
]


def main() -> None:
    """以 stdio 方式启动 MCP Server。"""
    mcp.run()


if __name__ == "__main__":
    main()
