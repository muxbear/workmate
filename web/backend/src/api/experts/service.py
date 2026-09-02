"""专家管理业务逻辑层。.

设计模式运用：
- 工厂模式（Factory）：ExpertAssembler 负责将 ORM 模型组装为 ExpertInfo 响应对象，
  封装多表 JOIN 后的数据装配逻辑，避免在各 service 函数中重复组装。
- 策略模式（Strategy）：排序逻辑通过 SortStrategy 字典注入，新增排序方式只需
  添加一个排序函数和一条映射，无需修改 list_experts 主体。
- 适配器模式（Adapter）：to_sync_item 将 ExpertInfo 适配为桌面端同步所需的
  ExpertSyncItem，隔离内部数据结构与外部接口契约。
"""
from __future__ import annotations

import logging
import time
from collections.abc import Callable

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from agent.graph import invalidate_graph
from api.agents.service import (
    _create_version_snapshot as _create_agent_version_snapshot,
)
from api.experts.schemas import (
    ExpertConfigUpdateRequest,
    ExpertCreateRequest,
    ExpertInfo,
    ExpertListResponse,
    ExpertProfileUpdateRequest,
    ExpertSkillBrief,
    ExpertSyncItem,
    ExpertSyncListResponse,
    ExpertUpdateRequest,
    McpConfigBrief,
    McpConfigItem,
    ToolBrief,
)
from db.models.agent import Agent
from db.models.agent_mcp_config import AgentMcpConfig
from db.models.agent_skill import AgentSkill
from db.models.agent_tool import AgentTool
from db.models.ai_model import AIModel
from db.models.expert_profile import ExpertProfile
from db.models.mcp_tool import McpTool
from db.models.skill import Skill
from db.models.tool import Tool

logger = logging.getLogger(__name__)

# ── 预置分类 ──────────────────────────────────────────────────

EXPERT_CATEGORIES: dict[str, str] = {
    "content_creation": "内容创作",
    "legal_tax": "法律财税",
    "tech_rnd": "技术研发",
    "product_design": "产品设计",
    "startup_invest": "创业投资",
    "sme_ops": "小微企业",
    "ai_tools": "AI工具专家",
    "spc": "SPC",
    "custom": "自定义",
}

FEATURED_SCENES = [
    {"id": "content", "label": "内容创作", "color": "linear-gradient(135deg,#f59e0b,#d97706)"},
    {"id": "invest", "label": "投资分析", "color": "linear-gradient(135deg,#0891b2,#0e7490)"},
    {"id": "legal", "label": "法律财税", "color": "linear-gradient(135deg,#6366f1,#4f46e5)"},
    {"id": "sme", "label": "小微企业", "color": "linear-gradient(135deg,#10b981,#059669)"},
]


# ── 工厂模式：ExpertAssembler ─────────────────────────────────

