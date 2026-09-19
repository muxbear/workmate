"""会话产物（生成文件）解析、登记与查询。

智能体在沙箱内生成的文件通过工具调用入参识别（写文件类工具 + shell 重定向），
登记到 chat_artifacts 表，供网页版消息卡片与右侧产物面板展示、下载（重启后仍可查询）。
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select

logger = logging.getLogger(__name__)

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
_SKIP_PREFIXES: tuple[str, ...] = ("/proc/", "/sys/", "/dev/", "/usr/", "/opt/", "/var/lib/")
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

    def to_dict(self) -> dict[str, Any]:
        """转换为可 JSON 序列化的字典（SSE 与列表接口共用）。"""
        return {
            "path": self.path,
            "name": self.name,
            "source_tool": self.source_tool,
            "mime_type": self.mime_type,
            "size": self.size,
            "created_at": self.created_at,
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
    )


async def record_artifacts(
    thread_id: str, user_id: str, tool_name: str, tool_input: str
) -> list[Artifact]:
    """解析并登记本次工具调用产生的产物，返回本次新增记录（同会话同路径不重复登记）。"""
    paths = extract_artifact_paths(tool_name, tool_input)
    if not paths:
        return []

    from db.engine import async_session
    from db.models.chat_artifact import ChatArtifact

    added: list[Artifact] = []
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
                continue
            row = ChatArtifact(
                thread_id=thread_id,
                user_id=user_id,
                file_path=path,
                filename=path.rsplit("/", 1)[-1],
                file_type=guess_mime_type(path),
                file_size=0,
                source_tool=tool_name,
            )
            session.add(row)
            added.append(_to_artifact(row))
        await session.commit()
    return added


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
        await session.commit()
