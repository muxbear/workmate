"""主智能体子代理构建。.

普通子智能体来自 agents 表；专家从独立的 experts 表加载，
两者共同作为 create_deep_agent() 的 subagents 输入。
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agent.common import resolve_model
from db.models.expert import Expert
from db.models.expert_tool import ExpertTool
from db.models.tool import Tool

logger = logging.getLogger(__name__)


async def _load_expert_subagent_defs(session: AsyncSession) -> list[dict[str, Any]]:
    """从 experts 表加载已发布且启用的专家，组装为主智能体子代理。."""
    from agent.tools.registry import resolve_expert_tools  # noqa: PLC0415

    stmt = (
        select(Expert)
        .where(
            Expert.is_published,
            Expert.status == "active",
        )
        .order_by(Expert.sort_order.desc())
    )
    experts = (await session.execute(stmt)).scalars().all()

    defs: list[dict[str, Any]] = []
    for expert in experts:
        tool_names = (
            (
                await session.execute(
                    select(Tool.name)
                    .join(ExpertTool, ExpertTool.tool_id == Tool.id)
                    .where(ExpertTool.expert_id == expert.id)
                    .order_by(Tool.name)
                )
            )
            .scalars()
            .all()
        )
        tools = await resolve_expert_tools(session, expert.id, list(tool_names))
        tools = [t for t in tools if t is not None]

        defs.append(
            {
                "name": expert.name,
                "description": expert.description or "",
                "tools": tools,
                "model": await resolve_model(expert.provider_id, expert.model_id),
                "system_prompt": expert.system_prompt or "",
                "skills": [f"/skills/{expert.id}/"],
            }
        )
    return defs


async def create_subagents() -> list[dict[str, Any]]:
    """从数据库加载子智能体（agents + experts）。.

    Returns:
        子代理定义数组；无活跃子代理时返回空列表。
    """
    from agent.tools.registry import resolve_agent_tools  # noqa: PLC0415
    from api.agents.service import list_agents  # noqa: PLC0415
    from db.engine import async_session  # noqa: PLC0415

    subagents: list[dict[str, Any]] = []

    async with async_session() as session:
        try:
            result = await list_agents(session)
            await session.commit()
        except Exception:
            await session.rollback()
            raise

        sub_agent_infos = [
            a for a in result.agents if a.parent_id is not None and a.status == "active"
        ]

        for info in sub_agent_infos:
            tools = await resolve_agent_tools(session, info.id, info.tools)
            tools = [t for t in tools if t is not None]

            subagents.append(
                {
                    "name": info.name,
                    "description": info.description or "",
                    "tools": tools,
                    "model": await resolve_model(info.provider_id, info.model_id),
                    "system_prompt": info.system_prompt or "",
                    "skills": [f"/skills/{info.id}/"],
                }
            )

        expert_defs = await _load_expert_subagent_defs(session)
        subagents.extend(expert_defs)

    logger.info(
        "loaded %d sub-agents and %d experts from database",
        len(sub_agent_infos),
        len(expert_defs),
    )
    return subagents
