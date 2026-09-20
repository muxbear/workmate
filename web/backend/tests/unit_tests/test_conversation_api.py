"""Unit tests for conversation_api._message_to_dict() and the merge logic."""

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from api.conversation.conversation_api import (
    _apply_tool_output,
    _assistant_blocks,
    _attach_turn_meta,
    _message_to_dict,
)


class TestMessageToDict:
    """Tests for _message_to_dict()."""

    def test_ai_string_content(self):
        """AIMessage 纯文本内容不变."""
        msg = AIMessage(content="你好，有什么可以帮你？")
        result = _message_to_dict(msg)
        assert result == {"role": "assistant", "content": "你好，有什么可以帮你？"}

    def test_ai_list_content_with_text_blocks(self):
        """AIMessage 列表 content — 只提取 text 块."""
        msg = AIMessage(content=[
            {"type": "text", "text": "我来帮您搜索新闻"},
            {"type": "tool_call", "id": "call_001", "name": "tavily_search", "args": {}},
        ])
        result = _message_to_dict(msg)
        assert result["role"] == "assistant"
        assert result["content"] == "我来帮您搜索新闻"
        assert "tool_call" not in result["content"]

    def test_ai_list_content_only_tool_calls(self):
        """AIMessage 纯 tool_call 列表（无 text 块）— 返回空字符串."""
        msg = AIMessage(content=[
            {"type": "tool_call", "id": "call_001", "name": "get_datetime", "args": {}},
        ])
        result = _message_to_dict(msg)
        assert result == {"role": "assistant", "content": ""}

    def test_ai_list_content_multiple_text_blocks(self):
        """多个 text 块拼接."""
        msg = AIMessage(content=[
            {"type": "text", "text": "第一段"},
            {"type": "tool_call", "id": "call_001", "name": "search", "args": {}},
            {"type": "text", "text": "第二段"},
        ])
        result = _message_to_dict(msg)
        assert result["content"] == "第一段第二段"

    def test_tool_message_with_name(self):
        """ToolMessage 有名称 — 格式化 markdown 标签."""
        msg = ToolMessage(
            content="搜索完成，找到 3 条结果",
            name="tavily_search",
            tool_call_id="call_001",
        )
        result = _message_to_dict(msg)
        assert result["role"] == "tool"
        assert "**tavily_search** 输出：" in result["content"]
        assert "搜索完成，找到 3 条结果" in result["content"]

    def test_tool_message_without_name(self):
        """ToolMessage 无名称 — 使用 "工具" 兜底."""
        msg = ToolMessage(content="done", name=None, tool_call_id="call_001")
        result = _message_to_dict(msg)
        assert "**工具** 输出：" in result["content"]

    def test_human_message(self):
        """HumanMessage 不变."""
        msg = HumanMessage(content="帮我搜索新闻")
        result = _message_to_dict(msg)
        assert result == {"role": "user", "content": "帮我搜索新闻"}

    def test_system_message(self):
        """SystemMessage 不变."""
        msg = SystemMessage(content="你是一个助手")
        result = _message_to_dict(msg)
        assert result == {"role": "system", "content": "你是一个助手"}

    def test_empty_content(self):
        """空 content."""
        msg = AIMessage(content="")
        result = _message_to_dict(msg)
        assert result == {"role": "assistant", "content": ""}

    def test_ai_empty_list_content(self):
        """空列表 content."""
        msg = AIMessage(content=[])
        result = _message_to_dict(msg)
        assert result == {"role": "assistant", "content": ""}