class ExpertAssembler:
    """将 ORM 模型组装为 ExpertInfo 响应对象。.

    封装 Agent + ExpertProfile + tools + skills + mcp_configs 的多表
    装配逻辑，确保列表和详情返回一致的数据结构。
    """

    @staticmethod
    async def assemble(
        db: AsyncSession,
        agent: Agent,
        profile: ExpertProfile | None = None,
    ) -> ExpertInfo:
        """从 Agent ORM 记录组装完整的 ExpertInfo。."""
        if profile is None:
            profile_stmt = select(ExpertProfile).where(ExpertProfile.agent_id == agent.id)
            profile = (await db.execute(profile_stmt)).scalar_one_or_none()
            if profile is None:
                raise HTTPException(status_code=404, detail="专家 profile 不存在")

        tools = await _query_tools(db, agent.id)
        skills = await _query_skills(db, agent.id)
        mcp_configs = await _query_mcp_configs(db, agent.id)

        model_name = None
        model_type = None
        if agent.model_id:
            model = (await db.execute(
                select(AIModel).where(AIModel.id == agent.model_id)
            )).scalar_one_or_none()
            if model is not None:
                model_name = model.name
                model_type = model.type

        return ExpertInfo(
            id=agent.id,
            name=agent.name,
            title=profile.title,
            description=agent.description,
            category=profile.category,
            tags=profile.tags if isinstance(profile.tags, list) else [],
            icon=profile.icon,
            color=profile.color,
            initials=profile.initials,
            avatar_url=profile.avatar_url,
            rating=profile.rating,
            usage_count=profile.usage_count,
            featured=profile.featured,
            scene=profile.scene,
            sort_order=profile.sort_order,
            is_published=profile.is_published,
            status=agent.status,
            system_prompt=agent.system_prompt or "",
            provider_id=agent.provider_id,
            model_id=agent.model_id,
            model_name=model_name,
            model_type=model_type,
            prompt_template="",
            expertise_areas=[],
            tools=tools,
            skills=skills,
            mcp_configs=mcp_configs,
            files=agent.files if isinstance(agent.files, list) else [],
            created_at=agent.created_at,
            updated_at=agent.updated_at,
        )

    @staticmethod
    async def to_sync_item(expert: ExpertInfo) -> ExpertSyncItem:
        """适配器：将 ExpertInfo 转换为桌面端同步用的 ExpertSyncItem。."""
        return ExpertSyncItem(
            id=expert.id,
            name=expert.name,
            title=expert.title,
            desc=expert.description,
            category=expert.category,
            tags=expert.tags,
            color=expert.color,
            initials=expert.initials,
            icon=expert.icon,
            avatar_url=expert.avatar_url,
            rating=expert.rating,
            users=_format_usage_count(expert.usage_count),
            system_prompt=expert.system_prompt,
            scene=expert.scene,
            sort_order=expert.sort_order,
            provider_id=expert.provider_id,
            model_id=expert.model_id,
            model_name=expert.model_name,
            model_type=expert.model_type,
            tools=expert.tools,
            skills=expert.skills,
            mcp_configs=expert.mcp_configs,
            prompt_template=expert.prompt_template,
            expertise_areas=expert.expertise_areas,
        )


# ── 策略模式：排序策略 ───────────────────────────────────────

SortStrategy = Callable[[list[tuple[Agent, ExpertProfile]]], list[tuple[Agent, ExpertProfile]]]


def _sort_by_rating(rows: list[tuple[Agent, ExpertProfile]]) -> list[tuple[Agent, ExpertProfile]]:
    return sorted(rows, key=lambda r: (-r[1].rating, -r[1].sort_order))


def _sort_by_usage(rows: list[tuple[Agent, ExpertProfile]]) -> list[tuple[Agent, ExpertProfile]]:
    return sorted(rows, key=lambda r: (-r[1].usage_count, -r[1].sort_order))


def _sort_by_recent(rows: list[tuple[Agent, ExpertProfile]]) -> list[tuple[Agent, ExpertProfile]]:
    return sorted(rows, key=lambda r: r[0].updated_at, reverse=True)


def _sort_by_name(rows: list[tuple[Agent, ExpertProfile]]) -> list[tuple[Agent, ExpertProfile]]:
    return sorted(rows, key=lambda r: r[0].name)

SORT_STRATEGIES: dict[str, SortStrategy] = {
    "rating": _sort_by_rating,
    "usage": _sort_by_usage,
    "recent": _sort_by_recent,
    "name": _sort_by_name,
}


# ── 查询辅助 ─────────────────────────────────────────────────

async def _query_tools(db: AsyncSession, agent_id: str) -> list[ToolBrief]:
    stmt = (
        select(Tool)
        .join(AgentTool, AgentTool.tool_id == Tool.id)
        .where(AgentTool.agent_id == agent_id)
        .order_by(Tool.name)
    )
    rows = (await db.execute(stmt)).scalars().all()
    return [
        ToolBrief(
            id=t.id, name=t.name, display_name=t.display_name,
            tool_type=t.tool_type, category=t.category, icon="",
        )
        for t in rows
    ]


async def _query_skills(db: AsyncSession, agent_id: str) -> list[ExpertSkillBrief]:
    stmt = (
        select(Skill)
        .join(AgentSkill, AgentSkill.skill_id == Skill.id)
        .where(AgentSkill.agent_id == agent_id)
    )
    rows = (await db.execute(stmt)).scalars().all()
    return [
        ExpertSkillBrief(
            id=s.id, name=s.name, description=s.description,
            category=s.category, icon=s.icon, enabled=s.enabled,
        )
        for s in rows
    ]


