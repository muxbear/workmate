import logging

from agent.common import resolve_model

logger = logging.getLogger(__name__)


async def create_subagents() -> list[dict]:
    """DB driven sub-agent builder.

    Queries sub-agents from the database and assembles them into
    the subagents dict array for create_deep_agent().
    Uses DB-driven dynamic tool registry (improvement 1),
    supporting both builtin and MCP tools.
    """
    from agent.tools.registry import resolve_agent_tools  # noqa: PLC0415
    from api.agents.service import list_agents  # noqa: PLC0415
    from db.engine import async_session  # noqa: PLC0415

    subagents: list[dict] = []

    async with async_session() as session:
        try:
            result = await list_agents(session)
            await session.commit()
        except Exception:
            await session.rollback()
            raise

        sub_agent_infos = [
            a for a in result.agents
            if a.parent_id is not None and a.status == "active"
        ]

        if not sub_agent_infos:
            logger.info("no active sub-agents found in database")
            return []

        for info in sub_agent_infos:
            tools = await resolve_agent_tools(session, info.id, info.tools)
            tools = [t for t in tools if t is not None]

            system_prompt = info.system_prompt or ""

            subagents.append({
                "name": info.name,
                "description": info.description or "",
                "tools": tools,
                "model": await resolve_model(info.provider_id, info.model_id),
                "system_prompt": system_prompt,
                "skills": [f"/skills/{info.id}/"],
            })

    logger.info("loaded %d sub-agents from database", len(subagents))
    return subagents
