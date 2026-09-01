"""MCP 工具加载器（改进2）— 将 MCP 服务器工具适配为 LangChain BaseTool。.

通过 langchain-mcp-adapters 将 MCP 工具纳入 Agent 的统一工具体系，
使 Agent 通过 agent_tools 关联表即可配置 MCP 工具。
"""
import json
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.models.agent_mcp_config import AgentMcpConfig
from db.models.agent_tool import AgentTool
from db.models.mcp_installation import McpInstallation
from db.models.mcp_tool import McpTool
from db.models.tool import Tool

logger = logging.getLogger(__name__)

# 缓存已连接的 MCP 客户端，避免重复建连
_mcp_clients: dict[str, Any] = {}

# 自托管 MCP 服务注册表与常驻内存会话：加载工具走进程内传输，不依赖自身 HTTP 端口
_LOCAL_MCP_SERVERS: dict[str, Any] = {}
_LOCAL_MCP_SESSIONS: dict[str, tuple[Any, Any]] = {}


def register_local_mcp_server(mcp_name: str, server: Any) -> None:
    """注册本进程内置的 MCP 服务，工具加载走内存传输（解决启动阶段端口未监听的时序问题）。."""
    _LOCAL_MCP_SERVERS[mcp_name] = server


async def _get_local_server_session(mcp_name: str, server: Any) -> Any:
    """获取本进程 MCP 服务的常驻内存会话（会话保持打开，供工具后续调用）。."""
    cached = _LOCAL_MCP_SESSIONS.get(mcp_name)
    if cached is not None:
        return cached[1]

    from mcp.shared.memory import create_connected_server_and_client_session

    # create_connected_server_and_client_session 是 @asynccontextmanager：
    # 手动进入上下文让会话保持打开，供工具在加载完成后继续调用
    cm = create_connected_server_and_client_session(server)
    session = await cm.__aenter__()
    _LOCAL_MCP_SESSIONS[mcp_name] = (cm, session)
    return session



def _runtime_config_from_tool(tool: McpTool) -> dict[str, Any]:
    return {
        'transport': tool.transport or 'stdio',
        'url': tool.url or '',
        'sse_url': tool.sse_url or '',
        'streamable_http_url': tool.streamable_http_url or '',
        'command': tool.command or '',
        'args': tool.args if isinstance(tool.args, list) else [],
        'env': tool.env if isinstance(tool.env, dict) else {},
    }

async def _get_mcp_config(
    db: AsyncSession,
    mcp_tool_name: str,
    agent_id: str | None = None,
    user_id: str | None = None,
) -> dict[str, Any]:
    """获取 MCP 配置：优先专家级(agent_mcp_configs) > 用户级(mcp_installations) > 默认运行配置."""
    mcp_tool = (await db.execute(
        select(McpTool).where(McpTool.name == mcp_tool_name)
    )).scalar_one_or_none()
    if mcp_tool is None:
        return {}

    defaults = _runtime_config_from_tool(mcp_tool)

    if agent_id is not None:
        agent_config = (await db.execute(
            select(AgentMcpConfig).where(
                AgentMcpConfig.agent_id == agent_id,
                AgentMcpConfig.mcp_tool_id == mcp_tool.id,
                AgentMcpConfig.enabled,
            )
        )).scalar_one_or_none()
        if agent_config is not None:
            return {**defaults, **agent_config.config}

    if user_id is None:
        return defaults

    installation = (await db.execute(
        select(McpInstallation).where(
            McpInstallation.user_id == user_id,
            McpInstallation.mcp_tool_id == mcp_tool.id,
        )
    )).scalar_one_or_none()

    if installation is not None:
        return {**defaults, **installation.config}

    return defaults