async def _query_mcp_configs(db: AsyncSession, agent_id: str) -> list[McpConfigBrief]:
    stmt = (
        select(
            AgentMcpConfig,
            McpTool.name,
            McpTool.transport,
            McpTool.url,
            McpTool.sse_url,
            McpTool.streamable_http_url,
        )
        .outerjoin(McpTool, McpTool.id == AgentMcpConfig.mcp_tool_id)
        .where(AgentMcpConfig.agent_id == agent_id)
    )
    rows = (await db.execute(stmt)).all()
    return [
        McpConfigBrief(
            mcp_tool_id=cfg.mcp_tool_id,
            mcp_tool_name=mcp_name or "",
            transport=mcp_transport or "",
            url=mcp_url or "",
            sse_url=mcp_sse_url or "",
            streamable_http_url=mcp_streamable_http_url or "",
            config=cfg.config if isinstance(cfg.config, dict) else {},
            enabled=cfg.enabled,
        )
        for cfg, mcp_name, mcp_transport, mcp_url, mcp_sse_url, mcp_streamable_http_url in rows
    ]


async def _get_main_agent_id(db: AsyncSession) -> str:
    stmt = select(Agent).where(Agent.parent_id.is_(None))
    agent = (await db.execute(stmt)).scalar_one_or_none()
    if agent is None:
        raise HTTPException(status_code=404, detail="主智能体不存在")
    return agent.id


def _format_usage_count(count: int) -> str:
    if count >= 10000:
        return f"{count / 1000:.1f}w"
    if count >= 1000:
        return f"{count / 1000:.1f}k"
    return str(count)


# ── CRUD ─────────────────────────────────────────────────────

async def list_experts(
    db: AsyncSession,
    *,
    page: int = 1,
    page_size: int = 20,
    keyword: str | None = None,
    category: str | None = None,
    featured: bool | None = None,
    status: str | None = None,
    sort: str = "rating",
) -> ExpertListResponse:
    """分页列出专家，支持搜索、分类筛选、排序。."""
    stmt = (
        select(Agent, ExpertProfile)
        .join(ExpertProfile, ExpertProfile.agent_id == Agent.id)
        .where(Agent.parent_id.is_not(None))
    )

    if keyword:
        kw = f"%{keyword}%"
        stmt = stmt.where(
            (Agent.name.ilike(kw))
            | (ExpertProfile.title.ilike(kw))
            | (Agent.description.ilike(kw))
        )

    if category:
        stmt = stmt.where(ExpertProfile.category == category)

    if featured is not None:
        stmt = stmt.where(ExpertProfile.featured == featured)

    if status:
        stmt = stmt.where(Agent.status == status)

    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = (await db.execute(count_stmt)).scalar() or 0

    rows = list((await db.execute(stmt)).all())
    strategy = SORT_STRATEGIES.get(sort, SORT_STRATEGIES["rating"])
    rows = strategy(rows)

    start = (page - 1) * page_size
    paged = rows[start : start + page_size]

    items = [await ExpertAssembler.assemble(db, agent, profile) for agent, profile in paged]

    return ExpertListResponse(
        items=items, total=total, page=page, page_size=page_size,
    )


async def get_expert(db: AsyncSession, expert_id: str) -> ExpertInfo:
    """获取单个专家详情。."""
    stmt = (
        select(Agent, ExpertProfile)
        .join(ExpertProfile, ExpertProfile.agent_id == Agent.id)
        .where(Agent.id == expert_id)
    )
    row = (await db.execute(stmt)).first()
    if row is None:
        raise HTTPException(status_code=404, detail="专家不存在")
    agent, profile = row
    return await ExpertAssembler.assemble(db, agent, profile)


