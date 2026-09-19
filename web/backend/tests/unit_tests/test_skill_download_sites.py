"""技能下载站点来源（参数配置 skill_download_site）单元测试."""

import asyncio
import json

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
