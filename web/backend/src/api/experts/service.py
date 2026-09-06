"""专家管理业务逻辑层（以 experts 表为主）。.

设计说明：
- 工厂模式（Factory）：ExpertAssembler 负责将 Expert ORM 模型组装为
  ExpertInfo 响应对象，避免在各 service 函数中重复组装。
- 策略模式（Strategy）：排序逻辑通过 SortStrategy 字典注入，新增排序只需
  添加一个排序函数和一条映射。
- 适配器模式（Adapter）：to_sync_item 将 ExpertInfo 适配为桌面端同步所需
  的 ExpertSyncItem，隔离内部数据结构与外部接口契约。
- 数据主表：专家 CRUD 与查询全部基于 experts 表（含 expert_tools、
  expert_skills、expert_mcp_configs、expert_versions 关联数据），
  不再读写 agents / expert_profiles。
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from agent.graph import invalidate_graph
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
from db.models.ai_model import AIModel
from db.models.expert import Expert
from db.models.expert_mcp_config import ExpertMcpConfig
from db.models.expert_skill import ExpertSkill
from db.models.expert_tool import ExpertTool
from db.models.expert_version import ExpertVersion
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
    {
        "id": "content",
        "label": "内容创作",
        "color": "linear-gradient(135deg,#f59e0b,#d97706)",
    },
    {
        "id": "invest",
        "label": "投资分析",
        "color": "linear-gradient(135deg,#0891b2,#0e7490)",
    },
    {
        "id": "legal",
        "label": "法律财税",
        "color": "linear-gradient(135deg,#6366f1,#4f46e5)",
    },
    {
        "id": "sme",
        "label": "小微企业",
        "color": "linear-gradient(135deg,#10b981,#059669)",
    },
]


# ── 工厂模式：ExpertAssembler ─────────────────────────────────


class ExpertAssembler:
    """将 Expert ORM 模型组装为 ExpertInfo 响应对象。."""

    @staticmethod
    async def assemble(db: AsyncSession, expert: Expert) -> ExpertInfo:
        """从 Expert 记录组装完整的 ExpertInfo。."""
        tools = await _query_tools(db, expert.id)
        skills = await _query_skills(db, expert.id)
        mcp_configs = await _query_mcp_configs(db, expert.id)

        model_name = None
        model_type = None
        if expert.model_id:
            model = (
                await db.execute(select(AIModel).where(AIModel.id == expert.model_id))
            ).scalar_one_or_none()
            if model is not None:
                model_name = model.name
                model_type = model.type

        return ExpertInfo(
            id=expert.id,
            name=expert.name,
            title=expert.title,
            description=expert.description,
            category=expert.category,
            tags=expert.tags if isinstance(expert.tags, list) else [],
            icon=expert.icon,
            color=expert.color,
            initials=expert.initials,
            avatar_url=expert.avatar_url,
            rating=expert.rating,
            usage_count=expert.usage_count,
            featured=expert.featured,
            scene=expert.scene,
            sort_order=expert.sort_order,
            is_published=expert.is_published,
            status=expert.status,
            system_prompt=expert.system_prompt or "",
            provider_id=expert.provider_id,
            model_id=expert.model_id,
            model_name=model_name,
            model_type=model_type,
            prompt_template="",
            expertise_areas=[],
            tools=tools,
            skills=skills,
            mcp_configs=mcp_configs,
            files=expert.files if isinstance(expert.files, list) else [],
            created_at=expert.created_at,
            updated_at=expert.updated_at,
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

SortStrategy = Callable[[list[Expert]], list[Expert]]


def _sort_by_rating(rows: list[Expert]) -> list[Expert]:
    return sorted(rows, key=lambda r: (-r.rating, -r.sort_order))


def _sort_by_usage(rows: list[Expert]) -> list[Expert]:
    return sorted(rows, key=lambda r: (-r.usage_count, -r.sort_order))


def _sort_by_recent(rows: list[Expert]) -> list[Expert]:
    return sorted(rows, key=lambda r: r.updated_at, reverse=True)


def _sort_by_name(rows: list[Expert]) -> list[Expert]:
    return sorted(rows, key=lambda r: r.name)


SORT_STRATEGIES: dict[str, SortStrategy] = {
    "rating": _sort_by_rating,
    "usage": _sort_by_usage,
    "recent": _sort_by_recent,
    "name": _sort_by_name,
}


# ── 查询辅助 ─────────────────────────────────────────────────


async def _query_tools(db: AsyncSession, expert_id: str) -> list[ToolBrief]:
    stmt = (
        select(Tool)
        .join(ExpertTool, ExpertTool.tool_id == Tool.id)
        .where(ExpertTool.expert_id == expert_id)
        .order_by(Tool.name)
    )
    rows = (await db.execute(stmt)).scalars().all()
    return [
        ToolBrief(
            id=t.id,
            name=t.name,
            display_name=t.display_name,
            tool_type=t.tool_type,
            category=t.category,
            icon="",
        )
        for t in rows
    ]


async def _query_skills(db: AsyncSession, expert_id: str) -> list[ExpertSkillBrief]:
    stmt = (
        select(Skill)
        .join(ExpertSkill, ExpertSkill.skill_id == Skill.id)
        .where(ExpertSkill.expert_id == expert_id)
    )
    rows = (await db.execute(stmt)).scalars().all()
    return [
        ExpertSkillBrief(
            id=s.id,
            name=s.name,
            description=s.description,
            category=s.category,
            icon=s.icon,
            enabled=s.enabled,
        )
        for s in rows
    ]


async def _query_mcp_configs(db: AsyncSession, expert_id: str) -> list[McpConfigBrief]:
    stmt = (
        select(
            ExpertMcpConfig,
            McpTool.name,
            McpTool.transport,
            McpTool.url,
            McpTool.sse_url,
            McpTool.streamable_http_url,
        )
        .outerjoin(McpTool, McpTool.id == ExpertMcpConfig.mcp_tool_id)
        .where(ExpertMcpConfig.expert_id == expert_id)
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


async def _get_expert_or_404(db: AsyncSession, expert_id: str) -> Expert:
    """按 ID 获取专家，不存在时抛出 404。."""
    stmt = select(Expert).where(Expert.id == expert_id)
    expert = (await db.execute(stmt)).scalar_one_or_none()
    if expert is None:
        raise HTTPException(status_code=404, detail="专家不存在")
    return expert


async def _ensure_expert_name_available(
    db: AsyncSession,
    name: str,
    expert_id: str | None = None,
) -> None:
    """校验专家名称在 experts 与 agents 中均唯一。."""
    stmt = select(Expert).where(Expert.name == name)
    if expert_id is not None:
        stmt = stmt.where(Expert.id != expert_id)
    if (await db.execute(stmt)).scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail=f"专家名称 '{name}' 已存在")

    agent_stmt = select(Agent).where(Agent.name == name)
    if expert_id is not None:
        agent_stmt = agent_stmt.where(Agent.id != expert_id)
    if (await db.execute(agent_stmt)).scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail=f"智能体名称 '{name}' 已被使用")


def _format_usage_count(count: int) -> str:
    if count >= 10000:
        return f"{count / 1000:.1f}w"
    if count >= 1000:
        return f"{count / 1000:.1f}k"
    return str(count)


# ── 专家版本快照 ─────────────────────────────────────────────


async def _create_expert_version_snapshot(
    db: AsyncSession,
    expert: Expert,
    tool_names: list[str],
    skill_ids: list[str],
    changed_by: str = "",
    change_summary: str = "",
) -> ExpertVersion:
    """在修改前创建专家当前配置的版本快照。."""
    max_ver = (
        await db.execute(
            select(func.max(ExpertVersion.version)).where(
                ExpertVersion.expert_id == expert.id
            )
        )
    ).scalar() or 0

    snapshot = {
        "name": expert.name,
        "title": expert.title,
        "category": expert.category,
        "status": expert.status,
        "description": expert.description,
        "system_prompt": expert.system_prompt,
        "files": expert.files if isinstance(expert.files, list) else [],
        "provider_id": expert.provider_id,
        "model_id": expert.model_id,
        "featured": expert.featured,
        "is_published": expert.is_published,
        "tools": tool_names,
        "skills": skill_ids,
    }

    version = ExpertVersion(
        expert_id=expert.id,
        version=int(max_ver) + 1,
        snapshot=snapshot,
        changed_by=changed_by,
        change_summary=change_summary,
    )
    db.add(version)
    await db.flush()
    return version


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
    stmt = select(Expert)

    if keyword:
        kw = f"%{keyword}%"
        stmt = stmt.where(
            (Expert.name.ilike(kw))
            | (Expert.title.ilike(kw))
            | (Expert.description.ilike(kw))
        )

    if category:
        stmt = stmt.where(Expert.category == category)

    if featured is not None:
        stmt = stmt.where(Expert.featured == featured)

    if status:
        stmt = stmt.where(Expert.status == status)

    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = (await db.execute(count_stmt)).scalar() or 0

    rows = list((await db.execute(stmt)).scalars().all())
    strategy = SORT_STRATEGIES.get(sort, SORT_STRATEGIES["rating"])
    rows = strategy(rows)

    start = (page - 1) * page_size
    paged = rows[start : start + page_size]

    items = [await ExpertAssembler.assemble(db, expert) for expert in paged]

    return ExpertListResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
    )


async def get_expert(db: AsyncSession, expert_id: str) -> ExpertInfo:
    """获取单个专家详情。."""
    expert = await _get_expert_or_404(db, expert_id)
    return await ExpertAssembler.assemble(db, expert)


async def create_expert(db: AsyncSession, req: ExpertCreateRequest) -> ExpertInfo:
    """创建专家：在 experts 表写入主记录及工具/技能/MCP 关联。."""
    await _ensure_expert_name_available(db, req.name)

    expert = Expert(
        name=req.name,
        title=req.title,
        description=req.description,
        category=req.category,
        tags=list(req.tags),
        icon=req.icon,
        color=req.color,
        initials=req.initials,
        status="inactive",
        system_prompt=req.system_prompt,
        provider_id=req.provider_id,
        model_id=req.model_id,
        featured=req.featured,
        scene=req.scene or None,
    )
    db.add(expert)
    await db.flush()

    for tool_name in req.tool_names:
        tool = (
            await db.execute(select(Tool).where(Tool.name == tool_name))
        ).scalar_one_or_none()
        if tool is not None:
            db.add(ExpertTool(expert_id=expert.id, tool_id=tool.id))
        else:
            logger.warning("创建专家时工具 '%s' 未找到，跳过", tool_name)

    for skill_id in req.skill_ids:
        db.add(ExpertSkill(expert_id=expert.id, skill_id=skill_id))

    await _validate_mcp_configs(db, req.mcp_configs)
    for mcp_cfg in req.mcp_configs:
        db.add(
            ExpertMcpConfig(
                expert_id=expert.id,
                mcp_tool_id=mcp_cfg.mcp_tool_id,
                config=mcp_cfg.config,
                enabled=mcp_cfg.enabled,
            )
        )

    await db.flush()
    await _create_expert_version_snapshot(
        db,
        expert,
        req.tool_names,
        req.skill_ids,
        change_summary="创建专家",
    )
    await invalidate_graph()

    logger.info("创建专家 '%s' (id=%s)", expert.name, expert.id)
    return await ExpertAssembler.assemble(db, expert)


async def update_expert(
    db: AsyncSession, expert_id: str, req: ExpertUpdateRequest
) -> ExpertInfo:
    """更新专家基础信息（名称、头衔、描述、提示词、模型）。."""
    expert = await _get_expert_or_404(db, expert_id)
    await _ensure_expert_name_available(db, req.name, expert_id=expert_id)

    current_tool_names = [t.name for t in await _query_tools(db, expert_id)]
    current_skill_ids = [s.id for s in await _query_skills(db, expert_id)]
    await _create_expert_version_snapshot(
        db,
        expert,
        current_tool_names,
        current_skill_ids,
        change_summary="更新专家基础信息",
    )

    expert.name = req.name
    expert.title = req.title
    expert.description = req.description
    expert.system_prompt = req.system_prompt
    expert.provider_id = req.provider_id
    expert.model_id = req.model_id

    await db.flush()
    await invalidate_graph()

    return await ExpertAssembler.assemble(db, expert)


async def update_expert_profile(
    db: AsyncSession, expert_id: str, req: ExpertProfileUpdateRequest
) -> ExpertInfo:
    """更新专家展示元数据（部分更新）。."""
    expert = await _get_expert_or_404(db, expert_id)

    if req.title is not None:
        expert.title = req.title
    if req.category is not None:
        expert.category = req.category
    if req.tags is not None:
        expert.tags = list(req.tags)
    if req.icon is not None:
        expert.icon = req.icon
    if req.color is not None:
        expert.color = req.color
    if req.initials is not None:
        expert.initials = req.initials
    if req.avatar_url is not None:
        expert.avatar_url = req.avatar_url
    if req.featured is not None:
        expert.featured = req.featured
    if req.scene is not None:
        expert.scene = req.scene or None
    if req.sort_order is not None:
        expert.sort_order = req.sort_order
    if req.is_published is not None:
        expert.is_published = req.is_published

    await db.flush()
    return await ExpertAssembler.assemble(db, expert)


async def update_expert_config(
    db: AsyncSession, expert_id: str, req: ExpertConfigUpdateRequest
) -> ExpertInfo:
    """批量更新专家配置（模型 + 提示词 + 工具 + 技能 + MCP）。.

    采用「先快照 → 全量替换关联 → 提交」事务模式。
    """
    expert = await _get_expert_or_404(db, expert_id)

    current_tool_names = [t.name for t in await _query_tools(db, expert_id)]
    current_skill_ids = [s.id for s in await _query_skills(db, expert_id)]
    await _create_expert_version_snapshot(
        db,
        expert,
        current_tool_names,
        current_skill_ids,
        change_summary="更新专家配置",
    )

    if req.system_prompt is not None:
        expert.system_prompt = req.system_prompt
    if req.provider_id is not None:
        expert.provider_id = req.provider_id
    if req.model_id is not None:
        expert.model_id = req.model_id

    if req.tool_names is not None:
        await _replace_tool_links(db, expert_id, req.tool_names)

    if req.skill_ids is not None:
        await _replace_skill_links(db, expert_id, req.skill_ids)

    if req.mcp_configs is not None:
        await _replace_mcp_configs(db, expert_id, req.mcp_configs)

    await db.flush()
    await invalidate_graph()

    return await ExpertAssembler.assemble(db, expert)


async def _replace_tool_links(
    db: AsyncSession, expert_id: str, tool_names: list[str]
) -> None:
    """全量替换 expert_tools 关联。."""
    old = (
        (await db.execute(select(ExpertTool).where(ExpertTool.expert_id == expert_id)))
        .scalars()
        .all()
    )
    for link in old:
        await db.delete(link)

    for name in tool_names:
        tool = (
            await db.execute(select(Tool).where(Tool.name == name))
        ).scalar_one_or_none()
        if tool is not None:
            db.add(ExpertTool(expert_id=expert_id, tool_id=tool.id))
        else:
            logger.warning("工具 '%s' 未找到，跳过", name)


async def _replace_skill_links(
    db: AsyncSession, expert_id: str, skill_ids: list[str]
) -> None:
    """全量替换 expert_skills 关联。."""
    old = (
        (
            await db.execute(
                select(ExpertSkill).where(ExpertSkill.expert_id == expert_id)
            )
        )
        .scalars()
        .all()
    )
    for link in old:
        await db.delete(link)

    for skill_id in skill_ids:
        db.add(ExpertSkill(expert_id=expert_id, skill_id=skill_id))


async def _validate_mcp_configs(db: AsyncSession, configs: list[McpConfigItem]) -> None:
    """校验 MCP 配置列表无重复且服务存在。."""
    seen: set[str] = set()
    for item in configs:
        if item.mcp_tool_id in seen:
            raise HTTPException(
                status_code=409, detail=f"MCP 服务重复配置: {item.mcp_tool_id}"
            )
        seen.add(item.mcp_tool_id)
        mcp_tool = (
            await db.execute(select(McpTool).where(McpTool.id == item.mcp_tool_id))
        ).scalar_one_or_none()
        if mcp_tool is None:
            raise HTTPException(
                status_code=404, detail=f"MCP 服务不存在: {item.mcp_tool_id}"
            )


async def _replace_mcp_configs(
    db: AsyncSession, expert_id: str, configs: list[McpConfigItem]
) -> None:
    """全量替换 expert_mcp_configs。."""
    old = (
        (
            await db.execute(
                select(ExpertMcpConfig).where(ExpertMcpConfig.expert_id == expert_id)
            )
        )
        .scalars()
        .all()
    )
    for cfg in old:
        await db.delete(cfg)

    await _validate_mcp_configs(db, configs)
    for item in configs:
        db.add(
            ExpertMcpConfig(
                expert_id=expert_id,
                mcp_tool_id=item.mcp_tool_id,
                config=item.config,
                enabled=item.enabled,
            )
        )


async def delete_expert(db: AsyncSession, expert_id: str) -> None:
    """删除专家（级联删除关联工具/技能/MCP/版本数据）。."""
    expert = await _get_expert_or_404(db, expert_id)
    if expert.undeletable:
        raise HTTPException(status_code=403, detail="该专家不可删除")

    await db.delete(expert)
    await db.flush()
    await invalidate_graph()
    logger.info("删除专家 '%s' (id=%s)", expert.name, expert.id)


async def toggle_expert_status(db: AsyncSession, expert_id: str) -> ExpertInfo:
    """切换专家启用/停用状态。."""
    expert = await _get_expert_or_404(db, expert_id)
    expert.status = "inactive" if expert.status == "active" else "active"
    await db.flush()
    await invalidate_graph()
    return await ExpertAssembler.assemble(db, expert)


async def clone_expert(db: AsyncSession, expert_id: str) -> ExpertInfo:
    """克隆专家：复制 Expert 主记录与全部关联数据。."""
    source = await _get_expert_or_404(db, expert_id)

    base_name = f"{source.name} (副本)"
    new_name = base_name
    counter = 2
    while True:
        try:
            await _ensure_expert_name_available(db, new_name)
            break
        except HTTPException:
            new_name = f"{base_name} {counter}"
            counter += 1

    cloned = Expert(
        name=new_name,
        title=source.title,
        description=source.description,
        category=source.category,
        tags=list(source.tags) if isinstance(source.tags, list) else [],
        icon=source.icon,
        color=source.color,
        initials=source.initials,
        avatar_url=source.avatar_url,
        status="inactive",
        system_prompt=source.system_prompt,
        provider_id=source.provider_id,
        model_id=source.model_id,
        files=list(source.files) if isinstance(source.files, list) else [],
        featured=False,
        scene=None,
        sort_order=0,
        is_published=True,
        undeletable=False,
    )
    db.add(cloned)
    await db.flush()

    tool_links = (
        (await db.execute(select(ExpertTool).where(ExpertTool.expert_id == expert_id)))
        .scalars()
        .all()
    )
    for tool_link in tool_links:
        db.add(ExpertTool(expert_id=cloned.id, tool_id=tool_link.tool_id))

    skill_links = (
        (
            await db.execute(
                select(ExpertSkill).where(ExpertSkill.expert_id == expert_id)
            )
        )
        .scalars()
        .all()
    )
    for skill_link in skill_links:
        db.add(ExpertSkill(expert_id=cloned.id, skill_id=skill_link.skill_id))

    mcp_configs = (
        (
            await db.execute(
                select(ExpertMcpConfig).where(ExpertMcpConfig.expert_id == expert_id)
            )
        )
        .scalars()
        .all()
    )
    for cfg in mcp_configs:
        db.add(
            ExpertMcpConfig(
                expert_id=cloned.id,
                mcp_tool_id=cfg.mcp_tool_id,
                config=cfg.config,
                enabled=cfg.enabled,
            )
        )

    await db.flush()
    await invalidate_graph()
    logger.info("克隆专家 '%s' -> '%s'", source.name, cloned.name)
    return await ExpertAssembler.assemble(db, cloned)


# ── 分类与精选 ───────────────────────────────────────────────


async def list_categories(db: AsyncSession) -> list[dict[str, Any]]:
    """获取所有分类及计数。."""
    stmt = select(Expert.category, func.count()).group_by(Expert.category)
    rows = (await db.execute(stmt)).all()
    return [
        {"key": key, "label": EXPERT_CATEGORIES.get(key, key), "count": count}
        for key, count in rows
    ]


async def get_featured(db: AsyncSession) -> dict[str, Any]:
    """获取精选场景 + 精选专家。."""
    stmt = select(Expert).where(Expert.featured).order_by(Expert.sort_order.desc())
    rows = (await db.execute(stmt)).scalars().all()
    experts = [await ExpertAssembler.assemble(db, expert) for expert in rows]

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
        select(Expert)
        .where(
            Expert.is_published,
            Expert.status == "active",
        )
        .order_by(Expert.sort_order.desc())
    )
    rows = (await db.execute(stmt)).scalars().all()
    items = [
        await ExpertAssembler.to_sync_item(await ExpertAssembler.assemble(db, expert))
        for expert in rows
    ]
    return ExpertSyncListResponse(
        items=items,
        total=len(items),
        synced_at=int(time.time()),
    )


async def sync_detail(db: AsyncSession, expert_id: str) -> ExpertInfo:
    """获取单个专家的完整配置（供桌面端同步详情）。."""
    return await get_expert(db, expert_id)


BUILTIN_EXPERTS: list[dict[str, Any]] = [
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
        "system_prompt": r"""你是 WorkMate 的「文档写作专家」。你的任务是：根据用户提出的写作要求，撰写一篇结构完整、内容充实、语言流畅的文章；在文中合适的位置配图，并把配图和文章一并保存到本次会话绑定的工作区目录。

