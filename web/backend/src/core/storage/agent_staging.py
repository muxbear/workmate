"""智能体交付目录（``/artifacts/``）到宿主 staging 目录的映射与清理。

智能体通过文件工具写入 ``/artifacts/`` 的文件会落在
``{WORKSPACE}/artifacts_agent/{user_id}/`` 下（用户级隔离），随后由产物物化流程
复制到持久存储，使沙箱回收或重建后仍可访问。
"""

from __future__ import annotations

import logging
import re
import time
from pathlib import Path

logger = logging.getLogger(__name__)

# 智能体交付目录的虚拟前缀（CompositeBackend 路由前缀）
AGENT_ARTIFACT_PREFIX = "/artifacts/"

# 目录名中不允许出现的字符
_UNSAFE_SEGMENT_RE = re.compile(r"[^\w.\-]+", re.UNICODE)


def agent_staging_root() -> Path:
    """返回交付目录的宿主 staging 根目录（默认 ``{WORKSPACE}/artifacts_agent``）。"""
    from agent.config import settings

    configured = str(getattr(settings, "ARTIFACT_AGENT_ROOT", "") or "").strip()
    if not configured:
        workspace = str(getattr(settings, "WORKSPACE", "") or ".").strip() or "."
        configured = str(Path(workspace) / "artifacts_agent")
    return Path(configured).expanduser()


def user_segment(user_id: str) -> str:
    """把用户 ID 转换为安全的单层目录名。"""
    value = _UNSAFE_SEGMENT_RE.sub("_", (user_id or "").strip()).strip("._")
    return value or "anonymous"


def user_staging_dir(user_id: str, *, create: bool = True) -> Path:
    """返回用户的交付目录，必要时创建。"""
    target = agent_staging_root() / user_segment(user_id)
    if create:
        target.mkdir(parents=True, exist_ok=True)
    return target


def is_agent_artifact_path(path: str) -> bool:
    """判断路径是否位于智能体交付目录下。"""
    return bool(path) and str(path).startswith(AGENT_ARTIFACT_PREFIX)


def staging_file_path(user_id: str, artifact_path: str) -> Path | None:
    """把 ``/artifacts/xxx`` 映射为用户交付目录内的绝对路径（非交付路径或越界返回 None）。"""
    if not is_agent_artifact_path(artifact_path):
        return None
    relative = str(artifact_path)[len(AGENT_ARTIFACT_PREFIX) :].strip("/")
    parts = [part for part in relative.split("/") if part not in ("", ".", "..")]
    if not parts:
        return None
    return user_staging_dir(user_id).joinpath(*parts)


def read_staging_file(user_id: str, artifact_path: str) -> bytes | None:
    """读取用户在交付目录中的文件；不存在或越界返回 None。"""
    target = staging_file_path(user_id, artifact_path)
    if target is None:
        return None
    try:
        return target.read_bytes()
    except FileNotFoundError:
        return None
    except OSError:
        logger.warning("读取交付目录文件失败：%s", target, exc_info=True)
        return None


def purge_agent_staging(*, older_than_seconds: float, limit: int = 200) -> int:
    """清理交付目录中超过保留期的文件（已物化内容仍保留在持久存储中）。"""
    root = agent_staging_root()
    if not root.exists():
        return 0
    now = time.time()
    removed = 0
    for path in sorted(root.rglob("*"), reverse=True):
        if removed >= limit:
            break
        if path.is_dir():
            try:
                path.rmdir()
            except OSError:
                continue
            continue
        try:
            if older_than_seconds and now - path.stat().st_mtime <= older_than_seconds:
                continue
            path.unlink()
            removed += 1
        except OSError:
            continue
    return removed
