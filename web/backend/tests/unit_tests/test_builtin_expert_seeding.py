"""内置专家入库路径（此前无用例覆盖）与「云知识库检索专家」的声明。

``seed_builtin_experts`` 每次启动都会跑，但一直没有测试真正落库验证过：
专家行、``expert_tools`` 关联、``expert_mcp_configs`` 关联都只在代码里读过。
这条链路是"专家能不能用上 MCP 服务"的唯一通路——``ExpertMcpConfig`` 缺了，
专家在界面上看着有 MCP 配置、实际调用不到任何知识库工具。

顺带钉住「云知识库检索专家」的跨端契约：只声明能力、不写死端侧工具名，
提示词用平台化占位符，三端渲染后都不留残余占位符。
"""

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from agent.experts.capabilities import (
    ALL_CAPABILITIES,
    CAPABILITY_KNOWLEDGE_SEARCH,
    CAPABILITY_WEB_SEARCH,
    capabilities_for_mcp_services,
)
from agent.experts.platforms import PLATFORMS
from api.experts.prompt_render import render_expert_prompt
from api.experts.service import (
    BUILTIN_EXPERTS,
    _declared_tool_names,
    builtin_prompt_template,
    is_newer_version,
    seed_builtin_experts,
)
from api.mcp.service import seed_builtin_mcp_tools
from db.models.agent import Agent
from db.models.ai_model import AIModel
from db.models.expert import Expert
from db.models.expert_mcp_config import ExpertMcpConfig
from db.models.expert_skill import ExpertSkill
from db.models.expert_tool import ExpertTool
from db.models.expert_version import ExpertVersion
from db.models.mcp_tool import McpTool
from db.models.skill import Skill
from db.models.tool import Tool

pytestmark = pytest.mark.anyio

KB_EXPERT = "云知识库检索专家"
KB_MCP_SERVICE = "云知识库检索"
SEARCH_EXPERT = "互联网信息检索专家"
SEARCH_MCP_SERVICE = "联网搜索"


def _kb_expert() -> dict:
    return next(item for item in BUILTIN_EXPERTS if item["name"] == KB_EXPERT)


def _search_expert() -> dict:
    return next(item for item in BUILTIN_EXPERTS if item["name"] == SEARCH_EXPERT)


@pytest.fixture
async def sessionmaker():
    """内存 SQLite：建出种子链路用到的全部表。"""
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        for model in (
            Agent, AIModel, Expert, ExpertMcpConfig, ExpertSkill, ExpertTool,
            ExpertVersion, McpTool, Skill, Tool,
        ):
            await conn.run_sync(model.__table__.create)

    maker = async_sessionmaker(engine, expire_on_commit=False)
    yield maker
    await engine.dispose()


async def _seed_all(maker) -> None:
    """按生产顺序落种子：先 MCP 服务，再专家（专家要按名字找 MCP 行）。"""
    async with maker() as db:
        db.add(Tool(
            id="tool-download-asset", name="download_asset", display_name="素材保存",
            description="", category="file", source="builtin", status="enabled",
            version="1.0.0", author="", tags=[], params=[],
        ))
        await db.commit()
    async with maker() as db:
        await seed_builtin_mcp_tools(db)
        await db.commit()
    async with maker() as db:
        await seed_builtin_experts(db)
        await db.commit()


# ─── 声明层：能力 / 工具 / 模板 ─────────────────────────────────────────────


def test_kb_expert_declares_knowledge_search_capability():
    """只声明能力，不写死端侧工具名——这是三端可用的前提。"""
    item = _kb_expert()
    assert item["capabilities"] == [CAPABILITY_KNOWLEDGE_SEARCH]
    assert "tool_names" not in item
    assert CAPABILITY_KNOWLEDGE_SEARCH in ALL_CAPABILITIES


def test_knowledge_search_capability_expands_to_native_tools():
    """能力展开为**服务端内置**工具，而不是 MCP 工具名。

    专家子代理的工具在构图时一次性构建、跨用户共用，MCP 工具跑在独立的 MCP
    会话任务里拿不到 LangGraph 运行时上下文，也就无从得知调用方身份（实测稳定
    返回"缺少身份信息"）。内置工具在调用时取运行时 user_id，是进程内唯一能带上
    身份的路径。
    """
    from agent.experts.capabilities import (
        capability_builtin_tools,
        capability_mcp_tools,
    )

    assert _declared_tool_names(_kb_expert()) == ["kb_search", "list_knowledge_bases"]
    assert capability_builtin_tools([CAPABILITY_KNOWLEDGE_SEARCH]) == [
        "kb_search", "list_knowledge_bases",
    ]
    # MCP 工具名仍登记着：外部客户端（桌面端）正是通过 MCP 服务访问知识库
    assert "kb_search" in capability_mcp_tools([CAPABILITY_KNOWLEDGE_SEARCH])
    assert capabilities_for_mcp_services([KB_MCP_SERVICE]) == [CAPABILITY_KNOWLEDGE_SEARCH]


