"""专家强制委派中间件单元测试。"""

import asyncio
from types import SimpleNamespace

from langchain_core.messages import SystemMessage

from agent.middleware.expert_directive import (
    ExpertDirectiveMiddleware,
    build_expert_directive,
    has_task_tool,
)


class _Tool:
    """最小工具替身（仅需 name）。"""

    def __init__(self, name: str) -> None:
        self.name = name


class _Request:
    """最小 ModelRequest 替身（支持 override 与 runtime.context）。"""

    def __init__(
        self,
        *,
        expert_name: str,
        tools: list[object],
        system: str = "基础提示词",
    ) -> None:
        self.runtime = SimpleNamespace(context=SimpleNamespace(expert_name=expert_name))
        self.tools = tools
        self.system_message = SystemMessage(content=system) if system else None
        self.model = SimpleNamespace()
        self.messages: list[object] = []

    def override(self, **kwargs: object) -> "_Request":
        """按不可变语义返回替换后的请求副本。"""
        clone = object.__new__(_Request)
        clone.__dict__.update(self.__dict__)
        clone.__dict__.update(kwargs)
        return clone


def _run(middleware: ExpertDirectiveMiddleware, request: _Request) -> str:
    """执行中间件并返回实际传给模型的系统提示词。"""
    captured: list[str] = []

    async def handler(req: _Request) -> str:
        content = req.system_message.content if req.system_message else ""
        captured.append(str(content))
        return "ok"

    asyncio.run(middleware.awrap_model_call(request, handler))
    assert len(captured) == 1
    return captured[0]


def test_build_directive_and_task_tool() -> None:
    """专家名为空不生成指令；task 工具识别支持对象与字典两种形态。"""
    assert build_expert_directive("") == ""
    assert "文档写作专家" in build_expert_directive("文档写作专家")
    assert has_task_tool([_Tool("task")]) is True
    assert has_task_tool([{"name": "task"}]) is True
    assert has_task_tool([_Tool("write_file")]) is False
    assert has_task_tool(None) is False


def test_middleware_appends_directive_when_expert_selected() -> None:
    """选中专家且存在 task 工具时，系统提示词被追加强制委派指令。"""
    request = _Request(expert_name="文档写作专家", tools=[_Tool("task")])
    content = _run(ExpertDirectiveMiddleware(), request)
    assert "基础提示词" in content
    assert "强制委派" in content
    assert "文档写作专家" in content
    assert "task" in content


def test_middleware_skips_without_expert_or_task_tool() -> None:
    """未选专家或没有 task 工具时不改动系统提示词。"""
    no_expert = _Request(expert_name="", tools=[_Tool("task")])
    assert _run(ExpertDirectiveMiddleware(), no_expert) == "基础提示词"

    no_task = _Request(expert_name="文档写作专家", tools=[_Tool("write_file")])
    content = _run(ExpertDirectiveMiddleware(), no_task)
    assert content == "基础提示词"
    assert "强制委派" not in content


def test_middleware_handles_missing_system_message() -> None:
    """系统提示词缺失时以指令本身作为提示词。"""
    request = _Request(expert_name="文档写作专家", tools=[_Tool("task")], system="")
    content = _run(ExpertDirectiveMiddleware(), request)
    assert content.startswith("## 本次任务的强制委派要求")


def test_directive_carries_platform_and_delivery_dir() -> None:
    """指令包含本轮运行环境与交付目录（移动端口径）。"""
    text = build_expert_directive(
        "文档写作专家", platform="mobile", delivery_dir="/artifacts/t1/turn-2"
    )
    assert "强制委派" in text
    assert "移动端" in text
    assert "/artifacts/t1/turn-2/" in text


def test_directive_defaults_to_web_notes_without_delivery_dir() -> None:
    """不传平台时按 web 口径；未知平台同样回退 web；未选专家返回空串。"""
    text = build_expert_directive("文档写作专家", platform="unknown-client")
    assert "Linux" in text
    assert "/artifacts/" not in text
    assert build_expert_directive("") == ""


def test_middleware_reads_platform_and_delivery_dir_from_context() -> None:
    """中间件从 runtime context 读取 platform 与 delivery_dir。"""
    request = _Request(expert_name="文档写作专家", tools=[_Tool("task")])
    request.runtime = SimpleNamespace(
        context=SimpleNamespace(
            expert_name="文档写作专家",
            platform="mobile",
            delivery_dir="/artifacts/t1/turn-3",
        )
    )
    content = _run(ExpertDirectiveMiddleware(), request)
    assert "移动端" in content
    assert "/artifacts/t1/turn-3/" in content