## 写作流程
1. 理解用户的写作要求（主题、体裁、受众、篇幅、风格等），如信息不足可先向用户确认关键信息。
2. 规划文章结构：拟定标题、引言、若干小节（带小标题）与结尾。
3. 分节撰写正文，语言生动准确、逻辑清晰，避免空话套话。

## 工作区落盘要求（必须执行，不能省略）
- 文件工具的工作根目录 = 会话绑定的工作区。文件工具使用虚拟路径表示工作区：工作区根目录是 /；execute 的当前目录就是工作区的物理目录。
- 文章保存到工作区根目录，文件名用文章标题，扩展名为 .md（如 文章标题.md；若同名文件已存在，则追加 -1、-2 等序号，避免覆盖），文件名不要包含 Windows 非法字符。
- 图片必须保存在与文章文件同名的目录中：目录名与最终确定的文章文件名一致（不含 .md 扩展名）。例如文章保存为 /文章标题.md 时，图片目录必须是 /文章标题/；若文章因重名保存为 /文章标题-1.md，图片目录必须是 /文章标题-1/。所有配图只允许保存到该同名目录。

### 配图与图片落盘步骤
1. 在适合插图的位置（封面、章节开头、概念说明处、总结处）调用 AI 图像生成工具生成配图；可用工具：text_to_image（单张）、text_to_image_batch（风格一致的组图）、image_to_image_batch（基于参考图）。
2. 工具返回的 images 列表里的 url 是临时网络地址，严禁直接写进文章或最终回复。
3. 开始落盘前先用 write_file 确定最终文章文件名，随后用 execute 创建同名图片目录，并把每张图下载到该目录（execute 当前目录就是工作区根目录；把 <目录名> 替换为与最终文章文件同名的实际目录名）：
   - 先确保目录存在：if not exist "<目录名>" mkdir "<目录名>"
   - 再下载：curl.exe -sS -L -o "<目录名>\figure-1.png" "<图片url>"
   - 若 curl 不可用，改用 PowerShell：powershell -NoProfile -Command "Invoke-WebRequest -Uri '<图片url>' -OutFile '<目录名>\figure-1.png'"
   - 图片按插入顺序命名为 figure-1.png、figure-2.png……，扩展名与实际格式一致（jpg/png/webp 等）。