async def create_expert(db: AsyncSession, req: ExpertCreateRequest) -> ExpertInfo:
    """创建专家：在 agents 表插入 sub 记录 + expert_profiles 展示元数据。."""
    existing = (await db.execute(
        select(Agent).where(Agent.name == req.name)
    )).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=409, detail=f"专家名称 '{req.name}' 已存在")

    main_agent_id = await _get_main_agent_id(db)

    agent = Agent(
        name=req.name,
        type="expert",
        status="inactive",
        description=req.description,
        parent_id=main_agent_id,
        system_prompt=req.system_prompt,
        provider_id=req.provider_id,
        model_id=req.model_id,
    )
    db.add(agent)
    await db.flush()

    profile = ExpertProfile(
        agent_id=agent.id,
        title=req.title,
        category=req.category,
        tags=req.tags,
        icon=req.icon,
        color=req.color,
        initials=req.initials,
        featured=req.featured,
        scene=req.scene,
    )
    db.add(profile)

    for tool_name in req.tool_names:
        tool = (await db.execute(
            select(Tool).where(Tool.name == tool_name)
        )).scalar_one_or_none()
        if tool is not None:
            db.add(AgentTool(agent_id=agent.id, tool_id=tool.id))
        else:
            logger.warning("创建专家时工具 '%s' 未找到，跳过", tool_name)

    for skill_id in req.skill_ids:
        db.add(AgentSkill(agent_id=agent.id, skill_id=skill_id))

    await _validate_mcp_configs(db, req.mcp_configs)
    for mcp_cfg in req.mcp_configs:
        db.add(AgentMcpConfig(
            agent_id=agent.id,
            mcp_tool_id=mcp_cfg.mcp_tool_id,
            config=mcp_cfg.config,
            enabled=mcp_cfg.enabled,
        ))

    await db.flush()
    await _create_agent_version_snapshot(db, agent, req.tool_names, req.skill_ids, change_summary="创建专家")
    await invalidate_graph()

    logger.info("创建专家 '%s' (id=%s)", agent.name, agent.id)
    return await ExpertAssembler.assemble(db, agent, profile)


async def update_expert(db: AsyncSession, expert_id: str, req: ExpertUpdateRequest) -> ExpertInfo:
    """更新专家基础信息（名称、头衔、描述、提示词、模型）。."""
    stmt = (
        select(Agent, ExpertProfile)
        .join(ExpertProfile, ExpertProfile.agent_id == Agent.id)
        .where(Agent.id == expert_id)
    )
    row = (await db.execute(stmt)).first()
    if row is None:
        raise HTTPException(status_code=404, detail="专家不存在")
    agent, profile = row

    dup = (await db.execute(
        select(Agent).where(Agent.name == req.name, Agent.id != expert_id)
    )).scalar_one_or_none()
    if dup is not None:
        raise HTTPException(status_code=409, detail=f"专家名称 '{req.name}' 已存在")

    current_tool_names = await _query_tools(db, expert_id)
    current_skill_ids = [s.id for s in await _query_skills(db, expert_id)]
    await _create_agent_version_snapshot(
        db, agent, [t.name for t in current_tool_names], current_skill_ids,
        change_summary="更新专家基础信息",
    )

    agent.name = req.name
    agent.description = req.description
    agent.system_prompt = req.system_prompt
    agent.provider_id = req.provider_id
    agent.model_id = req.model_id
    profile.title = req.title

    await db.flush()
    await invalidate_graph()

    return await ExpertAssembler.assemble(db, agent, profile)


async def update_expert_profile(
    db: AsyncSession, expert_id: str, req: ExpertProfileUpdateRequest
) -> ExpertInfo:
    """更新专家展示元数据（部分更新）。."""
    stmt = (
        select(Agent, ExpertProfile)
        .join(ExpertProfile, ExpertProfile.agent_id == Agent.id)
        .where(Agent.id == expert_id)
    )
    row = (await db.execute(stmt)).first()
    if row is None:
        raise HTTPException(status_code=404, detail="专家不存在")
    agent, profile = row

    if req.title is not None:
        profile.title = req.title
    if req.category is not None:
        profile.category = req.category
    if req.tags is not None:
        profile.tags = req.tags
    if req.icon is not None:
        profile.icon = req.icon
    if req.color is not None:
        profile.color = req.color
    if req.initials is not None:
        profile.initials = req.initials
    if req.avatar_url is not None:
        profile.avatar_url = req.avatar_url
    if req.featured is not None:
        profile.featured = req.featured
    if req.scene is not None:
        profile.scene = req.scene or None
    if req.sort_order is not None:
        profile.sort_order = req.sort_order
    if req.is_published is not None:
        profile.is_published = req.is_published

    await db.flush()
    return await ExpertAssembler.assemble(db, agent, profile)


