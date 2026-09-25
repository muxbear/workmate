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
    top_k: int | None = None,
    kb_ids: list[str] | None = None,
    use_rewrite: bool | None = None,
    history: list[str] | None = None,
) -> dict[str, Any]:
    """搜索知识库中的内容，支持混合检索、向量检索和 BM25 关键词检索。

    只能检索当前用户可读的知识库（自己的、别人分享给自己且已接受的、公共库）。
    调用前请先用 list_knowledge_bases 获取可用的知识库列表，再传入正确的 kb_id。
    如果不知道 kb_id，可以传入 kb_name 按名称匹配；**名称匹配到多个知识库时不会
    猜测**，而是返回 candidates 列表要求显式指定 kb_id。

    Args:
        query: 搜索查询，使用关键词而非完整句子。
        kb_id: 知识库 ID（优先使用）。不知道时传空字符串，通过 kb_name 匹配。
        kb_name: 知识库名称（模糊匹配）。仅 kb_id 为空时生效。
        mode: 检索模式，"hybrid"（RRF 混合，推荐）、"vector"（语义）、"bm25"（关键词）。
        top_k: 返回结果数量；不传则使用该知识库配置的 Top-K（默认 5），越界值夹到 [1, 50]。
        kb_ids: 跨知识库联合检索——在这些知识库里一起找（最多 5 个），
            结果按排名融合并标注来源库。**每个库都会做权限校验**，
            不可读的库会被拒绝。不知道有哪些库时先调用 list_knowledge_bases。
        use_rewrite: 是否做查询改写（指代消解 + 多查询扩展，会多一次 LLM 调用）。
            不传则用知识库配置。**多轮追问时建议开启**：像"它的从库怎么配"这类
            带代词的问题，改写会把"它"还原成上一轮讨论的对象，否则几乎必然召回失败。
        history: 最近几轮的用户提问（从旧到新，最多 3 轮），配合 use_rewrite 做指代消解。
            例如用户先问"MySQL 主从怎么配置"、再问"那从库要改哪些参数"，则传
            ["MySQL 主从怎么配置"]。

    Returns:
        {"total": int, "results": [{"doc": str, "content": str, "score": float,
         "score_kind": str, "page": int|None, "section": str, "chunk_index": int, ...}]}
        - ``no_relevant_result=True`` 表示该知识库中没有相关内容（不是"检索失败"），
          此时应如实告诉用户"知识库里没有"，不要自行编造答案；
        - 引用时请带上 ``doc`` 与 ``section``/``page``，便于用户核对原文。
        失败时返回 {"error": str, ...}，其中：
        - kb_id 无效 → 附 available_kbs；
        - 多个候选知识库 → 附 candidates；
        - mode 非法 → 附 available_modes。
    """
    return asyncio.run(_kb_search_async(
        query, kb_id, kb_name, mode, top_k, kb_ids, use_rewrite, history,
    ))


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
                        await _readable_condition(db, user_id),
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
                        await _readable_condition(db, user_id),
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
        readable = [
            await _readable_condition(db, user_id),
            KnowledgeBase.status == "ready",
        ]
        if kb_name.strip():
            rows = list(
                (
                    await db.execute(
                        select(KnowledgeBase)
                        .where(
                            KnowledgeBase.name.contains(kb_name.strip()),
                            *readable,
                        )
                        .order_by(KnowledgeBase.updated_at.desc())
                    )
                ).scalars().all()
            )
        else:
            # 只取前两条：够判断"是否唯一"即可，避免为报错路径拉全表
            rows = list(
                (
                    await db.execute(
                        select(KnowledgeBase)
                        .where(*readable)
                        .order_by(KnowledgeBase.updated_at.desc())
                        .limit(2)
                    )
                ).scalars().all()
            )

    if len(rows) == 1:
        return rows[0].id, None

    if len(rows) > 1:
        # 不再"取第一个"——此前 limit(1) 没有 order_by，同一问题可能每次命中
        # 不同知识库，行为不可复现。多个候选时要求模型显式选择。
        available = await _load_readable_kbs(user_id)
        if kb_name.strip():
            error = f"'{kb_name.strip()}' 匹配到多个知识库，请指定其中的 kb_id。"
            hint = "从 candidates 中选一个 kb_id 重新调用 kb_search。"
        else:
            error = "未指定知识库，且当前用户有多个可用知识库，请显式指定 kb_id。"
            hint = "可调用 list_knowledge_bases 查看完整列表，再指定 kb_id 重新调用。"
        return "", {
            "error": error,
            "candidates": _summarize_kbs(rows),
            "available_kbs": _summarize_kbs(available),
            "total": 0,
            "results": [],
            "hint": hint,
        }

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


async def _load_kb_config(kb_id: str) -> dict:
    """读取知识库配置（检索参数来源）。读取失败按空配置处理。"""
    from sqlalchemy import select

    from db.engine import async_session
    from db.models.knowledge_base import KnowledgeBase

    try:
        async with async_session() as db:
            kb = (
                await db.execute(
                    select(KnowledgeBase).where(KnowledgeBase.id == kb_id)
                )
            ).scalar_one_or_none()
    except Exception:  # noqa: BLE001 - 配置读取失败不应让检索失败
        logger.warning("读取知识库配置失败 kb=%s", kb_id, exc_info=True)
        return {}
    return dict(kb.config) if kb is not None and isinstance(kb.config, dict) else {}