4. 每下载一张图后用 ls /<目录名> 校验文件存在且非空；失败重试一次，仍失败则跳过该图，并在最终回复中说明哪张图未保存。

### 保存文章
- 全部配图落盘后，用 write_file 把完整 Markdown 文章写入工作区根目录对应的虚拟路径：/文章标题.md（实际文件名须与同名图片目录一一对应）。
- 文章内图片一律使用相对路径，并且必须从同名图片目录引用：![](文章标题/figure-1.png)。例如文章保存为 /文章标题.md 时，配图引用写 ![](文章标题/figure-1.png)；文章保存为 /文章标题-1.md 时，配图引用写 ![](文章标题-1/figure-1.png)。禁止使用 http(s) 网络地址、file:// 绝对路径或 base64 data URI 作为图片引用。

## 输出要求
- 最终回复开头用 execute 执行 cd 取得工作区物理绝对路径，并说明：文章已保存到哪里（物理绝对路径 + 文件名）、同名图片目录（物理绝对路径）、已保存图片文件名清单。
- 随后输出完整 Markdown 文章正文；正文中的图片引用与文件内保持一致（<目录名>/figure-N.png 相对路径），不要输出网络图片地址。
- 若图片生成或落盘失败，不要中断文章输出，继续完成写作并在回复中明确标注该图未保存。""",
    },
    {
        "name": "视频创作专家",
        "title": "视频创作专家",
        "category": "content_creation",
        "description": "基于阿里云百炼 wan3.0-video 模型完成短视频创作：支持文生视频及参考素材生成视频，根据内容主动确定时长与分辨率，并将成片下载到与交付文档同名的本地目录，输出可播放、暂停、停止视频的 Markdown 文档。",
        "tags": ["视频创作", "文生视频", "短视频", "AI视频生成", "wan3.0-video"],
        "icon": "🎬",
        "color": "linear-gradient(135deg,#8b5cf6,#6d28d9)",
        "initials": "视",
        "featured": False,
        "scene": None,
        "sort_order": 0,
        "is_published": True,
        "model_name": "deepseek-v4-pro",
        "mcp_tool_name": "AI 视频生成",
        "system_prompt": """你是 WorkMate 的「视频创作专家」。你的任务是根据用户的创意需求，调用 AI 视频生成服务（阿里云百炼 wan3.0-video）生成短视频，把成片下载到与交付文档同名的本地视频目录，并交付一份文档内可直接播放、暂停、停止视频的 Markdown 文档。

