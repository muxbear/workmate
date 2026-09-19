"""技能下载站点来源（参数配置 skill_download_site）单元测试."""

import asyncio
import io
import json
import pathlib
import tarfile

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from api.skill import repository
from db.base import Base
from db.models.system_param import SystemParam


async def _effective_sources(rows: list[SystemParam]) -> list[repository.RepoSource]:
    """写入内存 SQLite 参数后读取生效的技能仓库来源."""
    engine = create_async_engine("sqlite+aiosqlite://")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as session:
        session.add_all(rows)
        await session.commit()
        sources = await repository.effective_sources(session)
    await engine.dispose()
    return sources


def _site_param(
    code: str,
    label: str,
    value: str,
    *,
    order: int,
    parent: str | None = None,
    description: str = "",
) -> SystemParam:
    """构造一个站点参数行."""
    return SystemParam(
        param_code=code,
        parent_code=parent,
        param_label=label,
        param_name=label,
        param_value=value,
        param_type="string",
        description=description,
        sort_order=order,
    )


def _group_param(value: str = "", param_type: str = "group") -> SystemParam:
    """构造 skill_download_site 参数行."""
    return SystemParam(
        param_code="skill_download_site",
        parent_code=None,
        param_label="技能下载站点",
        param_name="技能下载站点",
        param_value=value or None,
        param_type=param_type,
        sort_order=1,
    )


def test_parse_repository_url_variants() -> None:
    """仓库地址支持多种写法，并能把子目录解析为技能目录."""
    assert repository.parse_repository_url("https://github.com/anthropics/skills") == (
        "anthropics/skills",
        "skills",
    )
    assert repository.parse_repository_url("https://github.com/obra/superpowers.git") == (
        "obra/superpowers",
        "skills",
    )
    assert repository.parse_repository_url("git@github.com:anthropics/skills.git") == (
        "anthropics/skills",
        "skills",
    )
    assert repository.parse_repository_url("anthropics/skills") == (
        "anthropics/skills",
        "skills",
    )
    assert repository.parse_repository_url(
        "https://github.com/anthropics/skills/tree/main/agent-skills"
    ) == ("anthropics/skills", "agent-skills")
    assert repository.parse_repository_url("https://skills.example.com/api/skills") == (
        "",
        "skills",
    )
    assert repository.parse_repository_url("") == ("", "skills")


def test_configured_sources_read_from_param_children() -> None:
    """参数配置 skill_download_site 的子参数即技能下载站点."""
    rows = [
        _group_param(),
        _site_param(
            "internal-hub",
            "内部技能站点",
            "https://github.com/corp/skills",
            order=1,
            parent="skill_download_site",
            description="公司内部技能仓库",
        ),
        _site_param(
            "anthropic-official",
            "Anthropic 官方技能仓库",
            "https://github.com/anthropics/skills/tree/main/skills",
            order=2,
            parent="skill_download_site",
        ),
    ]

    sources = asyncio.run(_effective_sources(rows))

    assert [item.id for item in sources] == ["internal-hub", "anthropic-official"]
    assert sources[0].name == "内部技能站点"
    assert sources[0].repository == "corp/skills"
    assert sources[0].homepage == "https://github.com/corp/skills"
    assert sources[0].description == "公司内部技能仓库"
    assert sources[1].repository == "anthropics/skills"
    assert sources[1].skills_path == "skills"


def test_configured_sources_read_from_json_param_value() -> None:
    """参数值为 JSON 时同样可以配置下载站点（数组与映射两种写法）."""
    value = json.dumps(
        [
            {
                "id": "anthropic-official",
                "name": "Anthropic 官方技能仓库",
                "url": "https://github.com/anthropics/skills",
            },
            {"name": "内部技能站点", "url": "https://github.com/corp/skills"},
        ]
    )

    sources = asyncio.run(_effective_sources([_group_param(value, param_type="json")]))

    assert [item.id for item in sources] == ["anthropic-official", "内部技能站点"]
    assert sources[0].repository == "anthropics/skills"
    assert sources[1].repository == "corp/skills"

    mapped = asyncio.run(
        _effective_sources(
            [_group_param(json.dumps({"Anthropic 官方技能仓库": "anthropics/skills"}), param_type="json")]
        )
    )

    assert [item.name for item in mapped] == ["Anthropic 官方技能仓库"]
    assert mapped[0].repository == "anthropics/skills"


