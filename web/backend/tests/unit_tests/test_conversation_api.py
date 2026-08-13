"""Unit tests for conversation_api._message_to_dict() and the merge logic."""

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from api.conversation.conversation_api import _message_to_dict


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