## 创作流程
1. 理解需求：明确视频主题、画面内容、风格、用途与投放平台、旁白文案、画幅比例、分辨率、是否带声音等关键信息；信息不足时先向用户确认，不要擅自假设。
2. 规划时长与分辨率（必须根据内容主动确定，不得默认套用 5 秒/480P）：
   - duration（2-30 秒整数）：根据内容复杂度与脚本量估算。单条口号或单个镜头（产品特写、Logo 展示等）用 2-5 秒；1-2 个镜头加一句话口播用 5-8 秒；2-4 个分镜或一段完整口播用 8-15 秒；多场景叙事、较长旁白用 15-30 秒。中文口播可按约 4 字/秒估算，每个分镜至少留 2-3 秒，并预留 1-2 秒呼吸或转场。
   - resolution（480P/720P/1080P）：正式发布或画质优先选 1080P；常规成片默认 720P 起步；仅快速预览或低成本试片才用 480P。
   - ratio：竖屏短视频平台（抖音/快手/小红书/视频号等）优先 9:16；横屏宣传片、教程、B 站等用 16:9；其余按内容形态从 adaptive/4:3/1:1/3:4 中合理选择。
   - audio：默认 true；用户明确不要声音才传 false。
   - 规划完成后，说明为什么选择该时长、分辨率与画幅，便于用户核对。