def test_configured_sources_skip_invalid_entries() -> None:
    """缺少仓库地址的条目会被忽略；缺少编码时用名称兜底生成来源 id."""
    rows = [
        _group_param(),
        _site_param("", "没有编码的站点", "https://github.com/corp/skills", order=1, parent="skill_download_site"),
        _site_param("empty-site", "没有地址的站点", "", order=2, parent="skill_download_site"),
    ]

    sources = asyncio.run(_effective_sources(rows))

    assert [item.id for item in sources] == ["没有编码的站点"]
    assert sources[0].repository == "corp/skills"


def test_effective_sources_falls_back_to_builtin() -> None:
    """未配置该参数时回退内置来源，保持原有行为."""
    sources = asyncio.run(_effective_sources([]))

    assert [item.id for item in sources] == [item.id for item in repository.REPO_SOURCES]
    assert [item.id for item in repository.list_sources()] == [
        item.id for item in repository.REPO_SOURCES
    ]


def _tar_bytes(entries: dict[str, bytes]) -> bytes:
    """构造一个 gz 压缩的仓库快照（tar.gz）."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, content in entries.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
    return buffer.getvalue()


def test_scan_tarball_supports_nested_skill_dirs() -> None:
    """技能目录支持多级嵌套；技能目录内部的嵌套 SKILL.md 不再算独立技能."""
    data = _tar_bytes(
        {
            "repo-main/skills/alpha/SKILL.md": b"---\nname: alpha\n---\n",
            "repo-main/skills/alpha/references/inner/SKILL.md": b"---\nname: inner\n---\n",
            "repo-main/skills/engineering/beta/SKILL.md": b"---\nname: beta\n---\n",
            "repo-main/skills/engineering/beta/scripts/run.py": b"print(1)\n",
            "repo-main/README.md": b"readme\n",
        }
    )

    skill_md, dir_files = repository._scan_tarball(data, "skills")

    assert sorted(skill_md) == ["alpha", "engineering/beta"]
    assert dir_files["alpha"] == ["SKILL.md", "references/inner/SKILL.md"]
    assert dir_files["engineering/beta"] == ["SKILL.md", "scripts/run.py"]


def test_scan_tarball_supports_skills_at_repo_root() -> None:
    """技能根目录为仓库根目录（参数值以 /tree/main/. 结尾）时也能识别技能."""
    data = _tar_bytes(
        {
            "repo-main/academic-paper/SKILL.md": b"---\nname: academic-paper\n---\n",
            "repo-main/academic-paper/references/a.md": b"a\n",
        }
    )

    skill_md, dir_files = repository._scan_tarball(data, ".")

    assert list(skill_md) == ["academic-paper"]
    assert dir_files["academic-paper"] == ["SKILL.md", "references/a.md"]


def test_parse_repository_url_supports_repo_root_path() -> None:
    """带 /tree/main/. 的地址表示技能目录就是仓库根目录."""
    assert repository.parse_repository_url(
        "https://github.com/Imbad0202/academic-research-skills/tree/main/."
    ) == ("Imbad0202/academic-research-skills", "")


def test_extract_skill_files_supports_nested_skill_dir(tmp_path: pathlib.Path) -> None:
    """嵌套技能目录按相对路径解压，且不会带入同级的其他技能."""
    data = _tar_bytes(
        {
            "repo-main/skills/engineering/beta/SKILL.md": b"---\nname: beta\n---\n",
            "repo-main/skills/engineering/beta/scripts/run.py": b"print(1)\n",
            "repo-main/skills/engineering/other/SKILL.md": b"---\nname: other\n---\n",
        }
    )

    total = repository._extract_skill_files(
        data, "skills", "engineering/beta", str(tmp_path)
    )

    assert total > 0
    assert (tmp_path / "SKILL.md").is_file()
    assert (tmp_path / "scripts" / "run.py").is_file()
    assert not (tmp_path / "other").exists()


def test_extract_skill_files_supports_repo_root(tmp_path: pathlib.Path) -> None:
    """技能目录为仓库根目录时，解压前缀不应带多余斜杠."""
    data = _tar_bytes(
        {
            "repo-main/academic-paper/SKILL.md": b"---\nname: academic-paper\n---\n",
        }
    )

    total = repository._extract_skill_files(data, ".", "academic-paper", str(tmp_path))

    assert total > 0
    assert (tmp_path / "SKILL.md").is_file()
