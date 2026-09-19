"""会话级选择项与消息组装单元测试。"""

import asyncio

import pytest
from pydantic import ValidationError

from api.agent.agent_api import (
    ChatPart,
    ChatRequest,
    _build_user_body,
    _collect_attachment_ids,
    _compose_effective_message,
)


def test_request_requires_content() -> None:
    """空请求（无 message / parts / attachment_ids）应被拒绝。"""
    with pytest.raises(ValidationError):
        ChatRequest()


def test_request_accepts_parts_only() -> None:
    """仅传 parts 时同样视为有效请求。"""
    req = ChatRequest(parts=[ChatPart(type="text", text="你好")])
    assert _build_user_body(req) == "你好"


def test_build_user_body_keeps_order() -> None:
    """parts 按输入顺序还原为正文，文件引用以文件名占位。"""
    req = ChatRequest(
        parts=[
            ChatPart(type="text", text="看下"),
            ChatPart(type="file", attachment_id="a1", filename="报表.xlsx"),
            ChatPart(type="text", text="并总结"),
        ]
    )
    assert _build_user_body(req) == "看下[报表.xlsx]并总结"


def test_collect_attachment_ids_merges_and_dedupes() -> None:
    """attachment_ids 与 parts 中的文件引用合并去重。"""
    req = ChatRequest(
        message="hi",
        attachment_ids=["a1", "a2"],
        parts=[
            ChatPart(type="file", attachment_id="a2", filename="b.pdf"),
            ChatPart(type="file", attachment_id="a3", filename="c.png"),
        ],
    )
    assert asyncio.run(_collect_attachment_ids(req)) == ["a1", "a2", "a3"]


def test_compose_effective_message_sections() -> None:
    """会话配置、附件清单与用户正文按块组装。"""
    req = ChatRequest(message="总结这份文件")
    text = _compose_effective_message(
        req,
        ["/chat_upload/2026-09-19/a.pdf"],
        ["【专家】本次任务已选择专家「财务」"],
    )
    assert "【会话配置】" in text
    assert "【专家】本次任务已选择专家「财务」" in text
    assert "[FILE] /chat_upload/2026-09-19/a.pdf" in text
    assert text.endswith("用户消息：总结这份文件")


def test_legacy_request_unchanged() -> None:
    """未传选择项时，组装结果与改造前一致（仅正文）。"""
    req = ChatRequest(message="你好")
    assert _compose_effective_message(req, [], []) == "用户消息：你好"


def test_request_accepts_model_override() -> None:
    """会话级模型选择：provider_id + model_id 可随请求下发。"""
    req = ChatRequest(message="hi", provider_id="p1", model_id="m1")
    assert req.provider_id == "p1"
    assert req.model_id == "m1"


def test_builder_model_override_state() -> None:
    """AgentBuilder 在 with_model() 前记录会话级模型覆盖。"""
    from agent.builders.agent_builder import AgentBuilder

    builder = AgentBuilder()
    assert builder._model_override is None
    builder.with_model_override("p2", "m2")
    assert builder._model_override == ("p2", "m2")


def test_split_for_polish_short_text() -> None:
    '''短文本不分片。'''
    from api.agent.agent_api import split_for_polish

    assert split_for_polish('你好', limit=100) == ['你好']


def test_split_for_polish_keeps_paragraphs() -> None:
    '''长文本按段落分片，且每片不超过上限。'''
    from api.agent.agent_api import split_for_polish

    text = '\n'.join(['A' * 40, 'B' * 40, 'C' * 40])
    chunks = split_for_polish(text, limit=90)
    assert len(chunks) == 2
    assert all(len(chunk) <= 90 for chunk in chunks)
    assert chr(10).join(chunks).replace(chr(10), '') == text.replace(chr(10), '')


def test_split_for_polish_hard_splits_long_paragraph() -> None:
    '''单段超长时按上限硬切。'''
    from api.agent.agent_api import split_for_polish

    chunks = split_for_polish('X' * 250, limit=100)
    assert [len(chunk) for chunk in chunks] == [100, 100, 50]