3. 形成脚本：把创意拆解为一段可执行的画面描述（prompt），描述主体、动作、场景、镜头运动、风格、光线、氛围等；内容包含多个分镜时逐支生成，并保证每支都按第 2 步规划传入时长与分辨率。
4. 调用 MCP 工具的 generate_video 提交任务：
   - 每次调用都必须显式传入按内容确定的 duration、resolution、ratio，不得省略依赖工具默认值。
   - 若用户提供了首帧、尾帧、参考图、参考视频、参考音频等素材，把每个素材放入 media 参数，格式为 {"type": "...", "url": "..."}；type 可选 first_frame、last_frame、reference_image、reference_video、reference_audio 等。素材必须是公网可访问 URL 或 data URI，本地文件无法直接使用，需先告知用户提供可访问链接。
   - 其余参数按需设置：audio 默认 true；prompt_extend 默认 true；watermark 默认 false，用户要求添加或去除水印时按需设置。
5. 等待与查询：默认 wait=true 会轮询等待结果。若返回仍在处理（含 timed_out），把 task_id 告知用户，并调用 query_video_generation 继续查询，直到任务结束；严禁编造任务状态或 video_url。

## 工作区落盘要求（必须执行，不能省略）
- 文件工具的工作根目录 = 会话绑定的工作区。文件工具使用虚拟路径表示工作区：工作区根目录是 /；execute 的当前目录就是工作区的物理目录。
- 交付物为“文档 + 与文档同名的视频目录”：文档保存到工作区根目录，文件名用交付标题，扩展名为 .md（如 视频标题.md；若同名文件已存在，则追加 -1、-2 等序号，避免覆盖），文件名不要包含 Windows 非法字符。
- 视频必须保存在与文档文件同名的目录中：目录名与最终确定的文档文件名一致（不含 .md 扩展名）。例如文档保存为 /视频标题.md 时，视频目录必须是 /视频标题/；若文档因重名保存为 /视频标题-1.md，视频目录必须是 /视频标题-1/。所有成片只允许保存到该同名目录。

