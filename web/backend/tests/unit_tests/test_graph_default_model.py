"""GraphManager 在「模型」页面未配置时的启动降级行为。

``server.py`` 的 lifespan 会 ``await init_graph()``，而建图必须解析默认对话模型。
如果那里直接抛错，未配置模型的部署连服务都起不来——用户也就没有入口去
「模型」页面把模型配好。因此这里断言：缺模型时降级启动，且首个请求能重试。
"""

from unittest.mock import AsyncMock

import pytest

from agent.graph import GraphManager
from agent.models.resolver import ModelNotConfiguredError

pytestmark = pytest.mark.anyio

NO_MODEL_ERROR = ModelNotConfiguredError("未在「模型」页面找到可用的对话模型")


@pytest.fixture
def manager(monkeypatch):
    """隔离出只测降级逻辑的 GraphManager（基础设施初始化换成空操作）。"""
    mgr = GraphManager()
    monkeypatch.setattr(mgr, "_init_infrastructure", AsyncMock())
    return mgr


def _stub_build(manager: GraphManager, *results: object) -> AsyncMock:
    """替换 ``_build_graph``，复刻其真实契约：成功时给 ``_graph`` 赋值并返回 None。

    ``results`` 依次作为每次调用的结果：异常实例则抛出，否则视为要建成的图。
    不这样做的话「成功」路径不会设置 ``_graph``（真实实现才是赋值方）。
    """
    remaining = list(results)

    async def _build() -> None:
        outcome = remaining.pop(0) if len(remaining) > 1 else remaining[0]
        if isinstance(outcome, BaseException):
            raise outcome
        manager._graph = outcome
        manager._dirty = False
        manager._build_error = None

    mock = AsyncMock(side_effect=_build)
    manager._build_graph = mock  # type: ignore[method-assign]
    return mock


async def test_init_graph_degrades_when_no_model_configured(manager):
    """未配置模型：init_graph 不抛异常，服务照常启动。"""
    _stub_build(manager, NO_MODEL_ERROR)

    await manager.init_graph()  # 不应抛出

    assert manager._graph is None
    # get_graph 给出可执行提示，而不是「图未初始化」这种无信息量的文案
    with pytest.raises(RuntimeError, match="模型"):
        manager.get_graph()


async def test_init_graph_propagates_unrelated_errors(manager):
    """非「缺模型」的建图失败仍然照常抛出，不能被降级逻辑吞掉。"""
    _stub_build(manager, RuntimeError("数据库连接失败"))

    with pytest.raises(RuntimeError, match="数据库连接失败"):
        await manager.init_graph()


async def test_ensure_built_retries_after_model_configured(manager):
    """先降级、后配好模型：下次 ensure_built 能成功建图并清除错误状态。"""
    sentinel_graph = object()
    _stub_build(manager, NO_MODEL_ERROR, sentinel_graph)

    await manager.init_graph()
    assert manager._graph is None

    assert await manager.ensure_built() is sentinel_graph
    assert manager._graph is sentinel_graph
    assert manager._build_error is None


async def test_invalidate_keeps_previous_graph_for_history_reads(manager):
    """invalidate 后仍返回上一版图，历史消息读取不会因编辑模型而 500。"""
    sentinel_graph = object()
    _stub_build(manager, sentinel_graph)

    await manager.init_graph()
    await manager.invalidate()

    # 关键：没有重建也拿得到图（conversation API 的 aget_state 依赖这一点）
    assert manager.get_graph() is sentinel_graph
    assert manager._dirty is True

    # 下一次 ensure_built 才会真正重建
    await manager.ensure_built()
    assert manager._dirty is False


async def test_ensure_built_for_user_selected_model_skips_default_graph(manager, monkeypatch):
    """显式选模型的请求走独立图，不因默认模型没配好而被挡。"""
    sentinel_graph = object()
    build = _stub_build(manager, sentinel_graph)
    monkeypatch.setattr(
        "agent.mainagents.create_main_agent",
        AsyncMock(return_value=sentinel_graph),
    )

    assert await manager.ensure_built_for("p1", "m1") is sentinel_graph

    # 只初始化基础设施，未构建默认图：默认模型没配好也不影响显式选择
    assert build.await_count == 0
    assert manager._graph is None
