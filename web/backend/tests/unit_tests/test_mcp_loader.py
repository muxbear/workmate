"""MCP 工具加载器单元测试。."""

import pytest

from agent.tools.mcp_loader import (
    _LOCAL_MCP_SERVERS,
    _LOCAL_MCP_SESSIONS,
    _append_mcp_tools,
    register_local_mcp_server,
)


@pytest.mark.asyncio
async def test_append_mcp_tools_uses_registered_local_server():
    """注册了本进程自托管 MCP 服务时，工具通过内存传输加载，不依赖 HTTP 端口。."""
    from mcp.server.fastmcp import FastMCP

    local = FastMCP('test-local')

    @local.tool()
    async def ping(message: str) -> str:
        return f'pong:{message}'

    register_local_mcp_server('test_local', local)
    try:
        all_tools = []
        await _append_mcp_tools(all_tools, 'test_local', {})
        assert len(all_tools) == 1
        assert all_tools[0].name == 'mcp__test_local__ping'
        result = await all_tools[0].ainvoke({'message': 'hi'})
        assert 'pong:hi' in str(result)
    finally:
        _LOCAL_MCP_SERVERS.pop('test_local', None)
        cached = _LOCAL_MCP_SESSIONS.pop('test_local', None)
        if cached is not None:
            await cached[0].__aexit__(None, None, None)
