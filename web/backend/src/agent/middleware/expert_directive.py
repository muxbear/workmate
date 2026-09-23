"""专家委派强化中间件：选中专家时强制主智能体先委派给它。

背景：专家以 subagent 形式注册，是否委派原本完全由主模型决定，用户"已添加专家"
与实际执行可能不一致。本中间件在**选中专家的那一轮**给系统提示词追加一段强制指令，
要求主智能体先调用 task 工具把任务交给该专家，再汇总其产出；
未选专家、或当前没有 task 工具时不改动请求。
"""

from __future__ import annotations

import logging
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware
from langchain_core.messages import SystemMessage

logger = logging.getLogger(__name__)

# 追加到系统提示词末尾的强制委派指令模板
_DIRECTIVE_TEMPLATE = (
    "\n\n## 本次任务的强制委派要求\n"
    "本次任务已选择专家「{name}」。请严格按以下顺序执行：\n"
    "1. 先调用 task 工具，subagent_type 使用「{name}」，"
    "把用户的完整需求（包含【交付目录】等全部上下文）作为任务描述交给该专家；\n"
    "2. 等待该专家返回结果；\n"
    "3. 基于专家的产出给用户最终回复，不要自己重复完成专家的工作。\n"
)


def build_expert_directive(
    expert_name: str,
    *,
    platform: str = "web",
    delivery_dir: str = "",
) -> str:
    """构造强制委派指令（含本轮运行环境与交付目录）；专家名为空时返回空串。

    Args:
        expert_name: 本轮选择的专家名称。
        platform: 客户端平台（desktop / web / mobile），用于注入运行环境说明。
        delivery_dir: 本轮交付目录虚拟前缀（如 ``/artifacts/<thread>/turn-1``）。

    Returns:
        追加到系统提示词末尾的指令文本；未选专家时返回空串。
    """
    name = (expert_name or "").strip()
    if not name:
        return ""

    from agent.experts.platforms import platform_notes

    directive = _DIRECTIVE_TEMPLATE.format(name=name)
    blocks: list[str] = []

    notes = platform_notes(platform)
    if notes:
        blocks.append("## 本次请求的运行环境\n" + notes + "\n")

    prefix = (delivery_dir or "").strip().rstrip("/")
    if prefix:
        blocks.append(
            "【交付目录】本轮交付目录前缀为 "
            + prefix
            + "/ ：文档写到该目录下，配图 / 成片等素材写到与文档同名的子目录中。\n"
        )

    return directive + ("\n" + "\n".join(blocks) if blocks else "")


def has_task_tool(tools: list[Any] | None) -> bool:
    """判断工具列表里是否包含 deepagents 的 task 工具。"""
    for tool in tools or []:
        if getattr(tool, "name", None) == "task":
            return True
        if isinstance(tool, dict) and tool.get("name") == "task":
            return True
    return False


class ExpertDirectiveMiddleware(AgentMiddleware[Any, Any, Any]):
    """选中专家时给系统提示词追加强制委派指令（按本轮运行时上下文决定）。"""

    async def awrap_model_call(self, request: Any, handler: Any) -> Any:
        """调用模型前按需注入委派指令。"""
        context = getattr(getattr(request, "runtime", None), "context", None)
        expert_name = str(getattr(context, "expert_name", "") or "")
        directive = build_expert_directive(
            expert_name,
            platform=str(getattr(context, "platform", "web") or "web"),
            delivery_dir=str(getattr(context, "delivery_dir", "") or ""),
        )
        if not directive:
            return await handler(request)
        if not has_task_tool(getattr(request, "tools", None)):
            logger.debug("已选专家「%s」但当前无 task 工具，跳过强制委派", expert_name)
            return await handler(request)

        system_message = getattr(request, "system_message", None)
        raw_content = getattr(system_message, "content", "") if system_message else ""
        base = raw_content if isinstance(raw_content, str) else str(raw_content)
        merged = (base + directive) if base else directive.strip()
        logger.info("已为专家「%s」注入强制委派指令", expert_name)
        return await handler(request.override(system_message=SystemMessage(content=merged)))


__all__ = ["ExpertDirectiveMiddleware", "build_expert_directive", "has_task_tool"]
