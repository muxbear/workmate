"""会话级权限中间件：按「代码执行」开关拦截命令/代码类工具调用。"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware
from langchain_core.messages import ToolMessage

from agent.sandbox.workspace import PATH_ARG_KEYS, is_workspace_violation

logger = logging.getLogger(__name__)

# 视为「执行命令/代码」的工具名关键字（包含匹配，忽略大小写）
SHELL_TOOL_KEYWORDS: tuple[str, ...] = (
    "shell",
    "execute",
    "bash",
    "run_command",
    "code_interpreter",
)


def find_write_target(tool_args: Any) -> str:
    """从工具入参中提取写入目标路径（无则返回空串）。"""
    if not isinstance(tool_args, dict):
        return ""
    for key in PATH_ARG_KEYS:
        value = tool_args.get(key)
        if isinstance(value, str) and value.startswith("/"):
            return value
    return ""


def is_workspace_blocked(tool_args: Any, workspace_id: str | None) -> bool:
    """写入目标位于 /workspace/ 下但不属于当前工作区时拒绝（跨工作区隔离）。"""
    return is_workspace_violation(find_write_target(tool_args), workspace_id)


def is_tool_blocked(tool_name: str, allow_shell: bool) -> bool:
    """判断某工具在当前会话权限下是否应被拒绝（纯函数，便于单测）。"""
    if allow_shell:
        return False
    lowered = (tool_name or "").lower()
    return any(keyword in lowered for keyword in SHELL_TOOL_KEYWORDS)


class RequestPermissionMiddleware(AgentMiddleware):
    """在工具调用前检查会话权限：未开启「代码执行」时拒绝命令/代码类工具。"""

    async def awrap_tool_call(
        self,
        request: Any,
        handler: Callable[[Any], Awaitable[Any]],
    ) -> Any:
        """拦截并短路被拒绝的工具调用，其余调用透传给 handler。"""
        tool_call = getattr(request, "tool_call", {}) or {}
        tool_name = str(tool_call.get("name", ""))
        tool_args = tool_call.get("args")
        tool_call_id = str(tool_call.get("id", ""))
        runtime = getattr(request, "runtime", None)
        context = getattr(runtime, "context", None)
        allow_shell = bool(getattr(context, "allow_shell", True))
        workspace_id = getattr(context, "workspace_id", None)

        if is_tool_blocked(tool_name, allow_shell):
            logger.warning(
                "会话未开启代码执行权限，已拒绝工具调用：%s", tool_name
            )
            return ToolMessage(
                content="当前会话未开启「代码执行」权限，已拒绝该工具调用。如需执行命令或代码，请在输入框左下角「权限」中开启后重试。",
                tool_call_id=tool_call_id,
            )

        if is_workspace_blocked(tool_args, workspace_id):
            logger.warning(
                "跨工作区写入被拒绝：tool=%s workspace=%s", tool_name, workspace_id
            )
            return ToolMessage(
                content="目标路径不属于当前会话工作区，已拒绝该写入。请把文件写入当前工作区目录 /workspace/"
                + str(workspace_id)
                + "/ 下。",
                tool_call_id=tool_call_id,
            )

        return await handler(request)