async def _kb_search_async(
    query: str, kb_id: str, kb_name: str, mode: str, top_k: int,
    kb_ids: list[str] | None = None,
    use_rewrite: bool | None = None,
    history: list[str] | None = None,
) -> dict[str, Any]:
    from api.knowledge_base.schemas import SearchRequest
    from api.knowledge_base.search_service import (
        create_search_registry,
        get_search_orchestrator,
    )
    from db.engine import async_session

    orch = get_search_orchestrator()
    if orch is None:
        return {"error": "搜索服务未就绪，请稍后重试", "total": 0, "results": []}

    if not query.strip():
        return {"total": 0, "results": []}

    # 参数由模型自由填写：非法 mode / 越界 top_k 必须回一条可读的提示，
    # 而不是抛 ValueError / ValidationError 让整个工具调用崩掉。
    valid_modes = create_search_registry().supported_modes
    normalized_mode = str(mode or "hybrid").strip().lower()
    if normalized_mode not in valid_modes:
        return {
            "error": f"不支持的检索模式 '{mode}'。",
            "available_modes": valid_modes,
            "total": 0,
            "results": [],
            "hint": "mode 只能是 " + " / ".join(valid_modes) + " 之一，默认用 hybrid。",
        }
    # top_k 未显式传入时用知识库配置的 Top-K——此前工具硬编码 5，
    # 用户在配置页设的 Top-K 对智能体完全无效（配置与行为漂移）。
    if top_k is None:
        clamped_top_k = None
    else:
        try:
            clamped_top_k = max(1, min(int(top_k), 50))
        except (TypeError, ValueError):
            clamped_top_k = None

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

    # 跨库检索：逐个校验可读性。编排器本身不做权限判定（权限在 API 层与本工具），
    # 因此这里必须把住关口——否则模型传一个他人的 kb_id 就能读到别人的库。
    extra_ids: list[str] = []
    if kb_ids:
        readable_ids = {kb.id for kb in await _load_readable_kbs(user_id)}
        requested = [k for k in dict.fromkeys(kb_ids) if k and k != resolved_id]
        denied = [k for k in requested if k not in readable_ids]
        if denied:
            available = await _load_readable_kbs(user_id)
            return {
                "error": f"以下知识库不存在或无权访问：{denied}",
                "available_kbs": _summarize_kbs(available),
                "total": 0,
                "results": [],
                "hint": "只能检索当前用户可读的知识库；请用 list_knowledge_bases 确认。",
            }
        extra_ids = requested[:4]  # 加上主库共最多 5 个

    kb_config = await _load_kb_config(resolved_id)
    effective_top_k = clamped_top_k if clamped_top_k is not None else int(
        kb_config.get("top_k") or 5
    )
    # 历史只保留最近几条：指代消解用不了那么远，多传只会让提示词变长
    recent_history = [h for h in (history or []) if isinstance(h, str) and h.strip()][-3:]
    req = SearchRequest(
        query=query.strip(),
        mode=normalized_mode,
        top_k=max(1, min(effective_top_k, 50)),
        kb_ids=[resolved_id, *extra_ids] if extra_ids else None,
        use_rewrite=use_rewrite,
        history=recent_history or None,
    )

    async with async_session() as db:
        try:
            resp = await orch.search(db, resolved_id, req)
        except (ValueError, RuntimeError) as e:
            available = await _load_readable_kbs(user_id)
            return {
                "error": f"检索失败（kb_id={resolved_id}）：{e}",
                "available_kbs": _summarize_kbs(available),
                "total": 0,
                "results": [],
                "hint": "该知识库可能不存在或未完成索引，请使用 list_knowledge_bases 确认可用的知识库。",
            }
        except Exception as e:  # noqa: BLE001 - 工具边界必须兜住任何异常
            logger.exception("kb_search 未预期异常 kb_id=%s", resolved_id)
            return {
                "error": f"检索失败（kb_id={resolved_id}）：{type(e).__name__}",
                "total": 0,
                "results": [],
                "hint": "请稍后重试；若持续失败请检查知识库与向量库状态。",
            }

        if resp.total == 0 and resp.no_relevant_result:
            # 明确区分"库里有内容但都不相关"与"没查到"：模型应如实转述，
            # 而不是拿着低相关片段编答案。
            return {
                "total": 0,
                "results": [],
                "no_relevant_result": True,
                "hint": (
                    "该知识库中未找到与问题相关的内容（最高相似度低于门槛）。"
                    "请直接告诉用户知识库里没有这方面资料，或建议更换关键词/知识库。"
                ),
                # 改写生效却仍然无结果时，"换关键词/开改写"这类建议就没意义了
                "rewrite_applied": resp.rewrite_applied,
            }

        return {
            "total": resp.total,
            "results": [
                {
                    "doc": r.doc_name,
                    "kb_name": r.kb_name or None,
                    "content": r.content,
                    "score": r.score,
                    "score_kind": r.score_kind,
                    "vec_score": r.vec_score,
                    "bm25_score": r.bm25_score,
                    # 引用定位：doc_id/chunk_index 供前端跳转，page/section 供用户复核
                    "doc_id": r.doc_id,
                    "chunk_index": r.chunk_index,
                    "page": r.page,
                    "section": r.section,
                }
                for r in resp.results
            ],
            "rerank_applied": resp.rerank_applied,
            # 改写状态如实返回：模型据此知道"多轮追问已被还原"或"改写没生效"
            "rewrite_applied": resp.rewrite_applied,
            "rewrite_queries": resp.rewrite_queries[1:] if resp.rewrite_applied else [],
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
                    await _readable_condition(db, user_id),
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