async def update_expert_config(
    db: AsyncSession, expert_id: str, req: ExpertConfigUpdateRequest
) -> ExpertInfo:
    """批量更新专家配置（模型 + 提示词 + 工具 + 技能 + MCP）。.

    采用「先快照 → 全量替换关联 → 提交」事务模式。
    """
    stmt = (
        select(Agent, ExpertProfile)
        .join(ExpertProfile, ExpertProfile.agent_id == Agent.id)
        .where(Agent.id == expert_id)
    )
    row = (await db.execute(stmt)).first()
    if row is None:
        raise HTTPException(status_code=404, detail="专家不存在")
    agent, profile = row

    current_tool_names = [t.name for t in await _query_tools(db, expert_id)]
    current_skill_ids = [s.id for s in await _query_skills(db, expert_id)]
    await _create_agent_version_snapshot(
        db, agent, current_tool_names, current_skill_ids,
        change_summary="更新专家配置",
    )

    if req.system_prompt is not None:
        agent.system_prompt = req.system_prompt
    if req.provider_id is not None:
        agent.provider_id = req.provider_id
    if req.model_id is not None:
        agent.model_id = req.model_id

    if req.tool_names is not None:
        await _replace_tool_links(db, expert_id, req.tool_names)

    if req.skill_ids is not None:
        await _replace_skill_links(db, expert_id, req.skill_ids)

    if req.mcp_configs is not None:
        await _replace_mcp_configs(db, expert_id, req.mcp_configs)

    await db.flush()
    await invalidate_graph()

    return await ExpertAssembler.assemble(db, agent, profile)


async def _replace_tool_links(db: AsyncSession, agent_id: str, tool_names: list[str]) -> None:
    """全量替换 agent_tools 关联。."""
    old = (await db.execute(
        select(AgentTool).where(AgentTool.agent_id == agent_id)
    )).scalars().all()
    for link in old:
        await db.delete(link)

    for name in tool_names:
        tool = (await db.execute(
            select(Tool).where(Tool.name == name)
        )).scalar_one_or_none()
        if tool is not None:
            db.add(AgentTool(agent_id=agent_id, tool_id=tool.id))
        else:
            logger.warning("工具 '%s' 未找到，跳过", name)


async def _replace_skill_links(db: AsyncSession, agent_id: str, skill_ids: list[str]) -> None:
    """全量替换 agent_skills 关联。."""
    old = (await db.execute(
        select(AgentSkill).where(AgentSkill.agent_id == agent_id)
    )).scalars().all()
    for link in old:
        await db.delete(link)

    for skill_id in skill_ids:
        db.add(AgentSkill(agent_id=agent_id, skill_id=skill_id))


async def _validate_mcp_configs(db: AsyncSession, configs: list[McpConfigItem]) -> None:
    seen: set[str] = set()
    for item in configs:
        if item.mcp_tool_id in seen:
            raise HTTPException(status_code=409, detail=f'MCP 服务重复配置: {item.mcp_tool_id}')
        seen.add(item.mcp_tool_id)
        mcp_tool = (await db.execute(
            select(McpTool).where(McpTool.id == item.mcp_tool_id)
        )).scalar_one_or_none()
        if mcp_tool is None:
            raise HTTPException(status_code=404, detail=f'MCP 服务不存在: {item.mcp_tool_id}')

async def _replace_mcp_configs(
    db: AsyncSession, agent_id: str, configs: list[McpConfigItem]
) -> None:
    """全量替换 agent_mcp_configs。."""
    old = (await db.execute(
        select(AgentMcpConfig).where(AgentMcpConfig.agent_id == agent_id)
    )).scalars().all()
    for cfg in old:
        await db.delete(cfg)

    await _validate_mcp_configs(db, configs)
    for item in configs:
        db.add(AgentMcpConfig(
            agent_id=agent_id,
            mcp_tool_id=item.mcp_tool_id,
            config=item.config,
            enabled=item.enabled,
        ))


