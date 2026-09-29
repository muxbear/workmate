"""专家声明式能力（capabilities）单元测试。"""

import asyncio
from datetime import UTC, datetime

from agent.experts.capabilities import (
    ALL_CAPABILITIES,
    capability_builtin_tools,
    capability_mcp_tools,
    capabilities_for_mcp_services,
    capabilities_for_tools,
    normalize_capabilities,
)


def test_normalize_capabilities() -> None:
    """未知能力被过滤，重复项去重且保序。"""
    assert normalize_capabilities(
        ["image.generate", "image.generate", "unknown.foo"]
    ) == ["image.generate"]
    assert normalize_capabilities(None) == []
    assert ALL_CAPABILITIES[0] == "image.generate"


def test_capability_tool_expansion() -> None:
    """能力展开为内置工具与 MCP 工具（保序去重）。"""
    caps = ["document.assemble", "image.generate"]
    assert capability_builtin_tools(caps) == ["download_asset"]
    mcp_tools = capability_mcp_tools(caps)
    assert mcp_tools[0] == "text_to_image"
    assert "image_to_image_batch" in mcp_tools


def test_capabilities_reverse_lookup() -> None:
    """由工具名 / MCP 服务名反推能力，顺序稳定。"""
    assert capabilities_for_tools(["download_asset"]) == ["document.assemble"]
    assert capabilities_for_tools(["text_to_image_batch"]) == ["image.generate"]
    assert capabilities_for_tools(["unknown_tool"]) == []
    assert capabilities_for_tools([]) == []
    assert capabilities_for_mcp_services(["AI 图像生成", "未知服务"]) == ["image.generate"]


def test_builtin_doc_expert_declares_capabilities() -> None:
    """内置「文档写作专家」以能力声明驱动工具关联。"""
    from api.experts.service import BUILTIN_EXPERTS, _declared_tool_names

    doc = next(item for item in BUILTIN_EXPERTS if item["name"] == "文档写作专家")
    assert doc["capabilities"] == ["image.generate", "document.assemble"]
    assert "tool_names" not in doc
    assert _declared_tool_names(doc) == ["download_asset"]


def test_builtin_video_expert_declares_capabilities() -> None:
    """内置「视频创作专家」声明能力，并由能力推导出素材工具关联。"""
    from api.experts.service import BUILTIN_EXPERTS, _declared_tool_names

    video = next(item for item in BUILTIN_EXPERTS if item["name"] == "视频创作专家")
    assert video["capabilities"] == ["video.generate", "document.assemble"]
    assert "tool_names" not in video
    # 视频落盘与配图共用 download_asset：缺少该关联时专家只能自己执行 shell 命令下载
    assert _declared_tool_names(video) == ["download_asset"]


def test_video_capability_expands_to_mcp_tools() -> None:
    """video.generate 展开为视频生成 MCP 工具，且不产出内置工具。"""
    assert capability_builtin_tools(["video.generate"]) == []
    mcp_tools = capability_mcp_tools(["video.generate"])
    assert mcp_tools == ["generate_video", "query_video_generation"]
    assert capabilities_for_mcp_services(["AI 视频生成"]) == ["video.generate"]


def test_builtin_search_expert_declares_capabilities() -> None:
    """内置「互联网信息检索专家」只声明能力，不写死端侧工具名。"""
    from api.experts.service import BUILTIN_EXPERTS, _declared_tool_names

    search = next(
        item for item in BUILTIN_EXPERTS if item["name"] == "互联网信息检索专家"
    )
    assert search["capabilities"] == ["web.search"]
    assert "tool_names" not in search
    # 声明式：不关联内置工具，MCP 服务因此不会被 skip_capabilities 顶掉
    assert _declared_tool_names(search) == []


def test_web_search_capability_expands_to_mcp_only() -> None:
    """web.search 只展开为 MCP 工具：三端统一走「联网搜索」服务，无端侧实现。

    内置的 tavily_search 是单源工具（配额耗尽即返回空结果），若把它绑到本能力，
    ``_resolve_entity_tools`` 会据此跳过 MCP 服务，反而让两端检索一起失效。
    """
    assert capability_builtin_tools(["web.search"]) == []
    assert capability_mcp_tools(["web.search"]) == ["web_search"]
    assert capabilities_for_mcp_services(["联网搜索"]) == ["web.search"]
    # 内置 tavily_search 不再反向推导出 web.search（该能力已不由它承载）
    assert capabilities_for_tools(["tavily_search"]) == []
    assert capabilities_for_tools(["download_asset"]) == ["document.assemble"]


def test_builtin_search_expert_binds_the_web_search_mcp_service() -> None:
    """专家组绑的是「联网搜索」MCP 服务，服务名必须与种子卡片一字不差。"""
    from api.experts.service import BUILTIN_EXPERTS

    search = next(
        item for item in BUILTIN_EXPERTS if item["name"] == "互联网信息检索专家"
    )
    assert search["mcp_tool_name"] == "联网搜索"
    assert capabilities_for_mcp_services([search["mcp_tool_name"]]) == ["web.search"]


def test_sync_item_carries_capabilities() -> None:
    """同步项携带能力声明，供桌面端按能力映射本地工具。"""
    from api.experts.schemas import ExpertInfo
    from api.experts.service import ExpertAssembler

    now = datetime.now(UTC).replace(tzinfo=None)
    info = ExpertInfo(
        id="e1",
        name="文档写作专家",
        title="文档写作专家",
        description="",
        category="content_creation",
        tags=[],
        icon="",
        color="",
        initials="文",
        rating=0,
        usage_count=0,
        featured=False,
        sort_order=0,
        is_published=True,
        status="active",
        system_prompt="",
        capabilities=["document.assemble"],
        created_at=now,
        updated_at=now,
    )
    item = asyncio.run(ExpertAssembler.to_sync_item(info))
    assert item.capabilities == ["document.assemble"]
