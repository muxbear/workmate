"""MCP 广场业务逻辑：工具列表、安装、卸载。"""

import logging
import re
import uuid

from fastapi import HTTPException
from sqlalchemy import case, func, select
from sqlalchemy.dialects.sqlite import JSON as SQLiteJSON
from sqlalchemy.ext.asyncio import AsyncSession

from agent.config import settings
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


# ── MCP 广场内置服务种子数据 ───────────────────────────────────────────

BUILTIN_MCP_TOOLS: list[dict] = [
    {
        "name": "联网搜索",
        "description": "通过 DuckDuckGo / Tavily 实时检索互联网信息，返回标题、URL 与摘要。",
        "icon": "🌐",
        "author": "ke-hermes",
        "version": "1.0.0",
        "license": "MIT",
        "repository": "",
        "rating": 4.8,
        "category": "search",
        "tags": ["搜索", "联网", "tavily", "duckduckgo"],
        "features": [
            "实时互联网搜索，返回标题、链接与摘要",
            "支持 Tavily 与 DuckDuckGo 双数据源自动切换",
        ],
        "official": True,
        "transport": "streamable_http",
        # 对外地址由配置基址推导（见 builtin_mcp_urls），不写死回环地址
        "paths": {"sse": "/mcp/web-search/sse", "streamable_http": "/mcp/web-search-http/mcp"},
    },
    {
        "name": "AI 图像生成",
        "description": "基于 wan2.7-image-pro 图像生成模型，提供文生图、文生组图、图生组图能力，可用于插画、海报、配图等场景。",
        "icon": "🎨",
        "author": "ke-hermes",
        "version": "1.0.0",
        "license": "MIT",
        "repository": "",
        "rating": 5.0,
        "category": "image_generation",
        "tags": ["图像生成", "文生图", "图生图", "wan2.7-image-pro"],
        "features": [
            "文生图：根据文本描述生成一张图片",
            "文生组图：一次生成多张风格一致的图片",
            "图生组图：参考图 + 提示词批量生成多张图片",
        ],
        "official": True,
        "transport": "streamable_http",
        "paths": {"sse": "/mcp/image-gen/sse", "streamable_http": "/mcp/image-gen-http/mcp"},
    },
    {
        "name": "AI 视频生成",
        "description": "基于阿里云百炼 wan3.0-video 视频生成模型，提供文生视频与参考生视频能力。",
        "icon": "🎬",
        "author": "ke-hermes",
        "version": "1.0.0",
        "license": "MIT",
        "repository": "",
        "rating": 4.9,
        "category": "video_generation",
        "tags": ["视频生成", "文生视频", "wan3.0-video", "阿里云百炼"],
        "features": [
            "文生视频：根据文本描述生成短视频",
            "参考生视频：结合首帧、尾帧、参考图或参考视频等素材生成视频",
            "异步任务提交与查询：任务处理中可继续查询进度与结果",
        ],
        "official": True,
        "transport": "streamable_http",
        "paths": {"sse": "/mcp/video-gen/sse", "streamable_http": "/mcp/video-gen-http/mcp"},
    },
]

# 历史默认地址（旧版本把本机回环地址写死进库）：仅用于识别"可以安全迁移"的行
_LEGACY_LOOPBACK_HOSTS = ("127.0.0.1:8001", "localhost:8001")


def builtin_mcp_urls(item: dict) -> dict[str, str]:
    """按配置基址推导内置 MCP 服务的对外地址。

    Args:
        item: 内置服务定义（含 ``paths``）。

    Returns:
        含 ``url`` / ``sse_url`` / ``streamable_http_url`` 的字典；缺 ``paths`` 时返回空串。
    """
    paths = item.get("paths") or {}
    base = settings.mcp_public_base_url
    sse_path = str(paths.get("sse") or "")
    http_path = str(paths.get("streamable_http") or "")
    return {
        "url": base + sse_path if sse_path else "",
        "sse_url": base + sse_path if sse_path else "",
        "streamable_http_url": base + http_path if http_path else "",
    }


def _is_legacy_loopback(url: str) -> bool:
    """判断地址是否为旧版本写死的本机回环地址。"""
    return any(host in (url or "") for host in _LEGACY_LOOPBACK_HOSTS)


async def seed_builtin_mcp_tools(db: AsyncSession) -> None:
    """填充 MCP 广场内置服务，可重复调用：缺失时创建，已有记录补全空字段与旧回环地址。."""
    for item in BUILTIN_MCP_TOOLS:
        urls = builtin_mcp_urls(item)
        row = (
            await db.execute(select(McpTool).where(McpTool.name == item["name"]))
        ).scalar_one_or_none()
        if row is None:
            db.add(
                McpTool(
                    id=str(uuid.uuid4()),
                    name=item["name"],
                    description=item["description"],
                    icon=item["icon"],
                    author=item["author"],
                    version=item["version"],
                    license=item["license"],
                    repository=item.get("repository", ""),
                    rating=item.get("rating", 0.0),
                    category=item["category"],
                    tags=item.get("tags", []),
                    features=item.get("features", []),
                    official=item.get("official", False),
                    config_schema=item.get("config_schema", []),
                    transport=item["transport"],
                    url=urls["url"],
                    sse_url=urls["sse_url"],
                    streamable_http_url=urls["streamable_http_url"],
                    command=item.get("command", ""),
                    args=item.get("args", []),
                    env=item.get("env", {}),
                )
            )
            logger.info("已创建内置 MCP 工具 '%s'", item["name"])
            continue

        for attr in ("url", "sse_url", "streamable_http_url"):
            current = str(getattr(row, attr) or "")
            target = urls[attr]
            if not target:
                continue
            if not current:
                setattr(row, attr, target)
                continue
            # 旧版本把 127.0.0.1:8001 写死进库；配好对外基址后按新基址迁移，
            # 用户自定义过的地址（非回环）保持不动
            if current != target and _is_legacy_loopback(current):
                setattr(row, attr, target)
                logger.info("已迁移内置 MCP 工具 '%s' 的 %s 到对外基址", item["name"], attr)
        if not row.transport or row.transport == "stdio":
            row.transport = item["transport"]
    logger.info("MCP 广场内置服务种子数据检查完成（%d 条）", len(BUILTIN_MCP_TOOLS))