def test_native_kb_tools_satisfy_the_capability_so_mcp_is_skipped():
    """有内置工具时该能力算"已满足"——这是 MCP 侧跳过加载的判据。

    ``_resolve_entity_tools`` 用 ``capabilities_for_tools(内置工具名)`` 算出
    skip 集合，``_append_mcp_tools`` 再据此跳过对应 MCP 服务；两边口径必须一致，
    这里把这条链路的判据钉住。
    """
    from agent.experts.capabilities import (
        MCP_SERVICE_CAPABILITIES,
        capabilities_for_tools,
    )

    satisfied = set(capabilities_for_tools(["kb_search", "list_knowledge_bases"]))
    assert CAPABILITY_KNOWLEDGE_SEARCH in satisfied
    assert MCP_SERVICE_CAPABILITIES[KB_MCP_SERVICE] in satisfied

    # 反面对照：只有素材工具时不该误判成已满足
    other = set(capabilities_for_tools(["download_asset"]))
    assert MCP_SERVICE_CAPABILITIES[KB_MCP_SERVICE] not in other


def test_kb_expert_binds_the_cloud_kb_mcp_service():
    """专家组绑的是「云知识库检索」MCP 服务，服务名必须与种子卡片一字不差。"""
    assert _kb_expert()["mcp_tool_name"] == KB_MCP_SERVICE
    assert capabilities_for_mcp_services([KB_MCP_SERVICE]) == [CAPABILITY_KNOWLEDGE_SEARCH]


def test_kb_expert_prompt_renders_without_leftover_placeholders():
    """提示词是平台无关模板，三端渲染后都不该残留占位符。"""
    for platform in PLATFORMS:
        rendered = render_expert_prompt(
            _kb_expert()["system_prompt"], platform=platform
        )
        assert rendered, platform
        assert "{{" not in rendered, platform
        # 平台说明确实注入了，而不是留空
        assert len(rendered) > len(_kb_expert()["system_prompt"]) - 100, platform


def test_kb_expert_prompt_drives_autonomous_selection():
    """提示词必须给出"选哪个库 / 用哪种检索"的判据，否则专家只会盲查。

    这是专家能力的实际载体：模型看不到实现，只能照着提示词做决策。
    """
    prompt = _kb_expert()["system_prompt"]
    # 选库
    assert "list_knowledge_bases" in prompt
    assert "kb_ids" in prompt
    # 三种模式的适用面都要讲清楚，不能只留一个默认值
    for mode in ("bm25", "vector", "hybrid"):
        assert mode in prompt, mode
    # 多轮与空结果的处置
    assert "use_rewrite" in prompt
    assert "no_relevant_result" in prompt
    # 不许编造
    assert "不" in prompt and "编造" in prompt


def test_kb_expert_delegation_template_requires_citations():
    """委派模板要求主智能体保留引用标注——去掉引用等于回答不可核对。"""
    template = builtin_prompt_template(KB_EXPERT)
    assert template
    assert "{name}" in template and "{title}" in template
    assert "原样保留" in template
    assert "引用" in template


# ─── 声明层：互联网信息检索专家 ─────────────────────────────────────────────


def test_search_expert_declares_capability_without_native_tools():
    """只声明能力、不关联内置工具——这是三端统一走 MCP 服务的前提。

    绑定内置 tavily_search 会让 ``_resolve_entity_tools`` 据此跳过「联网搜索」
    MCP 服务，把自带多源回退的实现顶掉（详见 capabilities.py 的注释）。
    """
    item = _search_expert()
    assert item["capabilities"] == [CAPABILITY_WEB_SEARCH]
    assert "tool_names" not in item
    assert _declared_tool_names(item) == []
    assert capabilities_for_mcp_services([SEARCH_MCP_SERVICE]) == [CAPABILITY_WEB_SEARCH]


def test_search_expert_binds_the_web_search_mcp_service():
    """专家组绑的是「联网搜索」MCP 服务，服务名必须与种子卡片一字不差。"""
    assert _search_expert()["mcp_tool_name"] == SEARCH_MCP_SERVICE


def test_search_expert_prompt_renders_without_leftover_placeholders():
    """提示词是平台无关模板，三端渲染后都不该残留占位符。"""
    for platform in PLATFORMS:
        rendered = render_expert_prompt(
            _search_expert()["system_prompt"], platform=platform
        )
        assert rendered, platform
        assert "{{" not in rendered, platform


