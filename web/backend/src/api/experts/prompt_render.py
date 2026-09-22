"""专家提示词的平台化渲染：让专家定义与具体端解耦。

专家记录只保存平台无关模板，渲染时按 ``platform`` 注入交付目录前缀、
素材工具名与平台注意事项；Web / 桌面 / 移动端因此可以共用同一份专家提示词。
"""

from __future__ import annotations

import logging
import re

from agent.experts.platforms import (
    PLATFORMS,
    normalize_platform,
    platform_notes,
)

logger = logging.getLogger(__name__)

# 默认素材保存工具名（各端保持同名，见桌面版 DesktopToolRegistry）
DEFAULT_ASSET_TOOL = "download_asset"

# 遗留占位符（渲染后仍存在说明模板写错了变量名）
_PLACEHOLDER_RE = re.compile(r"\{\{[a-zA-Z0-9_]+\}\}")

# 平台定义与运行环境说明统一放在 agent.experts.platforms（此处再导出，保持调用方不变）


def render_expert_prompt(
    system_prompt: str,
    *,
    platform: str = "web",
    delivery_dir: str = "",
    asset_tool: str = DEFAULT_ASSET_TOOL,
    include_platform_notes: bool = True,
) -> str:
    """把专家提示词模板渲染为指定平台的提示词。

    Args:
        system_prompt: 平台无关的专家提示词模板。
        platform: 目标端：desktop / web / mobile。
        delivery_dir: 交付目录前缀（以 / 结尾；空串表示工作区根目录）。
        asset_tool: 素材保存工具名。
        include_platform_notes: 是否注入平台运行环境说明；子代理提示词在图构建期
            渲染，需按请求注入时置 False，由请求级中间件补充。

    Returns:
        渲染后的提示词；出现未识别的占位符时原样保留并记录告警。
    """
    if not system_prompt:
        return ""

    notes = platform_notes(platform) if include_platform_notes else ""
    rendered = (
        system_prompt.replace("{{delivery_dir}}", delivery_dir)
        .replace("{{asset_tool}}", asset_tool)
        .replace("{{platform_notes}}", notes)
    )

    leftovers = sorted(set(_PLACEHOLDER_RE.findall(rendered)))
    if leftovers:
        logger.warning("专家提示词存在未替换的占位符：%s", "、".join(leftovers))
    return rendered


__all__ = [
    "DEFAULT_ASSET_TOOL",
    "PLATFORMS",
    "normalize_platform",
    "platform_notes",
    "render_expert_prompt",
]
