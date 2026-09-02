"""工具注册表单元测试。"""

import pytest

from agent.tools.registry import resolve_agent_tools


class _FakeTool:
    """模拟带 name 属性的工具对象。"""

    def __init__(self, name: str) -> None:
        self.name = name


@pytest.mark.asyncio
async def test_resolve_agent_tools_includes_configured_mcp_tools(monkeypatch):
    """AgentMcpConfig 配置的 MCP 工具即使未出现在 tool_names 中也会被加载。."""

    async def fake_get_registry(db):
        return {"http_request": "http_fn"}

    async def fake_load_mcp_tools(db, agent_id):
        return [_FakeTool("mcp__AI 图像生成__text_to_image")]

    monkeypatch.setattr(
        "agent.tools.registry.get_tool_registry", fake_get_registry
    )
    monkeypatch.setattr(
        "agent.tools.mcp_loader.load_mcp_tools_for_agent", fake_load_mcp_tools
    )

    tools = await resolve_agent_tools(None, "agent-1", ["http_request"])
    assert tools[0] == "http_fn"
    assert isinstance(tools[1], _FakeTool)
    assert tools[1].name == "mcp__AI 图像生成__text_to_image"


@pytest.mark.asyncio
async def test_resolve_agent_tools_dedupes_mcp_tools(monkeypatch):
    """tool_names 已包含 MCP 工具名时不会重复附加。."""

    async def fake_get_registry(db):
        return {}

    async def fake_load_mcp_tools(db, agent_id):
        return [_FakeTool("mcp__AI 图像生成__text_to_image")]

    monkeypatch.setattr(
        "agent.tools.registry.get_tool_registry", fake_get_registry
    )
    monkeypatch.setattr(
        "agent.tools.mcp_loader.load_mcp_tools_for_agent", fake_load_mcp_tools
    )

    tools = await resolve_agent_tools(
        None, "agent-1", ["mcp__AI 图像生成__text_to_image"]
    )
    assert [t.name for t in tools] == ["mcp__AI 图像生成__text_to_image"]