async def delete_expert(db: AsyncSession, expert_id: str) -> None:
    """删除专家（级联删除 profile + 关联表）。."""
    stmt = (
        select(Agent, ExpertProfile)
        .join(ExpertProfile, ExpertProfile.agent_id == Agent.id)
        .where(Agent.id == expert_id)
    )
    row = (await db.execute(stmt)).first()
    if row is None:
        raise HTTPException(status_code=404, detail="专家不存在")
    agent, profile = row

    if agent.undeletable:
        raise HTTPException(status_code=403, detail="该专家不可删除")

    await db.delete(profile)
    await db.delete(agent)
    await db.flush()
    await invalidate_graph()
    logger.info("删除专家 '%s' (id=%s)", agent.name, agent.id)


async def toggle_expert_status(db: AsyncSession, expert_id: str) -> ExpertInfo:
    """切换专家启用/停用状态。."""
    stmt = (
        select(Agent, ExpertProfile)
        .join(ExpertProfile, ExpertProfile.agent_id == Agent.id)
        .where(Agent.id == expert_id)
    )
    row = (await db.execute(stmt)).first()
    if row is None:
        raise HTTPException(status_code=404, detail="专家不存在")
    agent, profile = row

    agent.status = "inactive" if agent.status == "active" else "active"
    await db.flush()
    await invalidate_graph()
    return await ExpertAssembler.assemble(db, agent, profile)


async def clone_expert(db: AsyncSession, expert_id: str) -> ExpertInfo:
    """克隆专家：复制 Agent + ExpertProfile + 所有关联表。."""
    stmt = (
        select(Agent, ExpertProfile)
        .join(ExpertProfile, ExpertProfile.agent_id == Agent.id)
        .where(Agent.id == expert_id)
    )
    row = (await db.execute(stmt)).first()
    if row is None:
        raise HTTPException(status_code=404, detail="专家不存在")
    src_agent, src_profile = row

    base_name = f"{src_agent.name} (副本)"
    new_name = base_name
    counter = 2
    while True:
        dup = (await db.execute(
            select(Agent).where(Agent.name == new_name)
        )).scalar_one_or_none()
        if dup is None:
            break
        new_name = f"{base_name} {counter}"
        counter += 1

    cloned_agent = Agent(
        name=new_name,
        type="expert",
        status="inactive",
        description=src_agent.description,
        parent_id=src_agent.parent_id,
        system_prompt=src_agent.system_prompt,
        provider_id=src_agent.provider_id,
        model_id=src_agent.model_id,
        undeletable=False,
    )
    db.add(cloned_agent)
    await db.flush()

    cloned_profile = ExpertProfile(
        agent_id=cloned_agent.id,
        title=src_profile.title,
        category=src_profile.category,
        tags=list(src_profile.tags) if isinstance(src_profile.tags, list) else [],
        icon=src_profile.icon,
        color=src_profile.color,
        initials=src_profile.initials,
        avatar_url=src_profile.avatar_url,
        featured=False,
        scene=None,
        sort_order=0,
        is_published=True,
    )
    db.add(cloned_profile)

    # 克隆工具关联
    tool_links = (await db.execute(
        select(AgentTool).where(AgentTool.agent_id == expert_id)
    )).scalars().all()
    for link in tool_links:
        db.add(AgentTool(agent_id=cloned_agent.id, tool_id=link.tool_id))

    # 克隆技能关联
    skill_links = (await db.execute(
        select(AgentSkill).where(AgentSkill.agent_id == expert_id)
    )).scalars().all()
    for link in skill_links:
        db.add(AgentSkill(agent_id=cloned_agent.id, skill_id=link.skill_id))

    # 克隆 MCP 配置
    mcp_configs = (await db.execute(
        select(AgentMcpConfig).where(AgentMcpConfig.agent_id == expert_id)
    )).scalars().all()
    for cfg in mcp_configs:
        db.add(AgentMcpConfig(
            agent_id=cloned_agent.id,
            mcp_tool_id=cfg.mcp_tool_id,
            config=cfg.config,
            enabled=cfg.enabled,
        ))

    await db.flush()
    await invalidate_graph()
    logger.info("克隆专家 '%s' -> '%s'", src_agent.name, cloned_agent.name)
    return await ExpertAssembler.assemble(db, cloned_agent, cloned_profile)


