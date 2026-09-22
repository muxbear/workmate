"""专家能力声明与工具映射（能力 → 工具 / MCP 的唯一真相源）。

设计意图：专家只声明"需要什么能力"（如 ``image.generate``、``document.assemble``），
由各端适配层决定用哪些工具实现，避免在专家定义里散落具体工具名；
桌面端 / Web 端 / 后续移动端对同一份能力声明做各自的实现映射。
"""

from __future__ import annotations

import logging
from collections.abc import Sequence

logger = logging.getLogger(__name__)

# 能力标识（与 packages/expert-contract/contract.json 保持一致）
CAPABILITY_IMAGE_GENERATE = "image.generate"
CAPABILITY_DOCUMENT_ASSEMBLE = "document.assemble"
CAPABILITY_WEB_SEARCH = "web.search"
CAPABILITY_VIDEO_GENERATE = "video.generate"

ALL_CAPABILITIES: tuple[str, ...] = (
    CAPABILITY_IMAGE_GENERATE,
    CAPABILITY_DOCUMENT_ASSEMBLE,
    CAPABILITY_WEB_SEARCH,
    CAPABILITY_VIDEO_GENERATE,
)

# 能力 → 内置工具名（可写入 expert_tools 关联的工具）
CAPABILITY_BUILTIN_TOOLS: dict[str, tuple[str, ...]] = {
    # 后端图像生成由 MCP（text_to_image 等）提供；桌面端另有本地 image_generate 实现
    CAPABILITY_IMAGE_GENERATE: (),
    CAPABILITY_DOCUMENT_ASSEMBLE: ("download_asset",),
    CAPABILITY_WEB_SEARCH: ("tavily_search",),
}

# 能力 → MCP 工具名（由 MCP server 暴露，不写入 expert_tools）
CAPABILITY_MCP_TOOLS: dict[str, tuple[str, ...]] = {
    CAPABILITY_IMAGE_GENERATE: (
        "text_to_image",
        "text_to_image_batch",
        "image_to_image_batch",
    ),
    CAPABILITY_VIDEO_GENERATE: ("generate_video", "query_video_generation"),
    CAPABILITY_WEB_SEARCH: ("web_search",),
}

# MCP 服务名 → 能力（专家通过 mcp_configs 关联服务时反推能力）
MCP_SERVICE_CAPABILITIES: dict[str, str] = {
    "AI 图像生成": CAPABILITY_IMAGE_GENERATE,
    "AI 视频生成": CAPABILITY_VIDEO_GENERATE,
    "联网搜索": CAPABILITY_WEB_SEARCH,
}


def normalize_capabilities(raw: Sequence[str] | None) -> list[str]:
    """过滤未知能力并保序去重。"""
    out: list[str] = []
    for item in raw or []:
        name = str(item or "").strip()
        if not name or name in out:
            continue
        if name not in ALL_CAPABILITIES:
            logger.warning("未知的专家能力声明：%s", name)
            continue
        out.append(name)
    return out


def _expand(
    mapping: dict[str, tuple[str, ...]], capabilities: Sequence[str] | None
) -> list[str]:
    """按能力顺序展开工具名（去重保序）。"""
    out: list[str] = []
    for name in normalize_capabilities(capabilities):
        for tool in mapping.get(name, ()):
            if tool not in out:
                out.append(tool)
    return out


def capability_builtin_tools(capabilities: Sequence[str] | None) -> list[str]:
    """把能力声明展开为内置工具名。"""
    return _expand(CAPABILITY_BUILTIN_TOOLS, capabilities)


def capability_mcp_tools(capabilities: Sequence[str] | None) -> list[str]:
    """把能力声明展开为 MCP 工具名。"""
    return _expand(CAPABILITY_MCP_TOOLS, capabilities)


def capabilities_for_tools(tool_names: Sequence[str] | None) -> list[str]:
    """由已有工具名反推能力（存量专家与同步回显用）。"""
    names = {str(name or "").strip() for name in tool_names or []}
    out: list[str] = []
    for capability in ALL_CAPABILITIES:
        tools = set(CAPABILITY_BUILTIN_TOOLS.get(capability, ())) | set(
            CAPABILITY_MCP_TOOLS.get(capability, ())
        )
        if names & tools:
            out.append(capability)
    return out


def capabilities_for_mcp_services(service_names: Sequence[str] | None) -> list[str]:
    """由 MCP 服务名反推能力。"""
    out: list[str] = []
    for name in service_names or []:
        capability = MCP_SERVICE_CAPABILITIES.get(str(name or "").strip())
        if capability and capability not in out:
            out.append(capability)
    return out


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
