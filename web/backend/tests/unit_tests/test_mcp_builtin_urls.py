"""内置 MCP 服务对外地址的配置化推导（方案 P1-5）。"""

from agent.config import settings
from api.mcp.service import (
    BUILTIN_MCP_TOOLS,
    _is_legacy_loopback,
    builtin_mcp_urls,
)


def test_default_base_falls_back_to_host_port(monkeypatch) -> None:
    """未配置对外基址时按 HOST/PORT 推导，本地开发保持与旧值一致。"""
    monkeypatch.setattr(settings, "MCP_PUBLIC_BASE_URL", "", raising=False)
    monkeypatch.setattr(settings, "HOST", "127.0.0.1", raising=False)
    monkeypatch.setattr(settings, "PORT", 8001, raising=False)

    urls = builtin_mcp_urls(BUILTIN_MCP_TOOLS[0])
    assert urls["sse_url"] == "http://127.0.0.1:8001/mcp/web-search/sse"
    assert urls["streamable_http_url"] == "http://127.0.0.1:8001/mcp/web-search-http/mcp"


def test_configured_base_is_used_and_trailing_slash_stripped(monkeypatch) -> None:
    """配置了对外基址时以内网可达地址下发（桌面端/移动端要用）。"""
    monkeypatch.setattr(settings, "MCP_PUBLIC_BASE_URL", "https://ai.example.com/", raising=False)

    urls = builtin_mcp_urls(BUILTIN_MCP_TOOLS[2])
    assert urls["sse_url"] == "https://ai.example.com/mcp/video-gen/sse"
    assert urls["streamable_http_url"] == "https://ai.example.com/mcp/video-gen-http/mcp"
    assert "127.0.0.1" not in urls["url"]


def test_all_builtin_tools_declare_paths() -> None:
    """内置服务改为声明路径（不再写死回环地址），都能推导出地址。"""
    assert BUILTIN_MCP_TOOLS, "内置服务清单不应为空"
    for item in BUILTIN_MCP_TOOLS:
        assert "paths" in item, item["name"]
        urls = builtin_mcp_urls(item)
        assert urls["sse_url"].endswith(item["paths"]["sse"])
        assert urls["streamable_http_url"].endswith(item["paths"]["streamable_http"])


def test_legacy_loopback_detection() -> None:
    """只有旧版本写死的回环地址会被识别为"可安全迁移"。"""
    assert _is_legacy_loopback("http://127.0.0.1:8001/mcp/x") is True
    assert _is_legacy_loopback("http://localhost:8001/mcp/x") is True
    assert _is_legacy_loopback("https://ai.example.com/mcp/x") is False
    assert _is_legacy_loopback("http://10.0.0.5:8001/mcp/x") is False
    assert _is_legacy_loopback("") is False


def test_missing_paths_yields_empty_urls() -> None:
    """没有 paths 的定义（如自定义 stdio 服务）不产生地址。"""
    assert builtin_mcp_urls({"name": "自定义"}) == {
        "url": "",
        "sse_url": "",
        "streamable_http_url": "",
    }
