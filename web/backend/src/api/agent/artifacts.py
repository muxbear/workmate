"""会话产物（生成文件）解析、登记、物化与查询。

智能体在沙箱内生成的文件通过工具调用入参识别（写文件类工具 + shell 重定向），
登记到 chat_artifacts 表，并物化到后端持久存储（默认本地磁盘），
供网页版消息卡片与右侧产物面板展示、下载（沙箱回收或服务重启后仍可访问）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
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
    """规范化候选路径：去引号、要求绝对路径且不是目录。"""
    value = raw.strip().strip('"')
    if not value.startswith("/") or value.endswith("/"):
        return ""
    return value


def _should_skip(path: str) -> bool:
    """排除系统目录与编译缓存，避免把环境噪声登记成产物。"""
    if any(path.startswith(prefix) for prefix in _SKIP_PREFIXES):
        return True
    return any(path.endswith(suffix) for suffix in _SKIP_SUFFIXES)


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
