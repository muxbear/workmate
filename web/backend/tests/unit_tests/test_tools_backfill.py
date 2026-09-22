"""内置工具 backfill 判重口径回归测试。

背景：tools.name 是全局唯一索引（与 source 无关）。曾因只在 source='builtin'
的行里判重，与 MCP/第三方注册的同名工具冲突，启动时 UniqueViolation 中断服务。
"""

from api.tools.service import BUILTIN_TOOLS, missing_builtin_tools


def test_missing_builtin_tools_skips_names_from_other_sources() -> None:
    """同名工具即便 source 非 builtin，也算已存在，不得重复插入。"""
    existing = {"tavily_search", "read_file", "write_file", "kb_search"}
    names = [item["name"] for item in missing_builtin_tools(existing)]
    assert "tavily_search" not in names
    assert "read_file" not in names
    assert "download_asset" in names


def test_missing_builtin_tools_full_coverage_returns_empty() -> None:
    """全表已含全部内置工具名时返回空列表（幂等）。"""
    existing = {item["name"] for item in BUILTIN_TOOLS}
    assert missing_builtin_tools(existing) == []


def test_missing_builtin_tools_keeps_definition_order() -> None:
    """补全顺序与内置定义顺序一致，便于日志核对。"""
    missing = missing_builtin_tools(set())
    assert [item["name"] for item in missing] == [item["name"] for item in BUILTIN_TOOLS]


def test_missing_builtin_tools_accepts_custom_items() -> None:
    """支持传入自定义清单。"""
    items = [{"name": "a"}, {"name": "b"}]
    assert [item["name"] for item in missing_builtin_tools({"a"}, items)] == ["b"]