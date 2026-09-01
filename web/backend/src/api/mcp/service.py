"""MCP 广场业务逻辑：工具列表、安装、卸载。"""

import logging
import re
import uuid

from fastapi import HTTPException
from sqlalchemy import case, func, select
from sqlalchemy.dialects.sqlite import JSON as SQLiteJSON
from sqlalchemy.ext.asyncio import AsyncSession

from api.mcp.schemas import McpToolResponse
from db.models.mcp_installation import McpInstallation
from db.models.mcp_tool import McpTool

logger = logging.getLogger(__name__)




_MCP_TOOL_ICON = '🔧'


def _is_chinese_text(text: str) -> bool:
    return any('一' <= ch <= '鿿' for ch in text)


def _feature_tool_name(feature: str) -> str:
    if _is_chinese_text(feature):
        return feature.split('（')[0].split('(')[0].strip() or feature

    cleaned = feature.split('(')[0].strip()
    if re.fullmatch('[a-z0-9_]+', cleaned):
        return cleaned
    parts = [part.strip() for part in cleaned.split(',') if part.strip()]
    if parts:
        cleaned = parts[0]
    cleaned = cleaned.replace('/', ' ').replace('-', ' ')
    words = [word for word in cleaned.split() if word]
    if not words:
        return feature
    return ' '.join(words[:4]).title()


def _mcp_tool_items(tool: McpTool) -> list[dict[str, str]]:
    icon = tool.icon or _MCP_TOOL_ICON
    return [
        {'name': _feature_tool_name(feature), 'description': feature, 'icon': icon}
        for feature in (tool.features or [])
    ]

def _tool_to_response(
    tool: McpTool,
    installs: int = 0,
    installed: bool = False,
) -> McpToolResponse:
    """将 ORM McpTool 实例转换为包含计算字段的 McpToolResponse。"""
    return McpToolResponse(
        id=tool.id,
        name=tool.name,
        description=tool.description,
        icon=tool.icon,
        author=tool.author,
        version=tool.version,
        license=tool.license,
        repository=tool.repository,
        transport=tool.transport or 'stdio',
        url=tool.url or '',
        sse_url=tool.sse_url or '',
        streamable_http_url=tool.streamable_http_url or '',
        command=tool.command or '',
        args=tool.args or [],
        env=tool.env or {},
        installs=installs,
        rating=tool.rating,
        category=tool.category,
        tags=tool.tags or [],
        features=tool.features or [],
        official=tool.official,
        installed=installed,
        config_schema=tool.config_schema or [],
        tools=_mcp_tool_items(tool),
        created_at=tool.created_at,
        updated_at=tool.updated_at,
    )


async def list_mcp_tools(
    db: AsyncSession,
    user_id: str,
    category: str | None = None,
    search: str | None = None,
    sort: str | None = "popular",
) -> list[McpToolResponse]:
    """列出所有 MCP 工具，支持可选筛选、当前用户安装状态和安装数量。"""
    # 子查询：每个工具的安装数量
    install_count_subq = (
        select(
            McpInstallation.mcp_tool_id,
            func.count(McpInstallation.id).label("install_count"),
        )
        .group_by(McpInstallation.mcp_tool_id)
        .subquery()
    )

    # 子查询：当前用户已安装的工具 ID
    installed_subq = (
        select(McpInstallation.mcp_tool_id)
        .where(McpInstallation.user_id == user_id)
        .subquery()
    )

    # 主查询，带计算列
    stmt = select(
        McpTool,
        func.coalesce(install_count_subq.c.install_count, 0).label("installs"),
        case(
            (McpTool.id.in_(select(installed_subq.c.mcp_tool_id)), True),
            else_=False,
        ).label("installed"),
    ).outerjoin(
        install_count_subq,
        McpTool.id == install_count_subq.c.mcp_tool_id,
    )

    # 按分类筛选
    if category:
        stmt = stmt.where(McpTool.category == category)

    # 按关键字搜索（名称、描述、标签）
    if search:
        pattern = f"%{search}%"
        stmt = stmt.where(
            McpTool.name.like(pattern)
            | McpTool.description.like(pattern)
            | func.cast(McpTool.tags, SQLiteJSON).like(pattern)
        )

    # 排序
    if sort == "rating":
        stmt = stmt.order_by(McpTool.rating.desc())
    elif sort == "recent":
        stmt = stmt.order_by(McpTool.created_at.desc())
    else:  # 默认按流行度排序
        stmt = stmt.order_by(
            func.coalesce(install_count_subq.c.install_count, 0).desc()
        )

    rows = (await db.execute(stmt)).all()
    return [
        _tool_to_response(row[0], installs=row.installs, installed=row.installed)
        for row in rows
    ]


async def get_mcp_tool(
    db: AsyncSession,
    tool_id: str,
    user_id: str,
) -> McpToolResponse:
    """根据 ID 获取单个 MCP 工具，含安装数量和当前用户安装状态。"""
    # 安装数量
    install_count = (
        await db.execute(
            select(func.count())
            .select_from(McpInstallation)
            .where(McpInstallation.mcp_tool_id == tool_id)
        )
    ).scalar() or 0

    # 当前用户是否已安装
    user_installed = (
        await db.execute(
            select(McpInstallation.id).where(
                McpInstallation.user_id == user_id,
                McpInstallation.mcp_tool_id == tool_id,
            )
        )
    ).scalar_one_or_none() is not None

    # 查询工具记录
    tool = (
        await db.execute(select(McpTool).where(McpTool.id == tool_id))
    ).scalar_one_or_none()
    if tool is None:
        raise HTTPException(status_code=404, detail="MCP 工具未找到")

    return _tool_to_response(tool, installs=install_count, installed=user_installed)


async def install_mcp_tool(
    db: AsyncSession,
    user_id: str,
    mcp_id: str,
    config: dict | None = None,
) -> None:
    """为当前用户安装 MCP 工具。"""
    # 校验工具是否存在
    tool = (
        await db.execute(select(McpTool).where(McpTool.id == mcp_id))
    ).scalar_one_or_none()
    if tool is None:
        raise HTTPException(status_code=404, detail="MCP 工具未找到")

    # 检查是否已安装
    existing = (
        await db.execute(
            select(McpInstallation).where(
                McpInstallation.user_id == user_id,
                McpInstallation.mcp_tool_id == mcp_id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=409, detail="工具已安装")

    # 创建安装记录
    db.add(
        McpInstallation(
            id=str(uuid.uuid4()),
            user_id=user_id,
            mcp_tool_id=mcp_id,
            config=config or {},
        )
    )


async def uninstall_mcp_tool(
    db: AsyncSession,
    user_id: str,
    tool_id: str,
) -> None:
    """为当前用户卸载 MCP 工具。"""
    installation = (
        await db.execute(
            select(McpInstallation).where(
                McpInstallation.user_id == user_id,
                McpInstallation.mcp_tool_id == tool_id,
            )
        )
    ).scalar_one_or_none()
    if installation is None:
        raise HTTPException(status_code=404, detail="工具未安装")
    await db.delete(installation)