class TestMergeLogic:
    """Tests for the message merging logic (lines 216-235 of conversation_api.py)."""

    @staticmethod
    def _merge(raw_list: list[dict]) -> list[dict]:
        """Replicate the merge loop from get_conversation."""
        messages: list[dict] = []
        for m in raw_list:
            if m["role"] == "system":
                continue

            if m["role"] == "tool":
                if messages and messages[-1]["role"] == "assistant":
                    messages[-1]["content"] += m["content"]
                continue

            if (
                m["role"] == "assistant"
                and messages
                and messages[-1]["role"] == "assistant"
            ):
                messages[-1]["content"] += "\n\n" + m["content"]
                if m.get("blocks"):
                    messages[-1]["blocks"] = messages[-1].get("blocks", []) + m["blocks"]
            else:
                messages.append(m)
        return messages

    def test_plain_conversation_no_merge(self):
        """纯文本对话，不合并."""
        raw = [
            {"role": "user", "content": "你好"},
            {"role": "assistant", "content": "你好，有什么可以帮助你？"},
        ]
        result = self._merge(raw)
        assert len(result) == 2
        assert result[0] == raw[0]
        assert result[1] == raw[1]

    def test_system_filtered_out(self):
        """System 消息被过滤."""
        raw = [
            {"role": "system", "content": "你是一个助手"},
            {"role": "user", "content": "你好"},
            {"role": "assistant", "content": "你好"},
        ]
        result = self._merge(raw)
        assert len(result) == 2  # system discarded
        assert result[0]["role"] == "user"

    def test_tool_merged_into_assistant(self):
        """ToolMessage 合并到前一条 assistant."""
        raw = [
            {"role": "user", "content": "搜索新闻"},
            {"role": "assistant", "content": "我来帮您搜索"},
            {"role": "tool", "content": "\n\n---\n**tavily_search** 输出：\n结果1\n"},
        ]
        result = self._merge(raw)
        assert len(result) == 2  # user + assistant (merged)
        assert "**tavily_search** 输出：" in result[1]["content"]
        assert "结果1" in result[1]["content"]
        assert "我来帮您搜索" in result[1]["content"]

    def test_consecutive_assistant_merged(self):
        """连续 assistant 消息合并."""
        raw = [
            {"role": "user", "content": "搜索新闻"},
            {"role": "assistant", "content": "搜索中..."},
            {"role": "tool", "content": "\n\n---\n**search** 输出：\n结果\n"},
            {"role": "assistant", "content": "这是今天的新闻摘要"},
        ]
        result = self._merge(raw)
        assert len(result) == 2  # user + assistant (merged)
        assert "搜索中..." in result[1]["content"]
        assert "**search** 输出：" in result[1]["content"]
        assert "结果" in result[1]["content"]
        assert "这是今天的新闻摘要" in result[1]["content"]

    def test_multiple_rounds_of_tool_calls(self):
        """多轮工具调用."""
        raw = [
            {"role": "user", "content": "复杂任务"},
            {"role": "assistant", "content": "先查时间"},
            {"role": "tool", "content": "\n\n---\n**get_datetime** 输出：\n2025-07-14\n"},
            {"role": "assistant", "content": "再搜索"},
            {"role": "tool", "content": "\n\n---\n**tavily_search** 输出：\n结果\n"},
            {"role": "assistant", "content": "汇总如下"},
        ]
        result = self._merge(raw)
        assert len(result) == 2  # user + 1 merged assistant
        content = result[1]["content"]
        assert "先查时间" in content
        assert "get_datetime" in content
        assert "再搜索" in content
        assert "tavily_search" in content
        assert "汇总如下" in content

    def test_tool_without_preceding_assistant_skipped(self):
        """没有前一条 assistant 时，tool 消息被跳过（不应在正常流程中出现）."""
        raw = [
            {"role": "user", "content": "你好"},
            {"role": "tool", "content": "\n\n---\n**orphan** 输出：\n孤立结果\n"},
        ]
        result = self._merge(raw)
        assert len(result) == 1  # only user, tool skipped
        assert result[0]["role"] == "user"

    def test_consecutive_assistant_blocks_merged(self):
        """连续 assistant 的执行块按顺序合并."""
        raw = [
            {"role": "user", "content": "你好"},
            {"role": "assistant", "content": "第一段", "blocks": [{"type": "text", "content": "第一段"}]},
            {"role": "assistant", "content": "第二段", "blocks": [{"type": "text", "content": "第二段"}]},
        ]
        result = self._merge(raw)
        assert len(result) == 2
        assert [b["content"] for b in result[1]["blocks"]] == ["第一段", "第二段"]


class TestAssistantBlocks:
    """Tests for _assistant_blocks()."""

    def test_text_and_tool_call_blocks(self):
        """文本与工具调用各生成一个执行块."""
        msg = AIMessage(
            content="先查一下时间",
            tool_calls=[
                {"name": "get_datetime", "args": {"timezone": "Asia/Shanghai"}, "id": "call_1"}
            ],
        )
        blocks = _assistant_blocks(msg, 0)
        assert blocks[0] == {"type": "text", "content": "先查一下时间"}
        assert blocks[1]["type"] == "tool_call"
        tool_call = blocks[1]["tool_call"]
        assert tool_call["call_id"] == "call_1"
        assert tool_call["name"] == "get_datetime"
        assert tool_call["input"] == '{"timezone": "Asia/Shanghai"}'
        assert tool_call["output"] == ""
        assert tool_call["status"] == "completed"

    def test_list_content_tool_call_without_id(self):
        """call id 为空时用消息序号兜底生成 call_id."""
        msg = AIMessage(content=[{"type": "tool_call", "id": "", "name": "ls", "args": {}}])
        blocks = _assistant_blocks(msg, 3)
        assert blocks[0]["tool_call"]["call_id"] == "assistant-3-0"
        assert blocks[0]["tool_call"]["input"] == ""

    def test_empty_message_has_no_blocks(self):
        """无文本且无工具调用时返回空列表."""
        assert _assistant_blocks(AIMessage(content=""), 0) == []