### 成片下载步骤
1. 每支视频生成成功（task_status=SUCCEEDED 且返回 video_url）后，开始落盘前先用 write_file 确定最终文档文件名，随后用 execute 创建同名视频目录（execute 当前目录就是工作区根目录；把 <目录名> 替换为与最终文档文件同名的实际目录名）：
   - 先确保目录存在：if not exist "<目录名>" mkdir "<目录名>"
   - 再下载：curl.exe -sS -L -o "<目录名>\成片-1.mp4" "<video_url>"
   - 若 curl 不可用，改用 PowerShell：powershell -NoProfile -Command "Invoke-WebRequest -Uri '<video_url>' -OutFile '<目录名>\成片-1.mp4'"
   - 成片按生成顺序命名为 成片-1.mp4、成片-2.mp4……（以服务实际返回的文件格式确定扩展名，通常为 mp4）。
2. 每下载一支后用 ls /<目录名> 校验文件存在且非空；失败重试一次，仍失败则跳过该成片，并在最终文档和回复中说明哪支未保存。

### 保存文档
- 全部成片落盘后，用 write_file 把完整 Markdown 文档写入工作区根目录对应的虚拟路径：/视频标题.md（实际文件名须与同名视频目录一一对应）。
- 文档内视频一律使用 HTML5 video 标签引用同名视频目录中的本地文件，必须带 controls 属性，使用户能在文档内播放、暂停（停止播放）视频（controls 自带播放/暂停/进度/音量控制）：
  <video controls preload="none" style="max-width:100%;border-radius:8px" src="视频标题/成片-1.mp4"></video>
  例如文档保存为 /视频标题.md 时，视频引用写 src="视频标题/成片-1.mp4"；文档保存为 /视频标题-1.md 时，视频引用写 src="视频标题-1/成片-1.mp4"。禁止在文档中使用 http(s) 临时网络地址、file:// 绝对路径或 data URI 作为视频引用。
