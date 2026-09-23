"""Tests for agent.tools 包的命名空间契约。

回归背景：``agent/tools/__init__.py`` 曾把工具函数重导出到与子模块同名的属性上，
``from agent.tools.kb_search import kb_search`` 会把包属性 ``agent.tools.kb_search``
从「子模块」覆盖成「函数」。后果是 ``import agent.tools.kb_search`` 拿到的东西
取决于导入顺序——``get_datetime``、``http_request``、``kb_search``、``tavily_search``
四个名字都受影响，测试代码里实测踩到过。

运行期工具装配走 DB 里的字符串路径 ``agent.tools.kb_search:kb_search``，因此本文件
同时守护「字符串路径仍可解析」这一契约。
"""

import importlib
import warnings

import pytest

#: 包内既有子模块、又曾被同名函数遮蔽的名字
COLLIDING_NAMES = ["get_datetime", "http_request", "kb_search", "tavily_search"]


@pytest.fixture(scope="module", autouse=True)
def _import_package():
    importlib.import_module("agent.tools")
    for name in COLLIDING_NAMES:
        importlib.import_module(f"agent.tools.{name}")


class TestNoShadowing:
    @pytest.mark.parametrize("name", COLLIDING_NAMES)
    def test_package_attribute_is_module(self, name):
        """包属性必须是子模块，而不是同名函数。"""
        import agent.tools

        attr = getattr(agent.tools, name)
        assert hasattr(attr, "__file__") or hasattr(attr, "__path__"), (
            f"agent.tools.{name} 被非模块对象遮蔽了: {type(attr)}"
        )

    @pytest.mark.parametrize("name,fn_name", [
        ("get_datetime", "get_datetime"),
        ("http_request", "http_request"),
        ("kb_search", "kb_search"),
        ("tavily_search", "tavily_search"),
    ])
    def test_function_importable_from_submodule(self, name, fn_name):
        module = importlib.import_module(f"agent.tools.{name}")
        assert callable(getattr(module, fn_name))

    def test_importlib_import_module_is_stable(self):
        """反复导入仍稳定拿到模块（遮蔽问题的典型症状是顺序相关）。"""
        for _ in range(3):
            module = importlib.import_module("agent.tools.kb_search")
            assert callable(module.kb_search)
            assert callable(module.list_knowledge_bases)


class TestRegistryStringPaths:
    """DB 里的 implementation 字符串路径必须能解析出可调用对象。"""

    @pytest.mark.parametrize("implementation", [
        "agent.tools.kb_search:kb_search",
        "agent.tools.kb_search:list_knowledge_bases",
        "agent.tools.get_datetime:get_datetime",
        "agent.tools.http_request:http_request",
        "agent.tools.tavily_search:tavily_search",
    ])
    def test_load_tool_by_implementation(self, implementation):
        from agent.tools.registry import load_tool_by_implementation

        assert callable(load_tool_by_implementation(implementation))

    def test_unknown_path_returns_none(self):
        from agent.tools.registry import load_tool_by_implementation

        assert load_tool_by_implementation("agent.tools.nope:missing") is None

    def test_builtin_tool_map_paths_are_resolvable(self):
        """BUILTIN_TOOL_IMPLEMENTATIONS 里登记的每个路径都应可解析。"""
        from agent.tools.registry import load_tool_by_implementation
        from api.tools.service import BUILTIN_TOOL_IMPLEMENTATIONS

        unresolvable = [
            name for name, path in BUILTIN_TOOL_IMPLEMENTATIONS.items()
            if load_tool_by_implementation(path) is None
        ]
        assert unresolvable == [], f"以下内置工具的 implementation 无法解析: {unresolvable}"


class TestDeprecatedCommonRegistry:
    def test_still_returns_all_tools(self):
        """废弃入口的返回值不应因为去掉重导出而变空。"""
        from agent.common import get_tool_registry

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            registry = get_tool_registry()

        assert set(registry) == {
            "get_datetime", "http_request", "kb_search",
            "list_knowledge_bases", "tavily_search",
        }
        assert all(callable(fn) for fn in registry.values())

    def test_emits_deprecation_warning(self):
        from agent.common import get_tool_registry

        with pytest.warns(DeprecationWarning, match="已废弃"):
            get_tool_registry()
