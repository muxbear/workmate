"""会话交付目录（``/artifacts/<thread_id>/turn-<n>/``）的解析与创建。

设计说明：
- 交付目录挂在宿主 staging 上（``CompositeBackend`` 的 ``/artifacts/`` 路由，
  见 ``agent/backends/user_scoped_filesystem_backend.py``），天然按用户隔离，
  同时不依赖沙箱的生命周期；
- 在用户目录下再按「会话 + 轮次」分子目录，解决跨会话同名文件互相覆盖的问题，
  并让「一轮回答产出的交付物」天然成为一个 bundle；
- ``turn-<n>`` 的下标由会话下已有轮次目录推导，无需新增数据库列。
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from core.storage.agent_staging import AGENT_ARTIFACT_PREFIX, user_staging_dir

logger = logging.getLogger(__name__)

# 交付根（虚拟绝对路径前缀，不带结尾斜杠）
DELIVERY_ROOT = AGENT_ARTIFACT_PREFIX.rstrip("/")

# 轮次目录命名规则
_TURN_DIR_RE = re.compile(r"^turn-(\d+)$")
# 路径片段白名单（会话 id、轮次目录名）
_SAFE_SEGMENT_RE = re.compile(r"[^A-Za-z0-9_-]+")
# 会话目录兜底名
_FALLBACK_SESSION = "session"


def is_delivery_path(path: str) -> bool:
    """判断路径是否位于交付目录（``/artifacts/``）下。"""
    return bool(path) and str(path).startswith(AGENT_ARTIFACT_PREFIX)


def safe_segment(raw: str, fallback: str = _FALLBACK_SESSION) -> str:
    """把标识符转换为安全的单层目录名。"""
    value = _SAFE_SEGMENT_RE.sub("_", (raw or "").strip()).strip("._")
    return value or fallback


def normalize_delivery_rel(rel_path: str) -> str:
    """净化交付目录内的相对路径（拒绝绝对路径与 ``..`` 穿越）。

    Args:
        rel_path: 形如 ``文章标题/figure-1.png`` 的相对路径。

    Returns:
        以 ``/`` 分隔的安全相对路径。

    Raises:
        ValueError: 路径为空或包含越界片段。
    """
    raw = str(rel_path or "").replace("\\", "/").strip()
    parts = [part for part in raw.split("/") if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        raise ValueError("非法的交付文件相对路径")
    return "/".join(parts)


def turn_from_path(path: str) -> str:
    """从交付目录虚拟路径中解析轮次目录名；非交付路径或无轮次时返回空串。"""
    if not is_delivery_path(path):
        return ""
    for part in str(path).split("/"):
        if _TURN_DIR_RE.match(part or ""):
            return part
    return ""


def delivery_thread_dir(thread_id: str) -> str:
    """返回会话交付目录的虚拟绝对路径（``/artifacts/<thread_id>``）。"""
    return AGENT_ARTIFACT_PREFIX + safe_segment(thread_id)


def delivery_thread_root(user_id: str, thread_id: str) -> Path:
    """返回会话交付目录的宿主路径（不创建目录）。"""
    return user_staging_dir(user_id, create=False) / safe_segment(thread_id)


def _turn_index(name: str) -> int | None:
    """解析 ``turn-<n>`` 目录名的下标；不匹配时返回 ``None``。"""
    match = _TURN_DIR_RE.match(name or "")
    return int(match.group(1)) if match else None


def list_turn_dirs(user_id: str, thread_id: str) -> list[str]:
    """列出会话下已存在的轮次目录名（按下标升序）。"""
    root = delivery_thread_root(user_id, thread_id)
    if not root.is_dir():
        return []
    indexed: list[tuple[int, str]] = []
    for path in root.iterdir():
        if not path.is_dir():
            continue
        index = _turn_index(path.name)
        if index is not None:
            indexed.append((index, path.name))
    return [name for _index, name in sorted(indexed)]


def next_turn_dir(user_id: str, thread_id: str) -> str:
    """返回本轮交付目录名（``turn-<n>``，n = 已有轮次目录最大下标 + 1）。"""
    last = 0
    for name in list_turn_dirs(user_id, thread_id):
        index = _turn_index(name)
        if index is not None and index > last:
            last = index
    return f"turn-{last + 1}"


def delivery_virtual_dir(thread_id: str, turn: str) -> str:
    """返回指定轮次交付目录的虚拟绝对路径。"""
    return f"{delivery_thread_dir(thread_id)}/{safe_segment(turn, 'turn-1')}"


def delivery_host_dir(
    user_id: str, thread_id: str, turn: str, *, create: bool = True
) -> Path:
    """返回指定轮次交付目录的宿主绝对路径，必要时创建。"""
    target = delivery_thread_root(user_id, thread_id) / safe_segment(turn, "turn-1")
    if create:
        target.mkdir(parents=True, exist_ok=True)
    return target


def delivery_hint(thread_id: str, turn: str | None = None) -> str:
    """构造注入给模型的交付目录提示（含本轮虚拟目录）。"""
    virtual = delivery_virtual_dir(thread_id, turn or "turn-1")
    return (
        "【交付目录】本次会话的交付目录为 "
        + virtual
        + "/ ，文章与配图请一律写入该目录：文章写到该目录下，"
        "配图写到与文章同名的子目录中，不要写到其它目录。"
    )