def test_search_expert_declares_a_shippable_version():
    """必须声明合法版本号且不低于已下发版本——桌面端只在服务端版本更高时更新。"""
    version = str(_search_expert().get("version") or "")
    assert version
    assert is_newer_version(version, "1.0.0"), (
        "该专家此前以 1.0.0 同步到过桌面端，版本不推进则改造下发不出去"
    )


def test_is_newer_version_compares_semver():
    """版本比较：非法/缺失按 0.0.0 处理，非法候选不得覆盖已有版本。"""
    assert is_newer_version("1.1.0", "1.0.0") is True
    assert is_newer_version("2.0.0", "1.9.9") is True
    assert is_newer_version("1.0.0", "1.0.0") is False
    assert is_newer_version("1.0.0", "1.1.0") is False
    assert is_newer_version("1.0.0", None) is True
    assert is_newer_version("", "1.0.0") is False
    assert is_newer_version("abc", "1.0.0") is False


# ─── 入库层：种子真能把专家与 MCP 关联写进去 ────────────────────────────────


async def test_seed_creates_kb_expert_with_its_mcp_service(sessionmaker):
    """专家落库，且 ExpertMcpConfig 指向「云知识库检索」并处于启用状态。"""
    await _seed_all(sessionmaker)

    async with sessionmaker() as db:
        expert = (
            await db.execute(select(Expert).where(Expert.name == KB_EXPERT))
        ).scalar_one()
        assert expert.category == "ai_tools"
        assert expert.status == "active"
        assert expert.is_published is True, "未发布的专家不会同步到桌面端"
        assert expert.system_prompt.strip()

        config = (
            await db.execute(
                select(ExpertMcpConfig).where(ExpertMcpConfig.expert_id == expert.id)
            )
        ).scalar_one()
        assert config.enabled is True

        mcp_tool = (
            await db.execute(
                select(McpTool).where(McpTool.id == config.mcp_tool_id)
            )
        ).scalar_one()
        assert mcp_tool.name == KB_MCP_SERVICE
        # 地址由配置基址推导，专家组里存的是 streamable_http 地址
        assert config.config["transport"] == "streamable_http"
        assert str(config.config["url"]).endswith("/mcp/kb-http/mcp")


async def test_seed_is_idempotent_for_the_kb_expert(sessionmaker):
    """重复启动不产生重复专家、重复关联（seed 每次启动都跑）。"""
    await _seed_all(sessionmaker)
    async with sessionmaker() as db:
        await seed_builtin_experts(db)
        await db.commit()

    async with sessionmaker() as db:
        experts = (
            await db.execute(
                select(func.count()).select_from(Expert).where(Expert.name == KB_EXPERT)
            )
        ).scalar()
        expert_id = (
            await db.execute(select(Expert.id).where(Expert.name == KB_EXPERT))
        ).scalar_one()
        configs = (
            await db.execute(
                select(func.count())
                .select_from(ExpertMcpConfig)
                .where(ExpertMcpConfig.expert_id == expert_id)
            )
        ).scalar()

    assert experts == 1
    assert configs == 1


async def test_reseed_repairs_a_removed_mcp_link(sessionmaker):
    """关联被删掉后重启能自愈——否则专家会静默失去全部知识库工具。

    此前 MCP 关联只在创建分支里写一次，用户在界面上删掉关联后重启不会补回来：
    专家还在、看着正常，实际一个检索工具都调不到。
    """
    await _seed_all(sessionmaker)
    async with sessionmaker() as db:
        expert_id = (
            await db.execute(select(Expert.id).where(Expert.name == KB_EXPERT))
        ).scalar_one()
        config = (
            await db.execute(
                select(ExpertMcpConfig).where(ExpertMcpConfig.expert_id == expert_id)
            )
        ).scalar_one()
        await db.delete(config)
        await db.commit()

    async with sessionmaker() as db:
        await seed_builtin_experts(db)
        await db.commit()

    async with sessionmaker() as db:
        restored = (
            await db.execute(
                select(ExpertMcpConfig).where(ExpertMcpConfig.expert_id == expert_id)
            )
        ).scalar_one()
        mcp_tool = (
            await db.execute(select(McpTool).where(McpTool.id == restored.mcp_tool_id))
        ).scalar_one()

    assert mcp_tool.name == KB_MCP_SERVICE
    assert restored.enabled is True


async def test_reseed_reenables_a_disabled_mcp_link(sessionmaker):
    """被停用的关联重启后重新启用，但用户自定义的连接参数不被覆盖。"""
    await _seed_all(sessionmaker)
    async with sessionmaker() as db:
        expert_id = (
            await db.execute(select(Expert.id).where(Expert.name == KB_EXPERT))
        ).scalar_one()
        config = (
            await db.execute(
                select(ExpertMcpConfig).where(ExpertMcpConfig.expert_id == expert_id)
            )
        ).scalar_one()
        config.enabled = False
        config.config = {**config.config, "url": "https://custom.example.com/mcp/kb-http/mcp"}
        await db.commit()

    async with sessionmaker() as db:
        await seed_builtin_experts(db)
        await db.commit()

    async with sessionmaker() as db:
        after = (
            await db.execute(
                select(ExpertMcpConfig).where(ExpertMcpConfig.expert_id == expert_id)
            )
        ).scalar_one()

    assert after.enabled is True
    assert after.config["url"] == "https://custom.example.com/mcp/kb-http/mcp", (
        "自愈只补启用位，不该覆盖用户改过的地址"
    )