- 每支视频下方用 Markdown 说明其文件名、内容、时长、分辨率与画幅；文档结构建议包含：标题、创作说明/分镜表、成片及可播放控件。

## 输出要求
- 最终回复开头用 execute 执行 cd 取得工作区物理绝对路径，并说明：文档已保存到哪里（物理绝对路径 + 文件名）、同名视频目录（物理绝对路径）、已保存成片文件名清单，以及每支成片使用的时长、分辨率、画幅、声音参数。
- 随后输出完整 Markdown 文档正文；正文中的视频标签与文件内保持一致（<目录名>/成片-N.mp4 相对路径），不要输出网络视频地址。如需提醒用户临时链接有效期，可在正文之外的说明中告知 video_url 通常 24 小时内有效。
- 任务失败（FAILED/CANCELED 等）时如实说明错误原因，并可在用户同意后调整 prompt 或参数重试；不要中断文档输出，可在文档中标注未成功的片段。

## 注意事项
- 只使用工具实际返回的信息，不虚构链接、任务状态或耗时。
- 一次会话内可生成多条视频；再次生成时按内容重新规划 prompt、时长与分辨率以获得更好效果。
- 用户提供的参考素材若无法访问，应明确说明，不强行提交。""",
    },
]
# ── 内置专家种子数据 ─────────────────────────────────────────────────


async def seed_builtin_experts(db: AsyncSession) -> None:
    """填充内置专家（文档写作/视频创作专家），可重复调用：不存在时创建并关联 MCP 服务。."""
    for item in BUILTIN_EXPERTS:
        existing = (
            await db.execute(select(Expert).where(Expert.name == item["name"]))
        ).scalar_one_or_none()
        if existing is not None:
            logger.info("内置专家 '%s' 已存在，跳过", item["name"])
            continue

        agent_existing = (
            await db.execute(select(Agent).where(Agent.name == item["name"]))
        ).scalar_one_or_none()
        if agent_existing is not None:
            logger.warning("内置专家名称 '%s' 已被智能体占用，跳过", item["name"])
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

        expert = Expert(
            name=item["name"],
            title=item["title"],
            category=item["category"],
            description=item["description"],
            tags=list(item.get("tags", [])),
            icon=item.get("icon", ""),
            color=item.get("color", ""),
            initials=item.get("initials", item["name"][:1]),
            featured=item.get("featured", False),
            scene=item.get("scene"),
            sort_order=item.get("sort_order", 0),
            is_published=item.get("is_published", True),
            status="active",
            system_prompt=item["system_prompt"],
            provider_id=provider_id,
            model_id=model_id,
        )
        db.add(expert)
        await db.flush()

        mcp_tool_name = item.get("mcp_tool_name")
        if mcp_tool_name:
            mcp_tool = (
                await db.execute(select(McpTool).where(McpTool.name == mcp_tool_name))
            ).scalar_one_or_none()
            if mcp_tool is not None:
                db.add(
                    ExpertMcpConfig(
                        expert_id=expert.id,
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

        await _create_expert_version_snapshot(
            db,
            expert,
            [],
            [],
            change_summary="创建内置专家",
        )
        logger.info("已创建内置专家 '%s' (id=%s)", expert.name, expert.id)
