"""MCP 工具加载器（改进2）— 将 MCP 服务器工具适配为 LangChain BaseTool。.

通过 langchain-mcp-adapters 将 MCP 工具纳入 Agent 的统一工具体系，
使 Agent 通过 agent_tools 关联表即可配置 MCP 工具。
"""
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.models.agent_tool import AgentTool
from db.models.mcp_installation import McpInstallation
from db.models.mcp_tool import McpTool
from db.models.tool import Tool

logger = logging.getLogger(__name__)

# 缓存已连接的 MCP 客户端，避免重复建连
_mcp_clients: dict[str, Any] = {}


async def _get_mcp_config(
    db: AsyncSession,
    mcp_tool_name: str,
    agent_id: str | None = None,
    user_id: str | None = None,
) -> dict[str, Any]:
    """获取 MCP 配置：优先专家级(agent_mcp_configs) > 用户级(mcp_installations) > 默认空。."""
    mcp_tool = (await db.execute(
        select(McpTool).where(McpTool.name == mcp_tool_name)
    )).scalar_one_or_none()
    if mcp_tool is None:
        return {}

    # 1. 优先从 agent_mcp_configs 读取专家级配置
    if agent_id is not None:
        from db.models.agent_mcp_config import AgentMcpConfig
        agent_config = (await db.execute(
            select(AgentMcpConfig).where(
                AgentMcpConfig.agent_id == agent_id,
                AgentMcpConfig.mcp_tool_id == mcp_tool.id,
                AgentMcpConfig.enabled,
            )
        )).scalar_one_or_none()
        if agent_config is not None:
            return agent_config.config

    # 2. Fallback 到用户级配置
    if user_id is None:
        return {}

    installation = (await db.execute(
        select(McpInstallation).where(
            McpInstallation.user_id == user_id,
            McpInstallation.mcp_tool_id == mcp_tool.id,
        )
    )).scalar_one_or_none()

    return installation.config if installation is not None else {}


async def load_mcp_tools_for_agent(
    db: AsyncSession,
    agent_id: str,
    user_id: str | None = None,
) -> list[Any]:
    """加载 Agent 关联的 MCP 工具，返回适配后的 BaseTool 列表。.

    流程：
    1. 查询 agent_tools 关联表中 tool_type='mcp' 的记录。
    2. 对每条记录，从 mcp_installations 获取用户配置。
    3. 建立或复用 MCP 客户端连接，获取工具列表。
    4. 为 MCP 工具名称加上 mcp__ 前缀，避免与内置工具名冲突。
    """
    stmt = (
        select(Tool)
        .join(AgentTool, AgentTool.tool_id == Tool.id)
        .where(AgentTool.agent_id == agent_id, Tool.tool_type == "mcp")
    )
    mcp_tool_rows = (await db.execute(stmt)).scalars().all()
    if not mcp_tool_rows:
        return []

    all_tools: list[Any] = []

    for tool_row in mcp_tool_rows:
        mcp_name = tool_row.implementation
        if not mcp_name:
            logger.warning("MCP 工具 '%s' 未配置 implementation（MCP 名称），跳过", tool_row.name)
            continue

        config = await _get_mcp_config(db, mcp_name, agent_id=agent_id, user_id=user_id)

        try:
            client = await _get_or_create_client(mcp_name, config)
            mcp_tools = await client.get_tools()
            for t in mcp_tools:
                t.name = f"mcp__{mcp_name}__{t.name}"
                all_tools.append(t)
        except Exception:
            logger.exception("加载 MCP 工具失败，跳过: %s", mcp_name)

    logger.info("为 Agent %s 加载了 %d 个 MCP 工具", agent_id, len(all_tools))
    return all_tools


async def _get_or_create_client(mcp_name: str, config: dict) -> Any:
    """获取或创建 MCP 客户端连接（带缓存）。."""
    cache_key = f"{mcp_name}:{hash(frozenset(config.items())) if config else 'default'}"

    if cache_key in _mcp_clients:
        return _mcp_clients[cache_key]

    try:
        from langchain_mcp_adapters.client import MultiServerMCPClient
    except ImportError:
        logger.warning("langchain-mcp-adapters 未安装，MCP 工具加载不可用")
        raise ImportError("请安装 langchain-mcp-adapters: pip install langchain-mcp-adapters")

    server_config = {
        mcp_name: {
            "command": config.get("command", "npx"),
            "args": config.get("args", []),
            "transport": config.get("transport", "stdio"),
            "env": config.get("env", {}),
        }
    }

    client = MultiServerMCPClient(server_config)
    _mcp_clients[cache_key] = client
    return client


async def close_mcp_clients() -> None:
    """关闭所有缓存的 MCP 客户端连接（应用关闭时调用）。."""
    global _mcp_clients
    for key, client in _mcp_clients.items():
        try:
            await client.close()
        except Exception:
            logger.warning("关闭 MCP 客户端失败: %s", key, exc_info=True)
    _mcp_clients.clear()
