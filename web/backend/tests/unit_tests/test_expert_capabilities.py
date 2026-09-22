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