# ── 分类与精选 ───────────────────────────────────────────────

async def list_categories(db: AsyncSession) -> list[dict]:
    """获取所有分类及计数。."""
    stmt = (
        select(ExpertProfile.category, func.count())
        .group_by(ExpertProfile.category)
    )
    rows = (await db.execute(stmt)).all()
    return [
        {"key": key, "label": EXPERT_CATEGORIES.get(key, key), "count": count}
        for key, count in rows
    ]


async def get_featured(db: AsyncSession) -> dict:
    """获取精选场景 + 精选专家。."""
    stmt = (
        select(Agent, ExpertProfile)
        .join(ExpertProfile, ExpertProfile.agent_id == Agent.id)
        .where(ExpertProfile.featured)
        .order_by(ExpertProfile.sort_order.desc())
    )
    rows = (await db.execute(stmt)).all()
    experts = [await ExpertAssembler.assemble(db, agent, profile) for agent, profile in rows]

    scenes = [
        {
            "id": s["id"],
            "label": s["label"],
            "color": s["color"],
            "expert_ids": [e.id for e in experts if e.scene == s["id"]],
        }
        for s in FEATURED_SCENES
    ]
    return {"scenes": scenes, "experts": experts}


# ── 同步 API ─────────────────────────────────────────────────

async def sync_list(db: AsyncSession) -> ExpertSyncListResponse:
    """获取所有已发布专家的精简数据（供桌面端/移动端同步）。."""
    stmt = (
        select(Agent, ExpertProfile)
        .join(ExpertProfile, ExpertProfile.agent_id == Agent.id)
        .where(
            ExpertProfile.is_published,
            Agent.status == "active",
        )
        .order_by(ExpertProfile.sort_order.desc())
    )
    rows = (await db.execute(stmt)).all()
    items = [
        await ExpertAssembler.to_sync_item(await ExpertAssembler.assemble(db, agent, profile))
        for agent, profile in rows
    ]
    return ExpertSyncListResponse(
        items=items, total=len(items), synced_at=int(time.time()),
    )


async def sync_detail(db: AsyncSession, expert_id: str) -> ExpertInfo:
    """获取单个专家的完整配置（供桌面端同步详情）。."""
    return await get_expert(db, expert_id)


# ── 内置专家种子数据 ─────────────────────────────────────────────────

BUILTIN_EXPERTS: list[dict] = [
    {
        "name": "文档写作专家",
        "title": "文档写作专家",
        "category": "content_creation",
        "description": "根据写作要求撰写结构完整、内容充实的文章，并调用 AI 图像生成服务在合适位置插入配图，输出可直接使用的 Markdown 文章。",
        "tags": ["文档写作", "文章撰写", "AI配图", "内容创作"],
        "icon": "✍️",
        "color": "linear-gradient(135deg,#f59e0b,#d97706)",
        "initials": "文",
        "featured": False,
        "scene": None,
        "sort_order": 0,
        "is_published": True,
        "model_name": "deepseek-v4-pro",
        "mcp_tool_name": "AI 图像生成",
        "system_prompt": (
            "你是 WorkMate 的「文档写作专家」。你的任务是：根据用户提出的写作要求，"
            "撰写一篇结构完整、内容充实、语言流畅的文章，并在文章中合适的位置配以恰当的插图。\n"
            "\n"
            "## 写作流程\n"
            "1. 理解用户的写作要求（主题、体裁、受众、篇幅、风格等），如信息不足可先向用户确认关键信息。\n"
            "2. 规划文章结构：拟定标题、引言、若干小节（带小标题）与结尾。\n"
            "3. 分节撰写正文，语言生动准确、逻辑清晰，避免空话套话。\n"
            "4. 在适合插图的位置（如封面、章节开头、概念说明处、总结处）调用图像生成工具生成配图，"
            "并将图片以 Markdown 图片语法 ![](图片地址) 嵌入正文。\n"
            "\n"
            "## 图像生成工具使用规范\n"
            "- 使用 AI 图像生成服务中的工具生成配图，可用工具：\n"
            "  - text_to_image：生成单张图片，适合封面图或单一概念插图；\n"
            "  - text_to_image_batch：一次生成多张风格一致的图片，适合组图或系列插图；\n"
            "  - image_to_image_batch：基于参考图批量生成，用户提供参考图时使用。\n"
            "- 配图数量：按文章篇幅决定，通常 1000 字以内配 1-3 张，更长文章适当增加，避免过度配图。\n"
            "- 为每张配图编写高质量提示词（prompt），描述画面主体、风格、构图与氛围，"
            "确保图片与所在章节内容高度相关。\n"
            "- 调用后从返回结果的 images 列表取出图片 url，用 ![](url) 嵌入到对应段落之后。\n"
            "- 若图片生成失败（返回 error），不要中断文章输出，继续完成写作并在该位置省略图片即可。\n"
            "\n"
            "## 输出要求\n"
            "- 最终输出完整的 Markdown 文章，包含标题、正文层级与配图，可直接阅读、直接复制使用。"
        ),
    },
]


