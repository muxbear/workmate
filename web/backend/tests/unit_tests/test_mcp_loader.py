"""MCP 工具加载器单元测试。."""

import re

import pytest

from agent.tools.mcp_loader import (
    _LOCAL_MCP_SERVERS,
    _LOCAL_MCP_SESSIONS,
    _append_mcp_tools,
    register_local_mcp_server,
    safe_tool_name_segment,
)


def _skip_if_memory_transport_unusable() -> None:
    """app 生命周期已在本进程跑过时跳过。

    这些用例依赖 ``create_connected_server_and_client_session`` 的进程内内存传输。
    实测：一旦真实 app 生命周期在同进程内跑过（集成测试会驱动 MCP 工具加载），
    再新建同类会话就会卡死——服务端已 Initialize，但客户端发来的 initialize
    请求永远到不了服务端。与其让整个 pytest 会话挂住，不如显式跳过。

    判据用 ``app.state.started_at``（lifespan 启动时写入、关闭时不清除）：
    这是生产代码本就存在的属性，不需要为测试新增任何标记。
    必须在**运行时**判断——收集阶段 app 还没启动过。
    """
    from server import app

    if getattr(app.state, "started_at", None) is not None:
        pytest.skip(
            "本进程已运行过 app 生命周期，MCP 进程内内存传输不可用；"
            "请单独运行 pytest tests/unit_tests"
        )


@pytest.mark.asyncio
async def test_append_mcp_tools_uses_registered_local_server():
    _skip_if_memory_transport_unusable()
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


@pytest.mark.asyncio
async def test_append_mcp_tools_sanitizes_non_ascii_server_name():
    """中文 MCP 服务名下工具名需符合 ^[a-zA-Z0-9_-]+$，否则模型接口会返回 400。."""
    _skip_if_memory_transport_unusable()

    from mcp.server.fastmcp import FastMCP

    local = FastMCP('test-cn')

    @local.tool()
    async def ping(message: str) -> str:
        return f'pong:{message}'

    register_local_mcp_server('AI 图像生成', local)
    try:
        all_tools = []
        await _append_mcp_tools(all_tools, 'AI 图像生成', {})
        assert len(all_tools) == 1
        assert all_tools[0].name == 'mcp__AI__ping'
        assert re.fullmatch(r'[a-zA-Z0-9_-]+', all_tools[0].name)
        result = await all_tools[0].ainvoke({'message': 'hi'})
        assert 'pong:hi' in str(result)
    finally:
        _LOCAL_MCP_SERVERS.pop('AI 图像生成', None)
        cached = _LOCAL_MCP_SESSIONS.pop('AI 图像生成', None)
        if cached is not None:
            await cached[0].__aexit__(None, None, None)


def test_safe_tool_name_segment_keeps_ascii_and_falls_back():
    """ASCII 名称保持不变，纯中文名称回退为互不冲突的合法片段。."""
    assert safe_tool_name_segment('text_to_image') == 'text_to_image'
    assert safe_tool_name_segment('AI 图像生成') == 'AI'
    assert safe_tool_name_segment('image-gen') == 'image-gen'

    network = safe_tool_name_segment('联网搜索')
    video = safe_tool_name_segment('视频生成')
    assert network != video
    assert re.fullmatch(r'[a-zA-Z0-9_-]+', network) is not None
    assert re.fullmatch(r'[a-zA-Z0-9_-]+', video) is not None
