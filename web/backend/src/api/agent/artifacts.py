"""会话产物（生成文件）解析、登记、物化与查询。

智能体在沙箱内生成的文件通过工具调用入参识别（写文件类工具 + shell 重定向），
登记到 chat_artifacts 表，并物化到后端持久存储（默认本地磁盘），
供网页版消息卡片与右侧产物面板展示、下载（沙箱回收或服务重启后仍可访问）。
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import re
import time
import uuid
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, select, update

from core.storage import (
    build_storage_key,
    build_thread_prefix,
    checksum_of,
    get_artifact_store,
)
from core.storage.agent_staging import is_agent_artifact_path, read_staging_file

logger = logging.getLogger(__name__)

# 产物状态：待物化 / 已就绪 / 物化失败 / 已过期（无法恢复）
STATUS_PENDING = "pending"
STATUS_READY = "ready"
STATUS_FAILED = "failed"
STATUS_EXPIRED = "expired"

# 视为「写文件」的工具名关键字（包含匹配，忽略大小写）
_WRITE_TOOL_KEYWORDS: tuple[str, ...] = (
    "write",
    "edit",
    "create",
    "save",
    "append",
)

# 工具入参中可能承载目标路径的字段名（按优先级）
_PATH_KEYS: tuple[str, ...] = (
    "file_path",
    "path",
    "filename",
    "target_file",
    "file",
)


# shell 重定向目标：> file / >> file / tee file
_REDIRECT_RE = re.compile(r"(?:>>?|(?:^|\s)tee(?:\s+-a)?)\s+([^\s;|'\"<>]+)")

# 协议地址（http/data/file 等）不作为产物路径
_SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.\-]*:")

# 产物路径排除规则（系统目录与编译缓存）
_SKIP_PREFIXES: tuple[str, ...] = (
    "/proc/",
    "/sys/",
    "/dev/",
    "/usr/",
    "/opt/",
    "/var/lib/",
)
_SKIP_SUFFIXES: tuple[str, ...] = (".pyc", ".pyo")

# 扩展名 → MIME 类型（用于产物卡片展示与下载响应头）
_MIME_BY_EXT: dict[str, str] = {
    "txt": "text/plain",
    "md": "text/markdown",
    "csv": "text/csv",
    "json": "application/json",
    "xml": "application/xml",
    "yaml": "application/x-yaml",
    "yml": "application/x-yaml",
    "html": "text/html",
    "css": "text/css",
    "js": "text/javascript",
    "ts": "text/plain",
    "py": "text/x-python",
    "sh": "text/x-shellscript",
    "pdf": "application/pdf",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "svg": "image/svg+xml",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "zip": "application/zip",
}
_DEFAULT_MIME = "application/octet-stream"


@dataclass
class Artifact:
    """单个会话产物。"""

    path: str
    name: str
    source_tool: str
    mime_type: str
    size: int
    created_at: float
    artifact_id: str = ""
    status: str = STATUS_PENDING
    storage_key: str = ""
    # 交付轮次（turn-<n>）；非交付目录产物为空串
    turn: str = ""

    def to_dict(self) -> dict[str, Any]:
        """转换为可 JSON 序列化的字典（SSE 与列表接口共用）。"""
        return {
            "path": self.path,
            "name": self.name,
            "source_tool": self.source_tool,
            "mime_type": self.mime_type,
            "size": self.size,
            "created_at": self.created_at,
            "artifact_id": self.artifact_id,
            "status": self.status,
            "turn": self.turn,
        }


def guess_mime_type(path: str) -> str:
    """按扩展名推断 MIME 类型（无法识别时返回通用二进制类型）。"""
    name = path.rsplit("/", 1)[-1]
    if "." not in name:
        return _DEFAULT_MIME
    ext = name.rsplit(".", 1)[-1].lower()
    return _MIME_BY_EXT.get(ext, _DEFAULT_MIME)


def extract_artifact_paths(tool_name: str, tool_input: str) -> list[str]:
    """从工具名与入参解析产物文件路径（绝对路径、去重保序）。"""
    if not tool_name:
        return []

    data = _parse_input(tool_input)
    lowered = tool_name.lower()
    candidates: list[str] = []

    if data is not None and any(key in lowered for key in _WRITE_TOOL_KEYWORDS):
        for key in _PATH_KEYS:
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                candidates.append(value)
                break

    if data is not None:
        command = data.get("command") or data.get("cmd")
        if isinstance(command, str) and command:
            candidates.extend(_REDIRECT_RE.findall(command))

    result: list[str] = []
    for raw in candidates:
        path = _normalize_path(raw)
        if path and not _should_skip(path) and path not in result:
            result.append(path)
    return result


def _parse_input(tool_input: str) -> dict[str, Any] | None:
    """解析工具入参 JSON；无法解析时返回 None。"""
    if not tool_input:
        return None
    try:
        parsed = json.loads(tool_input)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _normalize_path(raw: str) -> str:
    """规范化候选路径：去引号、补全相对路径、排除目录与协议地址。

    文件工具的虚拟根即 ``/``，因此相对路径（如 ``文章.md``）按根目录补全；
    协议地址（http/data/file 等）与目录路径直接丢弃。
    """
    value = raw.strip().strip('"').replace("\\", "/")
    if not value or value.endswith("/"):
        return ""
    if _SCHEME_RE.match(value):
        return ""
    if not value.startswith("/"):
        value = "/" + value
    parts = [part for part in value.split("/") if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        return ""
    return "/" + "/".join(parts)


def _should_skip(path: str) -> bool:
    """排除系统目录与编译缓存，避免把环境噪声登记成产物。"""
    if any(path.startswith(prefix) for prefix in _SKIP_PREFIXES):
        return True
    return any(path.endswith(suffix) for suffix in _SKIP_SUFFIXES)


def turn_of(path: str) -> str:
    """从产物路径解析交付轮次（``turn-<n>``）；非交付路径返回空串。"""
    from agent.sandbox.delivery import turn_from_path

    return turn_from_path(path)


def _to_artifact(row: Any) -> Artifact:
    """ORM 记录 → Artifact。"""
    created = getattr(row, "created_at", None)
    return Artifact(
        path=row.file_path,
        name=row.filename,
        source_tool=row.source_tool or "",
        mime_type=row.file_type or _DEFAULT_MIME,
        size=int(row.file_size or 0),
        created_at=created.timestamp() if created is not None else time.time(),
        artifact_id=getattr(row, "artifact_id", "") or "",
        status=getattr(row, "status", STATUS_PENDING) or STATUS_PENDING,
        storage_key=getattr(row, "storage_key", "") or "",
        turn=turn_of(row.file_path),
    )


def _now() -> datetime:
    """返回当前时间（数据库统一存储无时区的本地时间）。"""
    return datetime.now(UTC).replace(tzinfo=None)


def _setting_int(name: str, default: int) -> int:
    """读取产物相关整型配置（缺省或非法值回退默认值）。"""
    from agent.config import settings

    try:
        return int(getattr(settings, name, default))
    except (TypeError, ValueError):
        return default


async def record_artifacts(
    thread_id: str,
    user_id: str,
    tool_name: str,
    tool_input: str,
    *,
    persist: bool = True,
) -> list[Artifact]:
    """解析并登记本次工具调用产生的产物，返回本次新增记录（同会话同路径不重复登记）。

    Args:
        thread_id: 会话 ID。
        user_id: 用户 ID。
        tool_name: 触发写入的工具名。
        tool_input: 工具入参 JSON 字符串。
        persist: 是否在登记后立即物化到持久存储（默认开启）。

    Returns:
        本次新增的产物列表；物化成功时含持久化后的元信息。
    """
    paths = extract_artifact_paths(tool_name, tool_input)
    if not paths:
        return []

    from db.engine import async_session
    from db.models.chat_artifact import ChatArtifact

    added: list[Artifact] = []
    refreshed: list[str] = []
    async with async_session() as session:
        for path in paths:
            existing = (
                await session.execute(
                    select(ChatArtifact).where(
                        ChatArtifact.thread_id == thread_id,
                        ChatArtifact.file_path == path,
                    )
                )
            ).scalar_one_or_none()
            if existing is not None:
                # 同一路径被再次写入：内容可能已更新，收集起来重新物化
                refreshed.append(existing.artifact_id)
                continue
            row = ChatArtifact(
                thread_id=thread_id,
                user_id=user_id,
                file_path=path,
                filename=path.rsplit("/", 1)[-1],
                file_type=guess_mime_type(path),
                file_size=0,
                source_tool=tool_name,
                artifact_id=str(uuid.uuid4()),
                status=STATUS_PENDING,
            )
            session.add(row)
            added.append(_to_artifact(row))
        await session.commit()

    if not persist or not added:
        return added

    # 生成当刻就物化：此时沙箱必然存活，成功率最高
    materialized: list[Artifact] = []
    for item in added:
        saved = await persist_artifact(user_id, thread_id, item.artifact_id)
        materialized.append(saved or item)
    for artifact_id in refreshed:
        saved = await persist_artifact(user_id, thread_id, artifact_id, force=True)
        if saved is not None:
            materialized.append(saved)
    return materialized


async def persist_artifact(
    user_id: str, thread_id: str, artifact_id: str, *, force: bool = False
) -> Artifact | None:
    """把单个产物从沙箱物化到持久存储（幂等，失败仅告警）。

    Args:
        user_id: 产物所属用户。
        thread_id: 产物所属会话。
        artifact_id: 产物 ID。

    Returns:
        物化成功返回最新元信息；沙箱或配置异常时返回 None。
    """
    if not artifact_id:
        return None

    from agent import get_sandbox_manager
    from db.engine import async_session
    from db.models.chat_artifact import ChatArtifact

    store = get_artifact_store()
    async with async_session() as session:
        row = (
            await session.execute(
                select(ChatArtifact).where(
                    ChatArtifact.thread_id == thread_id,
                    ChatArtifact.artifact_id == artifact_id,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        if not force and row.status == STATUS_READY and row.storage_key:
            if store.exists(row.storage_key):
                return _to_artifact(row)
            return _to_artifact(row)
        source_path = row.file_path
        filename = row.filename

    content: bytes | None
    if is_agent_artifact_path(source_path):
        # 交付目录：内容由宿主 staging 提供，无需访问沙箱
        content = await asyncio.to_thread(read_staging_file, user_id, source_path)
        if content is None:
            await mark_artifact_failed(thread_id, artifact_id, "交付目录文件不存在")
            return None
    else:
        try:
            backend = get_sandbox_manager().get_or_create_backend(user_id)
            results = await asyncio.to_thread(backend.download_files, [source_path])
        except Exception:
            logger.warning("产物物化失败（沙箱读取异常）：%s", source_path, exc_info=True)
            await mark_artifact_failed(thread_id, artifact_id, "沙箱读取失败")
            return None

        content = results[0].content if results else None
        if not results or results[0].error or content is None:
            detail = results[0].error if results else "download_failed"
            await mark_artifact_failed(
                thread_id, artifact_id, str(detail or "download_failed")
            )
            return None

    max_bytes = _setting_int("ARTIFACT_MAX_FILE_MB", 100) * 1024 * 1024
    if max_bytes > 0 and len(content) > max_bytes:
        await mark_artifact_failed(thread_id, artifact_id, "文件超过单文件大小上限")
        return None

    if not await _within_user_quota(user_id, len(content)):
        await mark_artifact_failed(thread_id, artifact_id, "超出用户产物配额")
        return None

    key = build_storage_key(user_id, thread_id, artifact_id, filename)
    try:
        await asyncio.to_thread(store.save, key, content)
    except Exception:
        logger.exception("产物写入持久存储失败：%s", key)
        await mark_artifact_failed(thread_id, artifact_id, "写入持久存储失败")
        return None

    async with async_session() as session:
        row = (
            await session.execute(
                select(ChatArtifact).where(
                    ChatArtifact.thread_id == thread_id,
                    ChatArtifact.artifact_id == artifact_id,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        row.storage_key = key
        row.storage_backend = "local"
        row.status = STATUS_READY
        row.file_size = len(content)
        row.checksum = checksum_of(content)
        row.last_error = ""
        row.updated_at = _now()
        await session.flush()
        await session.refresh(row)
        artifact = _to_artifact(row)
        await session.commit()
    return artifact


async def persist_pending_artifacts(
    user_id: str, thread_id: str, *, limit: int = 20
) -> list[Artifact]:
    """批量物化尚未就绪的产物（流结束后的兜底，返回本次成功项）。"""
    pending = await list_unready_artifacts(thread_id, limit=limit)
    saved: list[Artifact] = []
    for item in pending:
        materialized = await persist_artifact(user_id, thread_id, item.artifact_id)
        if materialized is not None:
            saved.append(materialized)
    return saved


async def _within_user_quota(user_id: str, incoming_bytes: int) -> bool:
    """判断写入后是否仍在用户产物配额内（配额为 0 表示不限制）。"""
    quota_mb = _setting_int("ARTIFACT_USER_QUOTA_MB", 2048)
    if quota_mb <= 0:
        return True
    used = await user_artifact_usage_bytes(user_id)
    return used + incoming_bytes <= quota_mb * 1024 * 1024


async def user_artifact_usage_bytes(user_id: str) -> int:
    """统计用户已就绪产物的总字节数（用于配额判断）。"""
    from db.engine import async_session
    from db.models.chat_artifact import ChatArtifact

    async with async_session() as session:
        total = (
            await session.execute(
                select(func.coalesce(func.sum(ChatArtifact.file_size), 0)).where(
                    ChatArtifact.user_id == user_id,
                    ChatArtifact.status == STATUS_READY,
                )
            )
        ).scalar_one()
    return int(total or 0)


async def list_ready_artifacts(
    thread_id: str, user_id: str, *, limit: int = 20
) -> list[Artifact]:
    """列出该会话已物化就绪的产物（用于沙箱重建后的回灌）。"""
    from db.engine import async_session
    from db.models.chat_artifact import ChatArtifact

    async with async_session() as session:
        rows = (
            await session.execute(
                select(ChatArtifact)
                .where(
                    ChatArtifact.thread_id == thread_id,
                    ChatArtifact.user_id == user_id,
                    ChatArtifact.status == STATUS_READY,
                )
                .order_by(ChatArtifact.created_at)
                .limit(limit)
            )
        ).scalars().all()
    return [_to_artifact(row) for row in rows]


async def list_unready_artifacts(thread_id: str, *, limit: int = 20) -> list[Artifact]:
    """列出尚未物化就绪的产物（待物化或物化失败）。"""
    from db.engine import async_session
    from db.models.chat_artifact import ChatArtifact

    async with async_session() as session:
        rows = (
            await session.execute(
                select(ChatArtifact)
                .where(
                    ChatArtifact.thread_id == thread_id,
                    ChatArtifact.status.in_((STATUS_PENDING, STATUS_FAILED)),
                )
                .order_by(ChatArtifact.created_at)
                .limit(limit)
            )
        ).scalars().all()
    return [_to_artifact(row) for row in rows]


async def _update_status(
    thread_id: str, artifact_id: str, status: str, error: str
) -> None:
    """更新产物状态与最近错误信息（失败仅告警）。"""
    if not artifact_id:
        return
    from db.engine import async_session
    from db.models.chat_artifact import ChatArtifact

    try:
        async with async_session() as session:
            await session.execute(
                update(ChatArtifact)
                .where(
                    ChatArtifact.thread_id == thread_id,
                    ChatArtifact.artifact_id == artifact_id,
                )
                .values(status=status, last_error=error[:255], updated_at=_now())
            )
            await session.commit()
    except Exception:
        logger.debug("更新产物状态失败（artifact_id=%s）", artifact_id, exc_info=True)


async def mark_artifact_failed(thread_id: str, artifact_id: str, error: str) -> None:
    """把产物标记为物化失败并记录原因。"""
    await _update_status(thread_id, artifact_id, STATUS_FAILED, error)


async def mark_artifact_expired(thread_id: str, artifact_id: str) -> None:
    """把产物标记为已过期（持久副本与沙箱均不可用）。"""
    await _update_status(thread_id, artifact_id, STATUS_EXPIRED, "文件已过期，无法恢复")


async def list_artifacts(thread_id: str, user_id: str) -> list[Artifact]:
    """列出指定会话（且属于该用户）的产物，按创建时间升序。"""
    from db.engine import async_session
    from db.models.chat_artifact import ChatArtifact

    async with async_session() as session:
        rows = (
            await session.execute(
                select(ChatArtifact)
                .where(
                    ChatArtifact.thread_id == thread_id,
                    ChatArtifact.user_id == user_id,
                )
                .order_by(ChatArtifact.created_at)
            )
        ).scalars().all()
    return [_to_artifact(row) for row in rows]


def pick_turn_artifacts(
    items: list[Artifact],
    delivery_dir: str,
    emitted: set[str],
) -> list[Artifact]:
    """挑出本轮交付目录下、尚未推送过事件的产物（保序），并记录已推送标识。

    会话产物按「路径」去重：``download_asset`` 等工具在工具内部直接落库登记，
    随后基于工具入参的登记逻辑只会看到「已存在」而不返回新增记录，前端因此收不到
    SSE ``artifact`` 事件（当轮不出现交付物卡片与打包入口）。本函数用
    「交付目录前缀 + 已推送集合」求差集，作为事件推送的统一出口。

    Args:
        items: 该会话的全部产物（按创建时间升序）。
        delivery_dir: 本轮交付目录虚拟路径，例如 ``/artifacts/<thread>/turn-2``。
        emitted: 本次流已推送过的产物标识集合（函数内原地更新）。

    Returns:
        本次需要推送 ``artifact`` 事件的产物列表。
    """
    prefix = delivery_dir.rstrip('/') + '/' if delivery_dir else ''
    if not prefix:
        return []

    fresh: list[Artifact] = []
    for item in items:
        if not item.path.startswith(prefix):
            continue
        key = item.artifact_id or item.path
        if key in emitted:
            continue
        emitted.add(key)
        fresh.append(item)
    return fresh


async def get_artifact(thread_id: str, user_id: str, path: str) -> Artifact | None:
    """按会话与路径查询单条产物（下载前校验归属）。"""
    from db.engine import async_session
    from db.models.chat_artifact import ChatArtifact

    async with async_session() as session:
        row = (
            await session.execute(
                select(ChatArtifact).where(
                    ChatArtifact.thread_id == thread_id,
                    ChatArtifact.user_id == user_id,
                    ChatArtifact.file_path == path,
                )
            )
        ).scalar_one_or_none()
    return _to_artifact(row) if row is not None else None


async def get_artifact_by_id(
    thread_id: str, user_id: str, artifact_id: str
) -> Artifact | None:
    """按产物 ID 查询单条产物（同一会话内，供恢复接口使用）。"""
    from db.engine import async_session
    from db.models.chat_artifact import ChatArtifact

    async with async_session() as session:
        row = (
            await session.execute(
                select(ChatArtifact).where(
                    ChatArtifact.thread_id == thread_id,
                    ChatArtifact.user_id == user_id,
                    ChatArtifact.artifact_id == artifact_id,
                )
            )
        ).scalar_one_or_none()
    return _to_artifact(row) if row is not None else None


async def list_artifacts_without_size(thread_id: str) -> list[Artifact]:
    """列出尚未解析文件大小的产物（用于流结束后补全元信息）。"""
    from db.engine import async_session
    from db.models.chat_artifact import ChatArtifact

    async with async_session() as session:
        rows = (
            await session.execute(
                select(ChatArtifact).where(
                    ChatArtifact.thread_id == thread_id,
                    ChatArtifact.file_size == 0,
                )
            )
        ).scalars().all()
    return [_to_artifact(row) for row in rows]


async def update_artifact_size(thread_id: str, path: str, size: int) -> None:
    """更新单条产物的文件大小。"""
    from db.engine import async_session
    from db.models.chat_artifact import ChatArtifact

    async with async_session() as session:
        row = (
            await session.execute(
                select(ChatArtifact).where(
                    ChatArtifact.thread_id == thread_id,
                    ChatArtifact.file_path == path,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            return
        row.file_size = max(0, int(size))
        row.updated_at = _now()
        await session.commit()


async def delete_artifacts_by_thread(thread_id: str) -> int:
    """删除会话的全部产物记录与持久化文件，返回删除的记录数。"""
    if not thread_id:
        return 0
    from db.engine import async_session
    from db.models.chat_artifact import ChatArtifact

    async with async_session() as session:
        rows = (
            await session.execute(
                select(ChatArtifact).where(ChatArtifact.thread_id == thread_id)
            )
        ).scalars().all()
        user_ids = {row.user_id for row in rows}
        count = len(rows)
        if count:
            await session.execute(
                delete(ChatArtifact).where(ChatArtifact.thread_id == thread_id)
            )
            await session.commit()

    store = get_artifact_store()
    for user_id in user_ids:
        try:
            await asyncio.to_thread(
                store.delete_prefix, build_thread_prefix(user_id, thread_id)
            )
        except Exception:
            logger.warning(
                "删除会话产物文件失败（thread_id=%s）", thread_id, exc_info=True
            )
    return count


async def purge_orphan_objects(
    *, older_than_seconds: float = 600, limit: int = 200
) -> int:
    """清理存储中已无数据库记录的孤儿对象，返回删除数量。

    Args:
        older_than_seconds: 仅清理该秒数之前写入的对象，避免与正在进行的物化竞争。
        limit: 单次清理数量上限。

    Returns:
        实际删除的对象数量。
    """
    from db.engine import async_session
    from db.models.chat_artifact import ChatArtifact

    store = get_artifact_store()
    keys = await asyncio.to_thread(
        store.list_keys, older_than_seconds=older_than_seconds
    )
    if not keys:
        return 0

    async with async_session() as session:
        rows = (
            await session.execute(
                select(ChatArtifact.storage_key).where(ChatArtifact.storage_key != "")
            )
        ).scalars().all()
    known = {str(key) for key in rows if key}

    removed = 0
    for key in keys:
        if removed >= limit:
            break
        if key in known:
            continue
        try:
            await asyncio.to_thread(store.delete, key)
            removed += 1
        except Exception:
            logger.warning("清理孤儿产物对象失败：%s", key, exc_info=True)
    if removed:
        logger.info("已清理 %d 个孤儿产物对象", removed)
    return removed


async def purge_expired_artifacts(retention_days: int, *, limit: int = 200) -> int:
    """清理超过留存期的产物（DB 记录 + 持久化文件），返回清理数量。"""
    if retention_days <= 0:
        return 0
    from db.engine import async_session
    from db.models.chat_artifact import ChatArtifact

    cutoff = _now() - timedelta(days=retention_days)
    async with async_session() as session:
        rows = (
            await session.execute(
                select(ChatArtifact)
                .where(ChatArtifact.created_at < cutoff)
                .order_by(ChatArtifact.created_at)
                .limit(limit)
            )
        ).scalars().all()
        entries = [(row.user_id, row.storage_key) for row in rows]
        if entries:
            await session.execute(
                delete(ChatArtifact).where(
                    ChatArtifact.id.in_([row.id for row in rows])
                )
            )
            await session.commit()

    store = get_artifact_store()
    removed = 0
    for _user_id, storage_key in entries:
        if not storage_key:
            continue
        try:
            await asyncio.to_thread(store.delete, storage_key)
            removed += 1
        except Exception:
            logger.warning("清理过期产物文件失败：%s", storage_key, exc_info=True)
    return len(entries)


# ── 交付目录（/artifacts/<thread>/turn-<n>/）与后端代理下载 ──────────────────


def _split_hosts(raw: str) -> list[str]:
    """把逗号分隔的域名白名单解析为列表。"""
    return [item.strip() for item in (raw or "").split(",") if item.strip()]


def _artifact_fetch_limits() -> tuple[float, int, list[str]]:
    """读取代理下载配置：超时（秒）、大小上限（字节）、域名白名单。"""
    from agent.config import settings

    timeout = _setting_int("ARTIFACT_FETCH_TIMEOUT_SECONDS", 60)
    max_mb = _setting_int(
        "ARTIFACT_FETCH_MAX_MB", _setting_int("ARTIFACT_MAX_FILE_MB", 100)
    )
    hosts = _split_hosts(str(getattr(settings, "ARTIFACT_FETCH_ALLOWED_HOSTS", "") or ""))
    return (
        float(timeout) if timeout > 0 else 60.0,
        max(0, max_mb) * 1024 * 1024,
        hosts,
    )


def _write_bytes_file(target: Any, content: bytes) -> None:
    """把字节写入目标文件（自动创建父目录）。"""
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)


async def _upsert_artifact_row(
    thread_id: str,
    user_id: str,
    file_path: str,
    source_tool: str,
    mime_type: str,
) -> str:
    """登记（或复用）一条产物记录，返回 artifact_id。"""
    from db.engine import async_session
    from db.models.chat_artifact import ChatArtifact

    async with async_session() as session:
        row = (
            await session.execute(
                select(ChatArtifact).where(
                    ChatArtifact.thread_id == thread_id,
                    ChatArtifact.file_path == file_path,
                )
            )
        ).scalar_one_or_none()
        if row is not None:
            row.source_tool = source_tool or row.source_tool
            row.file_type = mime_type or row.file_type
            row.updated_at = _now()
            await session.commit()
            return str(row.artifact_id)
        created = ChatArtifact(
            thread_id=thread_id,
            user_id=user_id,
            file_path=file_path,
            filename=file_path.rsplit("/", 1)[-1],
            file_type=mime_type or guess_mime_type(file_path),
            file_size=0,
            source_tool=source_tool,
            artifact_id=str(uuid.uuid4()),
            status=STATUS_PENDING,
        )
        session.add(created)
        await session.commit()
        return str(created.artifact_id)


async def ingest_remote_asset(
    user_id: str,
    thread_id: str,
    url: str,
    rel_path: str,
    *,
    delivery_dir: str = "",
) -> Artifact:
    """后端代理下载远程图片，落到本轮交付目录并登记、物化为会话产物。

    Args:
        user_id: 产物所属用户。
        thread_id: 产物所属会话。
        url: 远程图片地址（仅 http/https）。
        rel_path: 相对交付目录的保存路径，如 ``文章标题/figure-1.png``。
        delivery_dir: 本轮交付目录（虚拟绝对路径）；为空时回退到 ``turn-1``。

    Returns:
        已就绪的产物。

    Raises:
        ValueError: 交付路径非法。
        AssetFetchError: 下载或校验失败。
        RuntimeError: 物化失败。
    """
    from agent.sandbox.delivery import delivery_virtual_dir, normalize_delivery_rel
    from core.storage.agent_staging import staging_file_path
    from core.storage.asset_fetcher import fetch_image

    rel = normalize_delivery_rel(rel_path)
    base = (delivery_dir or delivery_virtual_dir(thread_id, "turn-1")).rstrip("/")
    virtual_path = base + "/" + rel

    target = staging_file_path(user_id, virtual_path)
    if target is None:
        raise ValueError("非法的交付路径")

    timeout, max_bytes, hosts = _artifact_fetch_limits()
    asset = await fetch_image(
        url, timeout=timeout, max_bytes=max_bytes, allowed_hosts=hosts
    )

    await asyncio.to_thread(_write_bytes_file, target, asset.content)
    artifact_id = await _upsert_artifact_row(
        thread_id, user_id, virtual_path, "download_asset", asset.mime_type
    )
    saved = await persist_artifact(user_id, thread_id, artifact_id, force=True)
    if saved is None or not saved.storage_key:
        raise RuntimeError("素材物化失败")
    return saved


def delivery_turn_prefix(thread_id: str, turn: str | None = None) -> str:
    """返回交付目录（或指定轮次）的虚拟路径前缀（以 ``/`` 结尾）。"""
    from agent.sandbox.delivery import delivery_thread_dir, safe_segment

    if turn:
        return delivery_thread_dir(thread_id) + "/" + safe_segment(turn, "turn-1") + "/"
    return delivery_thread_dir(thread_id) + "/"


async def list_bundle_artifacts(
    thread_id: str, user_id: str, *, turn: str | None = None
) -> list[Artifact]:
    """列出某轮（或整个会话）交付目录下的产物，按创建时间升序。"""
    prefix = delivery_turn_prefix(thread_id, turn)
    from db.engine import async_session
    from db.models.chat_artifact import ChatArtifact

    async with async_session() as session:
        rows = (
            await session.execute(
                select(ChatArtifact)
                .where(
                    ChatArtifact.thread_id == thread_id,
                    ChatArtifact.user_id == user_id,
                    ChatArtifact.file_path.like(prefix + "%"),
                )
                .order_by(ChatArtifact.created_at)
            )
        ).scalars().all()
    return [_to_artifact(row) for row in rows]


def build_bundle_zip(
    user_id: str,
    thread_id: str,
    *,
    scope: str = "turn",
    turn: str | None = None,
) -> tuple[str, bytes] | None:
    """把交付目录打包成 zip。

    Args:
        user_id: 产物所属用户。
        thread_id: 产物所属会话。
        scope: ``turn`` 只打包本轮；``thread`` 打包整个会话（含全部轮次）。
        turn: 指定轮次目录名（缺省取最新一轮）。

    Returns:
        ``(下载文件名, zip 字节)``；目录不存在或没有文件时返回 ``None``。
    """
    from agent.sandbox.delivery import (
        delivery_host_dir,
        delivery_thread_root,
        list_turn_dirs,
        safe_segment,
    )

    if scope == "thread":
        base = delivery_thread_root(user_id, thread_id)
        archive_name = safe_segment(thread_id) + "-bundle.zip"
    else:
        target_turn = turn or ""
        if not target_turn:
            turns = list_turn_dirs(user_id, thread_id)
            target_turn = turns[-1] if turns else ""
        if not target_turn:
            return None
        base = delivery_host_dir(user_id, thread_id, target_turn, create=False)
        archive_name = safe_segment(target_turn, "turn") + "-bundle.zip"

    if not base.is_dir():
        return None

    buffer = io.BytesIO()
    count = 0
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(base.rglob("*")):
            if not path.is_file():
                continue
            archive.write(path, path.relative_to(base).as_posix())
            count += 1
    if count == 0:
        return None
    return archive_name, buffer.getvalue()


async def restore_delivery_artifacts(
    user_id: str, thread_id: str, *, limit: int = 200
) -> int:
    """把已物化的交付目录产物按需回填宿主 staging，返回回填文件数。

    交付目录挂在宿主（``{WORKSPACE}/artifacts_agent/<user>``），但留存期清理会
    删除 staging 中的旧文件；此时智能体再读写历史交付物就会失败。本函数按持久层
    副本补写缺失文件，保证"历史交付物始终可读写"。
    """
    from core.storage.agent_staging import staging_file_path

    items = await list_ready_artifacts(thread_id, user_id, limit=limit)
    if not items:
        return 0

    store = get_artifact_store()
    max_mb = _setting_int("ARTIFACT_MAX_FILE_MB", 100)
    max_bytes = max(0, max_mb) * 1024 * 1024

    restored = 0
    for item in items:
        if not item.storage_key or not item.path:
            continue
        if not is_agent_artifact_path(item.path):
            # 非交付目录产物由沙箱回灌中间件负责
            continue
        target = staging_file_path(user_id, item.path)
        if target is None:
            continue
        if await asyncio.to_thread(target.is_file):
            continue
        content = await asyncio.to_thread(store.open, item.storage_key)
        if content is None:
            continue
        if max_bytes and len(content) > max_bytes:
            logger.info("交付产物超过回填大小上限，已跳过：%s", item.path)
            continue
        await asyncio.to_thread(_write_bytes_file, target, content)
        restored += 1

    if restored:
        logger.info(
            "已回填 %d 个交付产物到宿主交付目录（thread_id=%s）", restored, thread_id
        )
    return restored


async def scan_delivery_artifacts(
    user_id: str, thread_id: str, turn: str, *, limit: int = 200
) -> list[Artifact]:
    """扫描本轮交付目录，把尚未登记（或未就绪）的文件补登记并物化。"""
    from agent.sandbox.delivery import delivery_host_dir, delivery_virtual_dir

    base = delivery_host_dir(user_id, thread_id, turn, create=False)
    if not base.is_dir():
        return []

    virtual_root = delivery_virtual_dir(thread_id, turn)
    saved: list[Artifact] = []
    for index, path in enumerate(sorted(base.rglob("*"))):
        if index >= limit:
            break
        if not path.is_file():
            continue
        virtual_path = virtual_root + "/" + path.relative_to(base).as_posix()
        existing = await get_artifact(thread_id, user_id, virtual_path)
        if existing is not None and existing.status == STATUS_READY and existing.storage_key:
            continue
        artifact_id = await _upsert_artifact_row(
            thread_id,
            user_id,
            virtual_path,
            "delivery_scan",
            guess_mime_type(virtual_path),
        )
        materialized = await persist_artifact(
            user_id, thread_id, artifact_id, force=True
        )
        if materialized is not None:
            saved.append(materialized)
    return saved
