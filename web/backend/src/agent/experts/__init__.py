"""专家能力契约（声明式能力 → 平台工具映射）。"""

from agent.experts.capabilities import (
    ALL_CAPABILITIES,
    CAPABILITY_BUILTIN_TOOLS,
    CAPABILITY_DOCUMENT_ASSEMBLE,
    CAPABILITY_IMAGE_GENERATE,
    CAPABILITY_MCP_TOOLS,
    CAPABILITY_VIDEO_GENERATE,
    CAPABILITY_WEB_SEARCH,
    MCP_SERVICE_CAPABILITIES,
    capability_builtin_tools,
    capability_mcp_tools,
    capabilities_for_mcp_services,
    capabilities_for_tools,
    normalize_capabilities,
)

__all__ = [
    "ALL_CAPABILITIES",
    "CAPABILITY_BUILTIN_TOOLS",
    "CAPABILITY_DOCUMENT_ASSEMBLE",
    "CAPABILITY_IMAGE_GENERATE",
    "CAPABILITY_MCP_TOOLS",
    "CAPABILITY_VIDEO_GENERATE",
    "CAPABILITY_WEB_SEARCH",
    "MCP_SERVICE_CAPABILITIES",
    "capability_builtin_tools",
    "capability_mcp_tools",
    "capabilities_for_mcp_services",
    "capabilities_for_tools",
    "normalize_capabilities",
]
