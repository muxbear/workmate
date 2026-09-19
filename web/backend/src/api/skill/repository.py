"""技能仓库抓取与导入.

从可公开抓取的权威技能仓库（GitHub）按热度拉取技能榜单，并把选中的技能包下载、
校验、落盘到 workspace/skills_upload/ 后入库。

实现要点：
- 榜单来源为「GitHub 仓库注册表」，默认包含 Anthropic 官方技能仓库与高星社区技能库；
- 抓取使用 GitHub REST API：仓库元信息提供星标数（热度），tarball 接口一次性拉取仓库
  快照后在本地解析，避免逐文件请求与二次限流；
- 榜单排序依据为「权威级别（官方优先）→ 仓库星标数 → 技能名」，排名与热度随响应返回；
- 抓取结果按 TTL 缓存，刷新失败时沿用最近一次成功快照；
- 导入严格复用上传校验规则：校验不通过不落盘、不入库。
"""
from __future__ import annotations

import asyncio
import io
import logging
import os
import posixpath
import shutil
import tarfile
import tempfile
import time
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx
from fastapi import HTTPException
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

_SOURCE_MAP = {source.id: source for source in REPO_SOURCES}


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
_load_lock = asyncio.Lock()


def list_sources() -> list[SkillRepoSourceItem]:
    """返回可用的技能仓库来源列表."""
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
        for source in REPO_SOURCES
    ]


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


async def _ensure_ranked(force: bool = False) -> None:
    """确保榜单快照可用（带 TTL 缓存与并发保护）."""
    global _ranked_items, _ranked_at
    if not force and _ranked_items and (time.time() - _ranked_at) < CACHE_TTL_SECONDS:
        return

    async with _load_lock:
        if not force and _ranked_items and (time.time() - _ranked_at) < CACHE_TTL_SECONDS:
            return
        authority_order = {
            source.id: (0 if source.authority == "official" else 1)
            for source in REPO_SOURCES
        }
        async with _create_client() as client:
            snapshots = await asyncio.gather(
                *[_load_source(client, source) for source in REPO_SOURCES]
            )

        keep_tarball = sum(len(snapshot.tarball) for snapshot in snapshots) <= (
            MAX_CACHE_MB * 1024 * 1024
        )
        for source, snapshot in zip(REPO_SOURCES, snapshots):
            if not keep_tarball:
                snapshot.tarball = b""
            _snapshots[source.id] = snapshot

        items = [item for snapshot in snapshots for item in snapshot.items]
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
        logger.info("技能仓库榜单已刷新：%d 个技能", len(items))


async def list_repository_skills(
    source_id: str,
    keyword: str | None = None,
    page: int = 1,
    page_size: int = 20,
    refresh: bool = False,
) -> SkillRepoListResponse:
    """按来源返回技能仓库榜单（支持关键词过滤与分页）."""
    source = _SOURCE_MAP.get(source_id)
    if source is None:
        raise HTTPException(status_code=404, detail=f"未知技能仓库来源：{source_id}")

    await _ensure_ranked(force=refresh)

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
    source = _SOURCE_MAP.get(request.source)
    if source is None:
        raise HTTPException(status_code=404, detail=f"未知技能仓库来源：{request.source}")
    if not request.skill_ids:
        raise HTTPException(status_code=400, detail="请至少选择一个技能")

    await _ensure_ranked()
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