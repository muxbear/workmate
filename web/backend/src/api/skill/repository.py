"""技能仓库抓取与导入.

从可公开抓取的权威技能仓库（GitHub）按热度拉取技能榜单，并把选中的技能包下载、
校验、落盘到 workspace/skills_upload/ 后入库。

实现要点：
- 榜单来源优先取「参数配置」中参数编码为 skill_download_site 的参数（子参数即下载站点），
  未配置时回退内置注册表（Anthropic 官方技能仓库与高星社区技能库）；
- 抓取使用 GitHub REST API：仓库元信息提供星标数（热度），tarball 接口一次性拉取仓库
  快照后在本地解析，避免逐文件请求与二次限流；
- 榜单排序依据为「权威级别（官方优先）→ 仓库星标数 → 技能名」，排名与热度随响应返回；
- 抓取结果按 TTL 缓存，刷新失败时沿用最近一次成功快照；
- 导入严格复用上传校验规则：校验不通过不落盘、不入库。
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import posixpath
import re
import shutil
import tarfile
import tempfile
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.skill.schemas import (
    SkillRepoImportRequest,
    SkillRepoImportResponse,
    SkillRepoListResponse,
    SkillRepoSkillItem,
    SkillRepoSourceItem,
    SkillResult,
    SkillValidationError,
)
from api.skill.service import (
    MAX_UPLOAD_SIZE_MB,
    SKILLS_DIR,
    parse_skill_frontmatter,
    validate_skill_directory,
)
from db.models.skill import Skill
from db.models.system_param import SystemParam

logger = logging.getLogger(__name__)

GITHUB_API = os.environ.get("SKILL_REPO_GITHUB_API", "https://api.github.com")
CACHE_TTL_SECONDS = int(os.environ.get("SKILL_REPO_CACHE_TTL", "1800"))
REQUEST_TIMEOUT_SECONDS = float(os.environ.get("SKILL_REPO_TIMEOUT", "30"))
MAX_TARBALL_MB = int(os.environ.get("SKILL_REPO_MAX_TARBALL_MB", "64"))
MAX_CACHE_MB = int(os.environ.get("SKILL_REPO_MAX_CACHE_MB", "128"))
RANK_BASIS = "按权威级别（官方优先）与仓库星标数排序"
KNOWN_CATEGORIES = {"search", "code", "creative", "analysis", "tools", "custom"}


@dataclass(frozen=True)
class RepoSource:
    """一个可抓取的技能仓库来源."""

    id: str
    name: str
    repository: str
    skills_path: str
    description: str
    homepage: str
    authority: str


REPO_SOURCES: tuple[RepoSource, ...] = (
    RepoSource(
        id="anthropic-official",
        name="Anthropic 官方技能仓库",
        repository="anthropics/skills",
        skills_path="skills",
        description="Anthropic 第一方维护的 Agent Skills 技能包（官方权威）",
        homepage="https://github.com/anthropics/skills",
        authority="official",
    ),
    RepoSource(
        id="superpowers",
        name="Superpowers 技能库",
        repository="obra/superpowers",
        skills_path="skills",
        description="GitHub 高星社区技能库（MIT），覆盖研发全流程",
        homepage="https://github.com/obra/superpowers",
        authority="community",
    ),
)

# 「参数配置」中技能下载站点对应的参数编码
SKILL_DOWNLOAD_SITE_PARAM = "skill_download_site"
DEFAULT_SKILLS_PATH = "skills"
DEFAULT_AUTHORITY = "custom"

# GitHub 仓库地址：支持 https://github.com/owner/repo(.git)、git@github.com:owner/repo.git
# 以及带目录的 https://github.com/owner/repo/tree/main/skills
_GITHUB_REPO_PATTERN = re.compile(
    r"^(?:git\+)?(?:https?://|ssh://|git://)?(?:[^@/\s]+@)?(?:www\.)?github\.com[:/]"
    r"(?P<owner>[^/\s]+)/(?P<repo>[^/\s]+?)(?:\.git)?"
    r"(?:/tree/[^/\s]+/(?P<path>[^\s]+))?$"
)
# 简写的 owner/repo 写法
_REPO_SLUG_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


@dataclass
class _SourceSnapshot:
    """单个来源的抓取快照."""

    fetched_at: float
    stars: int
    default_branch: str
    tarball: bytes
    items: list[SkillRepoSkillItem]
    dir_files: dict[str, list[str]]


_snapshots: dict[str, _SourceSnapshot] = {}
_ranked_items: list[SkillRepoSkillItem] = []
_ranked_at: float = 0.0
_ranked_key: tuple[tuple[str, str, str], ...] = ()
_load_lock = asyncio.Lock()


def to_source_items(sources: list[RepoSource]) -> list[SkillRepoSourceItem]:
    """把内部来源结构转换成接口返回结构."""
    return [
        SkillRepoSourceItem(
            id=source.id,
            name=source.name,
            description=source.description,
            authority=source.authority,
            repository=source.repository,
            homepage=source.homepage,
            skills_path=source.skills_path,
        )
        for source in sources
    ]


def list_sources() -> list[SkillRepoSourceItem]:
    """返回内置的技能仓库来源列表（未配置参数时的回退）."""
    return to_source_items(list(REPO_SOURCES))


def parse_repository_url(value: str) -> tuple[str, str]:
    """解析仓库地址，返回 (owner/repo, 技能目录).

    支持 ``https://github.com/owner/repo``、``owner/repo``、
    ``git@github.com:owner/repo.git`` 以及带目录的
    ``https://github.com/owner/repo/tree/main/skills`` 等写法。

    Args:
        value: 参数配置中的仓库地址。

    Returns:
        (repository, skills_path)；无法识别时 repository 为空字符串。
    """
    text = (value or "").strip()
    if not text:
        return "", DEFAULT_SKILLS_PATH
    text = text.split("#", 1)[0].split("?", 1)[0].strip().rstrip("/")
    if not text:
        return "", DEFAULT_SKILLS_PATH
    matched = _GITHUB_REPO_PATTERN.match(text)
    if matched:
        repository = f"{matched.group('owner')}/{matched.group('repo')}"
        path = (matched.group("path") or "").strip("/")
        return repository, path or DEFAULT_SKILLS_PATH
    if _REPO_SLUG_PATTERN.match(text):
        return text, DEFAULT_SKILLS_PATH
    return "", DEFAULT_SKILLS_PATH


def _slugify(value: str) -> str:
    """把名称转换成可用作来源 id 的短标识（保留中文等字符）."""
    slug = re.sub(r"[^\w.-]+", "-", (value or "").strip()).strip("-")
    return slug.lower()


def _build_source(
    source_id: str = "",
    name: str = "",
    url: str = "",
    description: str = "",
    repository: str = "",
    skills_path: str = "",
    authority: str = "",
) -> RepoSource | None:
    """把一条参数配置转换成技能仓库来源，缺少必要信息时返回 None."""
    identifier = (source_id or "").strip()
    if not identifier:
        return None

    repo_slug, parsed_path = parse_repository_url(repository or url)
    path = (skills_path or "").strip().strip("/") or parsed_path
    homepage = (url or "").strip()
    if not homepage.startswith("http"):
        homepage = f"https://github.com/{repo_slug}" if repo_slug else ""
    if not repo_slug and not homepage:
        return None
    return RepoSource(
        id=identifier,
        name=(name or "").strip() or identifier,
        repository=repo_slug,
        skills_path=path,
        description=(description or "").strip(),
        homepage=homepage,
        authority=(authority or "").strip() or DEFAULT_AUTHORITY,
    )


def _entries_from_json(raw: str) -> list[dict[str, str]]:
    """把 JSON 形式的参数值解析成站点条目列表."""
    try:
        data: Any = json.loads(raw)
    except (TypeError, ValueError):
        # 非 JSON：按逗号/分号/换行分隔的地址列表处理
        data = raw

    if isinstance(data, dict):
        for key in ("sites", "items", "list", "sources"):
            value = data.get(key)
            if isinstance(value, list):
                data = value
                break
        else:
            mapped: list[dict[str, str]] = []
            for key, value in data.items():
                if isinstance(value, dict):
                    entry = {str(k): str(v) for k, v in value.items() if v is not None}
                    entry.setdefault("name", str(key))
                    mapped.append(entry)
                elif isinstance(value, str):
                    mapped.append({"name": str(key), "url": value})
            data = mapped

    if isinstance(data, str):
        data = [chunk.strip() for chunk in re.split(r"[,\n;，；]", data) if chunk.strip()]

    if not isinstance(data, list):
        return []

    entries: list[dict[str, str]] = []
    for item in data:
        if isinstance(item, str):
            text = item.strip()
            if text:
                entries.append({"url": text, "name": text})
        elif isinstance(item, dict):
            entries.append({str(k): str(v) for k, v in item.items() if v is not None})
    return entries


def _entry_kwargs(entry: dict[str, str], fallback_id: str = "") -> dict[str, str]:
    """把站点条目归一化成 _build_source 的关键字参数."""

    def pick(*keys: str) -> str:
        for key in keys:
            value = entry.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return ""

    url = pick("url", "homepage", "address", "value", "paramValue", "param_value", "href")
    name = pick("name", "label", "title", "paramLabel", "param_label", "paramName", "param_name")
    identifier = pick("id", "code", "key", "paramCode", "param_code", "source") or fallback_id
    if not name:
        name = url
    if not identifier:
        identifier = _slugify(name)
    return {
        "source_id": identifier,
        "name": name,
        "url": url,
        "description": pick("description", "desc", "remark", "paramName", "param_name"),
        "repository": pick("repository", "repo"),
        "skills_path": pick("skills_path", "skillsPath", "path"),
        "authority": pick("authority", "level"),
    }


async def load_configured_sources(db: AsyncSession) -> list[RepoSource]:
    """读取「参数配置」中编码为 skill_download_site 的参数作为技能下载站点.

    支持两种配置形态：

    1. 父级分组参数 ``skill_download_site``，其每个子参数代表一个站点
       （参数编码 = 来源 id、参数标签 = 站点名称、参数值 = 仓库地址）；
    2. 单个参数 ``skill_download_site``，参数值为 JSON 数组或 ``{名称: 地址}`` 映射。

    Args:
        db: 数据库会话。

    Returns:
        参数中配置的仓库来源；未配置或无法解析时返回空列表。
    """
    result = await db.execute(
        select(SystemParam).where(SystemParam.param_code == SKILL_DOWNLOAD_SITE_PARAM)
    )
    row = result.scalar_one_or_none()
    if row is None:
        return []

    entries: list[dict[str, str]] = []
    if row.parent_code is None:
        child_result = await db.execute(
            select(SystemParam)
            .where(SystemParam.parent_code == row.param_code)
            .order_by(SystemParam.sort_order, SystemParam.created_at)
        )
        for child in child_result.scalars().all():
            entries.append(
                _entry_kwargs(
                    {
                        "id": child.param_code,
                        "name": child.param_label or child.param_name,
                        "url": child.param_value or "",
                        "description": child.description or child.param_name,
                    },
                    fallback_id=child.param_code,
                )
            )
    if not entries:
        entries = [_entry_kwargs(entry) for entry in _entries_from_json(row.param_value or "")]

    sources: list[RepoSource] = []
    seen: set[str] = set()
    for entry in entries:
        source = _build_source(**entry)
        if source is None or source.id in seen:
            continue
        seen.add(source.id)
        sources.append(source)
    return sources


async def effective_sources(db: AsyncSession) -> list[RepoSource]:
    """返回生效的技能仓库来源：参数配置优先，未配置时回退内置来源."""
    configured: list[RepoSource] = []
    try:
        configured = await load_configured_sources(db)
    except Exception:  # noqa: BLE001 - 参数读取异常不应导致来源列表不可用
        logger.exception("读取技能下载站点参数失败，回退内置来源")
    return configured or list(REPO_SOURCES)


def _headers() -> dict[str, str]:
    """GitHub API 请求头（支持通过环境变量注入 token 提升配额）."""
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "WorkMate-SkillRepository",
    }
    token = os.environ.get("SKILL_REPO_GITHUB_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _create_client() -> httpx.AsyncClient:
    """创建 HTTP 客户端（跟随 GitHub 的 tarball 重定向）."""
    return httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS, follow_redirects=True)


def _raise_for_status(response: httpx.Response, url: str) -> None:
    """把 GitHub 响应错误转换为可读的 HTTP 异常."""
    if response.status_code < 400:
        return
    if response.status_code == 404:
        raise HTTPException(status_code=404, detail=f"技能仓库资源不存在：{url}")
    remaining = response.headers.get("x-ratelimit-remaining")
    if response.status_code in (403, 429) and (response.status_code == 429 or remaining == "0"):
        raise HTTPException(
            status_code=429,
            detail="GitHub 接口触发限流，请稍后重试或配置 SKILL_REPO_GITHUB_TOKEN",
        )
    raise HTTPException(
        status_code=502, detail=f"抓取技能仓库失败（HTTP {response.status_code}）"
    )


async def _github_json(client: httpx.AsyncClient, url: str) -> dict:
    """请求 GitHub JSON 接口并返回解析结果."""
    response = await client.get(url, headers=_headers())
    _raise_for_status(response, url)
    payload = response.json()
    return payload if isinstance(payload, dict) else {}


async def _download_tarball(client: httpx.AsyncClient, source: RepoSource, branch: str) -> bytes:
    """下载仓库 tarball 快照（单次请求拿到全部技能文件）."""
    url = f"{GITHUB_API}/repos/{source.repository}/tarball/{branch}"
    response = await client.get(url, headers=_headers())
    _raise_for_status(response, url)
    content = response.content
    if len(content) > MAX_TARBALL_MB * 1024 * 1024:
        raise HTTPException(
            status_code=413, detail=f"技能仓库快照超过 {MAX_TARBALL_MB}MB 上限"
        )
    return content


def _scan_tarball(data: bytes, skills_path: str) -> tuple[dict[str, str], dict[str, list[str]]]:
    """解析仓库快照，返回 技能目录名 -> SKILL.md 内容 以及 技能目录名 -> 文件列表."""
    prefix = skills_path.strip("/") + "/"
    skill_md: dict[str, str] = {}
    dir_files: dict[str, list[str]] = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive.getmembers():
            if not member.isfile():
                continue
            parts = member.name.split("/", 1)
            if len(parts) != 2:
                continue
            relative = parts[1].replace("\\", "/")
            if not relative.startswith(prefix):
                continue
            remainder = relative[len(prefix):]
            name, separator, tail = remainder.partition("/")
            if not separator or not name or not tail:
                continue
            dir_files.setdefault(name, []).append(tail)
            if tail == "SKILL.md":
                handle = archive.extractfile(member)
                if handle is not None:
                    skill_md[name] = handle.read().decode("utf-8", errors="replace")
    filtered = {name: sorted(files) for name, files in dir_files.items() if name in skill_md}
    return skill_md, filtered


def _parse_metadata(markdown: str, fallback_name: str) -> tuple[str, str, str, str]:
    """从 SKILL.md frontmatter 解析展示名、描述、许可证与分类."""
    frontmatter, _error = parse_skill_frontmatter(markdown)
    parsed = frontmatter or {}
    display_name = str(parsed.get("name") or fallback_name).strip() or fallback_name
    description = str(parsed.get("description") or "").strip()
    license_name = str(parsed.get("license") or "").strip()
    category = str(parsed.get("category") or "").strip().lower()
    if category not in KNOWN_CATEGORIES:
        category = "custom"
    return display_name, description[:1024], license_name[:128], category


async def _load_source(client: httpx.AsyncClient, source: RepoSource) -> _SourceSnapshot:
    """抓取单个来源：仓库元信息 + 快照解析."""
    if not source.repository:
        raise HTTPException(
            status_code=400,
            detail=f"技能下载站点「{source.name}」未配置有效的仓库地址（形如 owner/repo）",
        )
    repository = await _github_json(client, f"{GITHUB_API}/repos/{source.repository}")
    stars = int(repository.get("stargazers_count") or 0)
    branch = str(repository.get("default_branch") or "main")
    pushed_at = str(repository.get("pushed_at") or "")
    data = await _download_tarball(client, source, branch)
    skill_md, dir_files = _scan_tarball(data, source.skills_path)

    items: list[SkillRepoSkillItem] = []
    for name in sorted(skill_md):
        display_name, description, license_name, category = _parse_metadata(
            skill_md[name], name
        )
        items.append(
            SkillRepoSkillItem(
                id=f"{source.id}:{name}",
                name=display_name,
                dir_name=name,
                description=description,
                category=category,
                license=license_name,
                source=source.id,
                source_name=source.name,
                repository=source.repository,
                popularity=stars,
                rank=0,
                install_url=(
                    f"{source.homepage}/tree/{branch}/{source.skills_path}/{name}"
                ),
                updated_at=pushed_at,
            )
        )

    return _SourceSnapshot(
        fetched_at=time.time(),
        stars=stars,
        default_branch=branch,
        tarball=data,
        items=items,
        dir_files=dir_files,
    )


async def _ensure_ranked(sources: list[RepoSource], force: bool = False) -> None:
    """确保榜单快照可用（带 TTL 缓存与并发保护）."""
    global _ranked_items, _ranked_at, _ranked_key
    key = tuple((source.id, source.repository, source.skills_path) for source in sources)
    if (
        not force
        and _ranked_items
        and key == _ranked_key
        and (time.time() - _ranked_at) < CACHE_TTL_SECONDS
    ):
        return

    async with _load_lock:
        if (
            not force
            and _ranked_items
            and key == _ranked_key
            and (time.time() - _ranked_at) < CACHE_TTL_SECONDS
        ):
            return
        authority_order = {
            source.id: (0 if source.authority == "official" else 1)
            for source in sources
        }
        async with _create_client() as client:
            gathered = await asyncio.gather(
                *[_load_source(client, source) for source in sources],
                return_exceptions=True,
            )

        pairs: list[tuple[RepoSource, _SourceSnapshot]] = []
        first_error: BaseException | None = None
        for source, result in zip(sources, gathered):
            if isinstance(result, BaseException):
                logger.warning("技能仓库来源 %s 抓取失败，已跳过：%s", source.id, result)
                first_error = first_error or result
                continue
            pairs.append((source, result))
        if not pairs and first_error is not None:
            raise first_error

        keep_tarball = sum(len(snapshot.tarball) for _source, snapshot in pairs) <= (
            MAX_CACHE_MB * 1024 * 1024
        )
        for source, snapshot in pairs:
            if not keep_tarball:
                snapshot.tarball = b""
            _snapshots[source.id] = snapshot

        items = [item for _source, snapshot in pairs for item in snapshot.items]
        items.sort(
            key=lambda item: (
                authority_order.get(item.source, 9),
                -item.popularity,
                item.name.lower(),
            )
        )
        for index, item in enumerate(items, start=1):
            item.rank = index
        _ranked_items = items
        _ranked_at = time.time()
        _ranked_key = key
        logger.info("技能仓库榜单已刷新：%d 个技能", len(items))


async def list_repository_skills(
    sources: list[RepoSource],
    source_id: str,
    keyword: str | None = None,
    page: int = 1,
    page_size: int = 20,
    refresh: bool = False,
) -> SkillRepoListResponse:
    """按来源返回技能仓库榜单（支持关键词过滤与分页）."""
    source = next((item for item in sources if item.id == source_id), None)
    if source is None:
        raise HTTPException(status_code=404, detail=f"未知技能仓库来源：{source_id}")

    await _ensure_ranked(sources, force=refresh)

    items = [item for item in _ranked_items if item.source == source_id]
    query = (keyword or "").strip().lower()
    if query:
        items = [
            item
            for item in items
            if query in item.name.lower()
            or query in item.description.lower()
            or query in item.dir_name.lower()
        ]

    total = len(items)
    page = max(1, page)
    page_size = max(1, min(page_size, 100))
    start = (page - 1) * page_size
    return SkillRepoListResponse(
        source=source.id,
        source_name=source.name,
        rank_basis=RANK_BASIS,
        fetched_at=datetime.fromtimestamp(_ranked_at or time.time(), tz=UTC),
        total=total,
        page=page,
        page_size=page_size,
        items=items[start:start + page_size],
    )


def _extract_skill_files(data: bytes, skills_path: str, dir_name: str, target_dir: str) -> int:
    """把仓库快照中指定技能目录的文件解压到目标目录，返回总字节数."""
    prefix = f"{skills_path.strip('/')}/{dir_name}/"
    total_bytes = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive.getmembers():
            if not member.isfile():
                continue
            parts = member.name.split("/", 1)
            if len(parts) != 2:
                continue
            relative = parts[1].replace("\\", "/")
            if not relative.startswith(prefix):
                continue
            sub_path = relative[len(prefix):]
            if not sub_path:
                continue
            safe_path = posixpath.normpath(sub_path)
            if safe_path.startswith("../") or safe_path.startswith("/") or safe_path == "..":
                raise HTTPException(status_code=400, detail="技能包存在路径穿越风险")
            handle = archive.extractfile(member)
            content = handle.read() if handle is not None else b""
            total_bytes += len(content)
            if total_bytes > MAX_UPLOAD_SIZE_MB * 1024 * 1024:
                raise HTTPException(
                    status_code=413, detail=f"技能包超过 {MAX_UPLOAD_SIZE_MB}MB 上限"
                )
            destination = os.path.join(target_dir, *safe_path.split("/"))
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            with open(destination, "wb") as file_object:
                file_object.write(content)
    return total_bytes


def _read_metadata_from_dir(skill_dir: str, dir_name: str) -> tuple[str, str, str]:
    """读取已落盘技能包的描述、许可证与分类."""
    skill_md = os.path.join(skill_dir, "SKILL.md")
    markdown = ""
    if os.path.isfile(skill_md):
        with open(skill_md, encoding="utf-8") as file_object:
            markdown = file_object.read()
    _display, description, license_name, category = _parse_metadata(markdown, dir_name)
    return description, license_name, category


async def import_repository_skills(
    request: SkillRepoImportRequest, db: AsyncSession
) -> SkillRepoImportResponse:
    """把榜单中选中的技能导入 workspace/skills_upload/ 并入库."""
    sources = await effective_sources(db)
    source = next((item for item in sources if item.id == request.source), None)
    if source is None:
        raise HTTPException(status_code=404, detail=f"未知技能仓库来源：{request.source}")
    if not request.skill_ids:
        raise HTTPException(status_code=400, detail="请至少选择一个技能")

    await _ensure_ranked(sources)
    snapshot = _snapshots.get(source.id)
    if snapshot is None:
        raise HTTPException(status_code=502, detail="技能仓库快照不可用，请重试")

    data = snapshot.tarball
    if not data:
        async with _create_client() as client:
            data = await _download_tarball(client, source, snapshot.default_branch)

    os.makedirs(SKILLS_DIR, exist_ok=True)

    results: list[SkillResult] = []
    skipped: list[str] = []

    for raw_id in request.skill_ids:
        dir_name = raw_id.split(":", 1)[1] if ":" in raw_id else raw_id
        dir_name = dir_name.strip()
        if not dir_name:
            continue
        if dir_name not in snapshot.dir_files:
            results.append(
                SkillResult(
                    name=dir_name,
                    valid=False,
                    errors=[
                        SkillValidationError(
                            field="skill", message="该技能不在当前榜单快照中，请刷新后重试"
                        )
                    ],
                )
            )
            continue

        destination = os.path.join(SKILLS_DIR, dir_name)
        if os.path.exists(destination):
            skipped.append(dir_name)
            continue

        with tempfile.TemporaryDirectory(prefix="skill-repo-") as temp_dir:
            skill_dir = os.path.join(temp_dir, dir_name)
            os.makedirs(skill_dir, exist_ok=True)
            try:
                _extract_skill_files(data, source.skills_path, dir_name, skill_dir)
            except HTTPException as error:
                results.append(
                    SkillResult(
                        name=dir_name,
                        valid=False,
                        errors=[SkillValidationError(field="download", message=str(error.detail))],
                    )
                )
                continue

            validation = validate_skill_directory(skill_dir, expected_name=dir_name)
            if not validation.valid:
                # 校验不通过：不落盘、不入库
                results.append(validation)
                continue

            description, license_name, category = _read_metadata_from_dir(skill_dir, dir_name)
            shutil.copytree(skill_dir, destination)
            db.add(
                Skill(
                    name=dir_name,
                    valid=True,
                    source=source.id,
                    description=description,
                    license=license_name,
                    category=category,
                    icon="",
                    prompt="",
                    is_builtin=False,
                    validation_errors="",
                )
            )
            results.append(SkillResult(name=dir_name, valid=True, errors=[]))

    # 显式提交，确保导入接口返回后列表 / 同步立即可见（避免请求级提交时序竞态）
    await db.commit()

    valid_count = sum(1 for item in results if item.valid)
    invalid_count = len(results) - valid_count
    return SkillRepoImportResponse(
        total=len(results) + len(skipped),
        valid_count=valid_count,
        invalid_count=invalid_count,
        skipped_count=len(skipped),
        results=results,
        skipped=skipped,
    )