async def test_seed_creates_search_expert_with_its_mcp_service(sessionmaker):
    """专家落库，且 ExpertMcpConfig 指向「联网搜索」并处于启用状态。

    该专家此前只是界面上手工建的一条记录（提示词一句话、无版本、无端侧工具），
    进了内置种子后才有平台化提示词与可自愈的 MCP 关联。
    """
    await _seed_all(sessionmaker)

    async with sessionmaker() as db:
        expert = (
            await db.execute(select(Expert).where(Expert.name == SEARCH_EXPERT))
        ).scalar_one()
        assert expert.category == "ai_tools"
        assert expert.status == "active"
        assert expert.is_published is True, "未发布的专家不会同步到桌面端"
        assert "{{platform_notes}}" in expert.system_prompt
        assert expert.version == _search_expert()["version"]

        config = (
            await db.execute(
                select(ExpertMcpConfig).where(ExpertMcpConfig.expert_id == expert.id)
            )
        ).scalar_one()
        assert config.enabled is True

        mcp_tool = (
            await db.execute(
                select(McpTool).where(McpTool.id == config.mcp_tool_id)
            )
        ).scalar_one()
        assert mcp_tool.name == SEARCH_MCP_SERVICE
        # 地址由配置基址推导，专家组里存的是 streamable_http 地址
        assert config.config["transport"] == "streamable_http"
        assert str(config.config["url"]).endswith("/mcp/web-search-http/mcp")


async def test_seed_is_idempotent_for_the_search_expert(sessionmaker):
    """重复启动不产生重复专家、重复关联（seed 每次启动都跑）。"""
    await _seed_all(sessionmaker)
    async with sessionmaker() as db:
        await seed_builtin_experts(db)
        await db.commit()

    async with sessionmaker() as db:
        experts = (
            await db.execute(
                select(func.count())
                .select_from(Expert)
                .where(Expert.name == SEARCH_EXPERT)
            )
        ).scalar()
        expert_id = (
            await db.execute(select(Expert.id).where(Expert.name == SEARCH_EXPERT))
        ).scalar_one()
        configs = (
            await db.execute(
                select(func.count())
                .select_from(ExpertMcpConfig)
                .where(ExpertMcpConfig.expert_id == expert_id)
            )
        ).scalar()

    assert experts == 1
    assert configs == 1


async def test_declared_version_is_written_once_and_never_downgraded(sessionmaker):
    """声明版本按"只增不减"写库：字段仍按种子覆盖，但手工调高的版本号不被回退。"""
    await _seed_all(sessionmaker)
    async with sessionmaker() as db:
        expert_id = (
            await db.execute(select(Expert.id).where(Expert.name == SEARCH_EXPERT))
        ).scalar_one()
        expert = (
            await db.execute(select(Expert).where(Expert.id == expert_id))
        ).scalar_one()
        assert expert.version == _search_expert()["version"]
        # 模拟界面里把版本手工调高、同时改了标题
        expert.version = "9.9.9"
        expert.title = "被改过的标题"
        await db.commit()

    async with sessionmaker() as db:
        await seed_builtin_experts(db)
        await db.commit()

    async with sessionmaker() as db:
        after = (
            await db.execute(select(Expert).where(Expert.id == expert_id))
        ).scalar_one()

    assert after.version == "9.9.9", "版本号只增不减，不能被种子回退"
    assert after.title == SEARCH_EXPERT, "其余字段仍按内置定义覆盖"


async def test_seed_skips_mcp_link_when_service_missing(sessionmaker):
    """MCP 服务缺失时只跳过关联、不炸——但不能悄悄关联到别的服务上。

    这里不跑 MCP 种子，模拟"MCP 服务还没建"的启动顺序异常。
    """
    async with sessionmaker() as db:
        await seed_builtin_experts(db)
        await db.commit()

    async with sessionmaker() as db:
        expert_id = (
            await db.execute(select(Expert.id).where(Expert.name == KB_EXPERT))
        ).scalar_one_or_none()
        configs = (
            await db.execute(
                select(func.count())
                .select_from(ExpertMcpConfig)
                .where(ExpertMcpConfig.expert_id == expert_id)
            )
        ).scalar() if expert_id else 0

    assert configs == 0, "MCP 服务不存在时不应凭空关联"
