"""DB 驱动的动态工具注册表。

替代原有 agent/common.py 中的硬编码 get_tool_registry()，
所有工具加载均以 tools 表为唯一真相源。
"""
import importlib
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.models.tool import Tool

logger = logging.getLogger(__name__)

# 内置工具实现缓存（module_path:func_name → callable）
_builtin_cache: dict[str, Any] = {}
_failed_cache: set[str] = set()


def load_tool_by_implementation(implementation: str) -> Any | None:
    """通过 module_path:func_name 动态导入工具函数。

    Args:
        implementation: 如 "agent.tools.http_request:http_request"

    Returns:
        可调用的工具函数，或 None（导入失败时记录警告并返回 None）
    """
    if implementation in _builtin_cache:
        return _builtin_cache[implementation]
    if implementation in _failed_cache:
        return None

    if ":" not in implementation:
        logger.warning("工具实现路径格式错误（缺少冒号分隔）: %s", implementation)
        return None

    module_path, func_name = implementation.split(":", 1)
    try:
        module = importlib.import_module(module_path)
        fn = getattr(module, func_name, None)
        if fn is None:
            logger.warning("工具函数 '%s' 在模块 '%s' 中未找到", func_name, module_path)
            return None
        _builtin_cache[implementation] = fn
        return fn
    except ImportError:
        _failed_cache.add(implementation)
        logger.warning("工具模块 '%s' 导入失败", module_path, exc_info=True)
        return None
    except Exception:
        _failed_cache.add(implementation)
        logger.warning("加载工具实现 '%s' 时发生错误", implementation, exc_info=True)
        return None


async def get_tool_registry(db: AsyncSession) -> dict[str, Any]:
    """从 DB 动态构建工具注册表。

    查询所有 status=enabled 的工具，按 tool_type 分别加载：
    - function: 动态导入 Python 函数
    - mcp: 通过 mcp_loader 加载（在 resolve_agent_tools 中统一处理）
    - plugin: 预留

    Returns:
        工具名称 → 可调用对象的映射
    """
    stmt = select(Tool).where(Tool.status == "enabled", Tool.tool_type == "function")
    tools = (await db.execute(stmt)).scalars().all()

    registry: dict[str, Any] = {}
    for tool in tools:
        if not tool.implementation:
            logger.warning("工具 '%s' 为 function 类型但未配置 implementation", tool.name)
            continue
        fn = load_tool_by_implementation(tool.implementation)
        if fn is not None:
            registry[tool.name] = fn

    logger.info("动态工具注册表加载完成：%d 个工具可用", len(registry))
    return registry

async def resolve_agent_tools(
    db: AsyncSession,
    agent_id: str,
    tool_names: list[str],
) -> list[Any]:
    """为指定 Agent 解析工具列表。."""
    from agent.tools.mcp_loader import load_mcp_tools_for_agent  # noqa: PLC0415

    return await _resolve_entity_tools(db, agent_id, tool_names, load_mcp_tools_for_agent)


async def resolve_expert_tools(
    db: AsyncSession,
    expert_id: str,
    tool_names: list[str],
) -> list[Any]:
    """为指定 Expert 解析工具列表。."""
    from agent.tools.mcp_loader import load_mcp_tools_for_expert  # noqa: PLC0415

    return await _resolve_entity_tools(db, expert_id, tool_names, load_mcp_tools_for_expert)


async def _resolve_entity_tools(
    db: AsyncSession,
    entity_id: str,
    tool_names: list[str],
    mcp_loader: Any,
) -> list[Any]:
    """合并内置工具和 MCP 工具，按 tool_names 顺序返回。.

    Args:
        db: 数据库会话。
        entity_id: Agent ID 或 Expert ID。
        tool_names: 工具名称列表。
        mcp_loader: 加载 MCP 工具的可调用对象。

    Returns:
        可调用工具对象列表。
    """
    # 1. 加载内置工具注册表
    registry = await get_tool_registry(db)

    # 2. 加载该实体通过 *_mcp_configs 配置的 MCP 工具
    mcp_tools: list[Any] = []
    try:
        mcp_tools = await mcp_loader(db, entity_id)
        for mcp_tool in mcp_tools:
            registry[mcp_tool.name] = mcp_tool
    except ImportError:
        logger.debug("mcp_loader 未安装，跳过 MCP 工具加载")
    except Exception:
        logger.warning("加载 MCP 工具失败", exc_info=True)

    # 3. 按 tool_names 解析内置工具
    resolved: list[Any] = []
    for name in tool_names:
        fn = registry.get(name)
        if fn is not None:
            resolved.append(fn)
        else:
            logger.warning("工具 '%s' 在注册表中未找到，已跳过", name)

    # 4. 自动附加 MCP 工具：显式配置无需在 tool_names 中重复声明
    resolved_names = {getattr(tool, "name", None) for tool in resolved}
    for mcp_tool in mcp_tools:
        tool_name = getattr(mcp_tool, "name", None)
        if tool_name is not None and tool_name not in resolved_names:
            resolved.append(mcp_tool)
            resolved_names.add(tool_name)

    return resolved
