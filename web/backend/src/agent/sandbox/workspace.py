"""会话工作区：沙箱内 /workspace/<id> 目录的规范化、创建与隔离判定。"""

from __future__ import annotations

import logging
import re

from agent.sandbox.opensandbox_backend import OpenSandBoxBackend

logger = logging.getLogger(__name__)

WORKSPACE_ROOT = "/workspace"

# 工作区 id 仅允许小写字母、数字、下划线与短横线（1-64 位）
_WORKSPACE_ID_RE = re.compile(r"^[a-z0-9_-]{1,64}$")

# 工具入参中可能承载写入目标的字段名（与产物解析保持一致）
PATH_ARG_KEYS: tuple[str, ...] = (
    "file_path",
    "path",
    "filename",
    "target_file",
)


def normalize_workspace_id(raw: str | None) -> str | None:
    """规范化并校验工作区 id；非法或空值返回 None（表示使用默认工作区）。"""
    if not raw:
        return None
    candidate = raw.strip().lower()
    if not _WORKSPACE_ID_RE.fullmatch(candidate):
        logger.warning("非法的工作区 id 已被忽略：%s", raw)
        return None
    return candidate


def workspace_path(workspace_id: str) -> str:
    """工作区在沙箱内的绝对路径。"""
    return WORKSPACE_ROOT + "/" + workspace_id


def is_within_workspace(path: str, workspace_id: str | None) -> bool:
    """判断路径是否位于指定工作区内（未指定工作区时视为通过）。"""
    if not workspace_id:
        return True
    if not path or not path.startswith(WORKSPACE_ROOT + "/"):
        return True
    prefix = workspace_path(workspace_id) + "/"
    return path == workspace_path(workspace_id) or path.startswith(prefix)


def is_workspace_violation(path: str, workspace_id: str | None) -> bool:
    """写入目标落在 /workspace/ 下但不属于当前工作区时，视为跨工作区越界。"""
    if not workspace_id or not path:
        return False
    if not path.startswith(WORKSPACE_ROOT + "/"):
        return False
    return not is_within_workspace(path, workspace_id)


def ensure_workspace(backend: OpenSandBoxBackend, workspace_id: str) -> str:
    """在沙箱内创建工作区目录（幂等），返回绝对路径；失败返回空串。"""
    path = workspace_path(workspace_id)
    try:
        result = backend.execute("mkdir -p " + path)
    except Exception:
        logger.warning("创建工作区目录失败：%s", path, exc_info=True)
        return ""
    exit_code = getattr(result, "exit_code", None)
    if exit_code not in (None, 0):
        logger.warning("创建工作区目录返回非零退出码：%s -> %s", path, exit_code)
        return ""
    return path