class TestApplyToolOutput:
    """Tests for _apply_tool_output()."""

    @staticmethod
    def _pending_calls() -> list[dict]:
        """构造一个待回填输出的工具调用块列表."""
        msg = AIMessage(
            content="",
            tool_calls=[{"name": "ls", "args": {"path": "/root"}, "id": "call_1"}],
        )
        return [block["tool_call"] for block in _assistant_blocks(msg, 0)]

    def test_output_matched_by_call_id(self):
        """按 tool_call_id 精确匹配回填输出."""
        pending = self._pending_calls()
        tool_msg = ToolMessage(content="['/root/a.md']", name="ls", tool_call_id="call_1")
        _apply_tool_output(pending, tool_msg)
        assert pending[0]["output"] == "['/root/a.md']"
        assert pending[0]["status"] == "completed"

    def test_output_fallback_when_call_id_missing(self):
        """call_id 缺失时按先后顺序兜底回填."""
        pending = self._pending_calls()
        tool_msg = ToolMessage(content="结果", name="ls", tool_call_id="")
        _apply_tool_output(pending, tool_msg)
        assert pending[0]["output"] == "结果"

    def test_error_output_marks_failed(self):
        """ToolMessage 状态为 error 时标记失败."""
        pending = self._pending_calls()
        tool_msg = ToolMessage(
            content="Error: path_not_found",
            name="ls",
            tool_call_id="call_1",
            status="error",
        )
        _apply_tool_output(pending, tool_msg)
        assert pending[0]["status"] == "failed"


class _StubResult:
    """模拟 SQLAlchemy 查询结果."""

    def __init__(self, rows: list) -> None:
        self._rows = rows

    def scalars(self) -> "_StubResult":
        """返回自身，模拟 Result.scalars()."""
        return self

    def all(self) -> list:
        """返回预设行."""
        return self._rows


class _StubDb:
    """按调用顺序返回预设结果的数据库替身."""

    def __init__(self, *batches: list) -> None:
        self._batches = list(batches)

    async def execute(self, _stmt: object) -> _StubResult:
        """返回下一批预设行."""
        rows = self._batches.pop(0) if self._batches else []
        return _StubResult(rows)


class TestAttachTurnMeta:
    """Tests for _attach_turn_meta()."""

    @staticmethod
    def _messages() -> list[dict]:
        """构造一轮问答的展示消息."""
        return [
            {"role": "user", "content": "你好"},
            {"role": "assistant", "content": "回复", "blocks": []},
        ]

    def test_skips_when_counts_mismatch(self):
        """审计记录条数与助手消息条数不一致时不回填，避免错位."""
        messages = [*self._messages(), {"role": "assistant", "content": "第二轮"}]
        usage = SimpleNamespace(
            duration_ms=1000,
            created_at=datetime(2026, 9, 20, 7, 0, 0),
            model_id=None,
        )
        asyncio.run(_attach_turn_meta(_StubDb([usage]), "t1", messages))
        assert "duration_ms" not in messages[1]
        assert "created_at" not in messages[1]
        assert "duration_ms" not in messages[2]

    def test_fills_duration_and_created_at(self):
        """条数一致时回填耗时与 UTC 毫秒时间戳."""
        messages = self._messages()
        created = datetime(2026, 9, 20, 7, 48, 19)
        usage = SimpleNamespace(duration_ms=1500, created_at=created, model_id=None)
        asyncio.run(_attach_turn_meta(_StubDb([usage]), "t1", messages))
        assert messages[1]["duration_ms"] == 1500
        assert messages[1]["created_at"] == int(created.replace(tzinfo=UTC).timestamp() * 1000)

    def test_fills_model_display_name(self):
        """model_id 存在时回填模型展示名称."""
        messages = self._messages()
        usage = SimpleNamespace(
            duration_ms=10,
            created_at=datetime(2026, 9, 20, 7, 0, 0),
            model_id="m1",
        )
        db = _StubDb([usage], [("m1", "deepseek-chat", "DeepSeek Chat")])
        asyncio.run(_attach_turn_meta(db, "t1", messages))
        assert messages[1]["model"] == "DeepSeek Chat"

    def test_no_assistant_message(self):
        """没有助手消息时不写任何元信息."""
        messages = [{"role": "user", "content": "你好"}]
        asyncio.run(_attach_turn_meta(_StubDb([]), "t1", messages))
        assert messages == [{"role": "user", "content": "你好"}]