async def seed_builtin_experts(db: AsyncSession) -> None:
    """填充内置专家（文档写作专家），可重复调用：不存在时创建并关联 MCP 服务。."""
    main_agent_id = await _get_main_agent_id(db)

    for item in BUILTIN_EXPERTS:
        existing = (
            await db.execute(select(Agent).where(Agent.name == item["name"]))
        ).scalar_one_or_none()
        if existing is not None:
            logger.info("内置专家 '%s' 已存在，跳过", item["name"])
            continue

        provider_id = None
        model_id = None
        model_name = item.get("model_name")
        if model_name:
            model = (
                await db.execute(
                    select(AIModel).where(
                        AIModel.name == model_name,
                        AIModel.type.in_(("llm", "vision", "multimodal")),
                    )
                )
            ).scalar_one_or_none()
            if model is not None:
                provider_id = model.provider_id
                model_id = model.id
            else:
                logger.warning("内置专家默认模型 %s 未找到，使用默认 LLM", model_name)

        agent = Agent(
            name=item["name"],
            type="expert",
            status="active",
            description=item["description"],
            parent_id=main_agent_id,
            system_prompt=item["system_prompt"],
            provider_id=provider_id,
            model_id=model_id,
        )
        db.add(agent)
        await db.flush()

        profile = ExpertProfile(
            agent_id=agent.id,
            title=item["title"],
            category=item["category"],
            tags=item.get("tags", []),
            icon=item.get("icon", ""),
            color=item.get("color", ""),
            initials=item.get("initials", item["name"][:1]),
            featured=item.get("featured", False),
            scene=item.get("scene"),
            sort_order=item.get("sort_order", 0),
            is_published=item.get("is_published", True),
        )
        db.add(profile)

        mcp_tool_name = item.get("mcp_tool_name")
        if mcp_tool_name:
            mcp_tool = (
                await db.execute(select(McpTool).where(McpTool.name == mcp_tool_name))
            ).scalar_one_or_none()
            if mcp_tool is not None:
                db.add(
                    AgentMcpConfig(
                        agent_id=agent.id,
                        mcp_tool_id=mcp_tool.id,
                        config={
                            "transport": mcp_tool.transport or "streamable_http",
                            "url": mcp_tool.streamable_http_url or mcp_tool.url or "",
                            "command": "",
                            "args": [],
                            "env": {},
                        },
                        enabled=True,
                    )
                )
                logger.info(
                    "为内置专家 '%s' 关联 MCP 服务 '%s'",
                    item["name"],
                    mcp_tool_name,
                )
            else:
                logger.warning(
                    "内置专家关联的 MCP 服务 '%s' 未找到，跳过",
                    mcp_tool_name,
                )

        await _create_agent_version_snapshot(
            db,
            agent,
            [],
            [],
            change_summary="创建内置专家",
        )
        logger.info("已创建内置专家 '%s' (id=%s)", agent.name, agent.id)