async def _append_mcp_tools(
    all_tools: list[Any],
    mcp_name: str,
    config: dict[str, Any],
) -> None:
    try:
        local_server = _LOCAL_MCP_SERVERS.get(mcp_name)
        if local_server is not None:
            from langchain_mcp_adapters.tools import load_mcp_tools

            session = await _get_local_server_session(mcp_name, local_server)
            mcp_tools = await load_mcp_tools(session)
            logger.info('MCP 工具 %s 通过内存传输加载（本进程自托管）', mcp_name)
        else:
            client = await _get_or_create_client(mcp_name, config)
            mcp_tools = await client.get_tools()
        for tool in mcp_tools:
            tool.name = f'mcp__{mcp_name}__{tool.name}'
            all_tools.append(tool)
    except Exception:
        logger.exception('加载 MCP 工具失败，跳过: %s', mcp_name)

async def load_mcp_tools_for_agent(
    db: AsyncSession,
    agent_id: str,
    user_id: str | None = None,
) -> list[Any]:
    """加载 Agent 关联的 MCP 工具，返回适配后的 BaseTool 列表."""
    all_tools: list[Any] = []
    loaded_names: set[str] = set()

    config_rows = (await db.execute(
        select(AgentMcpConfig, McpTool.name)
        .join(McpTool, McpTool.id == AgentMcpConfig.mcp_tool_id)
        .where(
            AgentMcpConfig.agent_id == agent_id,
            AgentMcpConfig.enabled,
        )
    )).all()

    for cfg, mcp_name in config_rows:
        if not mcp_name or mcp_name in loaded_names:
            continue
        loaded_names.add(mcp_name)
        config = await _get_mcp_config(db, mcp_name, agent_id=agent_id, user_id=user_id)
        await _append_mcp_tools(all_tools, mcp_name, config)

    legacy_stmt = (
        select(Tool)
        .join(AgentTool, AgentTool.tool_id == Tool.id)
        .where(AgentTool.agent_id == agent_id, Tool.tool_type == 'mcp')
    )
    legacy_rows = (await db.execute(legacy_stmt)).scalars().all()
    for tool_row in legacy_rows:
        mcp_name = tool_row.implementation
        if not mcp_name or mcp_name in loaded_names:
            continue
        loaded_names.add(mcp_name)
        config = await _get_mcp_config(db, mcp_name, agent_id=agent_id, user_id=user_id)
        await _append_mcp_tools(all_tools, mcp_name, config)

    logger.info('为 Agent %s 加载了 %d 个 MCP 工具', agent_id, len(all_tools))
    return all_tools

def _build_server_config(mcp_name: str, config: dict[str, Any]) -> dict[str, Any]:
    transport = config.get('transport', 'stdio')
    if transport in ('sse', 'streamable_http'):
        return {
            mcp_name: {
                'transport': transport,
                'url': (config.get('streamable_http_url') or config.get('url', '')) if transport == 'streamable_http' else config.get('sse_url', config.get('url', '')),
            }
        }
    return {
        mcp_name: {
            'transport': 'stdio',
            'command': config.get('command', 'npx'),
            'args': config.get('args', []),
            'env': config.get('env', {}),
        }
    }

async def _get_or_create_client(mcp_name: str, config: dict[str, Any]) -> Any:
    """获取或创建 MCP 客户端连接（带缓存)."""
    cache_key = f'{mcp_name}:{json.dumps(config, sort_keys=True, default=str)}'
    if cache_key in _mcp_clients:
        return _mcp_clients[cache_key]

    try:
        from langchain_mcp_adapters.client import MultiServerMCPClient
    except ImportError:
        logger.warning('langchain-mcp-adapters 未安装，MCP 工具加载不可用')
        raise ImportError('请安装 langchain-mcp-adapters: pip install langchain-mcp-adapters')

    server_config = _build_server_config(mcp_name, config)
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

    # 关闭本进程自托管 MCP 服务的内存会话
    for key, (cm, _session) in _LOCAL_MCP_SESSIONS.items():
        try:
            await cm.__aexit__(None, None, None)
        except Exception:
            logger.warning("关闭本地 MCP 会话失败: %s", key, exc_info=True)
    _LOCAL_MCP_SESSIONS.clear()
