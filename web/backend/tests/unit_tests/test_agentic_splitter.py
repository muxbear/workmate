"""Tests for Agentic 切片与 LLM 客户端。

用假 LLM / httpx.MockTransport 离线覆盖：
- 边界解析的容错（代码块、噪声文本、非法下标）；
- LLM 边界被采纳、预算硬切兜底、重叠保留；
- LLM 缺失或失败时不抛异常（索引不会因此失败）；
- ChatClient 的请求体、鉴权、响应解析与失败回退。
"""

import json

import httpx
import pytest
from langchain_core.documents import Document

from core.rag.llm import ChatClient, extract_message_content
from core.rag.splitters import AgenticChunkStrategy, parse_boundaries

pytestmark = pytest.mark.anyio


PARAGRAPHS = [
    "向量数据库用于相似度检索。",
    "Milvus 是常用的向量数据库实现。",
    "今天天气不错，适合出门散步。",
    "公园里的花开了，很多人在拍照。",
]


def make_doc(texts=None, **metadata) -> Document:
    body = "\n\n".join(texts if texts is not None else PARAGRAPHS)
    return Document(page_content=body, metadata={"source": "test.txt", **metadata})


class FakeLLM:
    """按脚本返回固定回答的假 LLM。"""

    def __init__(self, answer: str | None = None, fail: bool = False):
        self.answer = answer
        self.fail = fail
        self.prompts: list[str] = []
        self.systems: list[str | None] = []

    async def acomplete(self, prompt: str, system: str | None = None) -> str | None:
        self.prompts.append(prompt)
        self.systems.append(system)
        if self.fail:
            raise RuntimeError("llm down")
        return self.answer


# ─── 边界解析 ────────────────────────────────────────────────────────────────


class TestParseBoundaries:
    def test_plain_json(self):
        assert parse_boundaries('{"boundaries": [2]}', 4) == [2]

    def test_multiple_boundaries_sorted_and_deduped(self):
        assert parse_boundaries('{"boundaries": [3, 1, 1]}', 5) == [1, 3]

    def test_code_fence_wrapped(self):
        assert parse_boundaries('```json\n{"boundaries": [2]}\n```', 4) == [2]

    def test_surrounded_by_prose(self):
        answer = '好的，分析结果如下：{"boundaries": [1]} 希望有帮助。'
        assert parse_boundaries(answer, 4) == [1]

    def test_empty_boundaries(self):
        assert parse_boundaries('{"boundaries": []}', 4) == []

    def test_out_of_range_filtered(self):
        """下标必须落在 (0, paragraph_count) 内。"""
        assert parse_boundaries('{"boundaries": [0, 4, 99]}', 4) == []

    def test_boundary_at_zero_ignored(self):
        """在首段之前断开没有意义。"""
        assert parse_boundaries('{"boundaries": [0]}', 4) == []

    def test_negative_filtered(self):
        assert parse_boundaries('{"boundaries": [-1]}', 4) == []

    def test_non_integer_filtered(self):
        assert parse_boundaries('{"boundaries": ["abc", null, 2]}', 4) == [2]

    def test_string_numbers_accepted(self):
        assert parse_boundaries('{"boundaries": ["2"]}', 4) == [2]

    @pytest.mark.parametrize("answer", ["", "no json here", "{invalid}", "[1,2]", None])
    def test_unparsable_returns_empty(self, answer):
        assert parse_boundaries(answer, 4) == []

    def test_wrong_key_ignored(self):
        assert parse_boundaries('{"breaks": [2]}', 4) == []


# ─── 切片策略 ────────────────────────────────────────────────────────────────


class TestAgenticSplit:
    async def test_uses_llm_boundary(self):
        """LLM 指出的主题切换点被采纳。

        预算设为「收满 4 段才触发询问」，此时 LLM 给出的边界下标 2 才落在
        合法区间 (0, 4) 内，于是前两段成一片、后两段成另一片。
        """
        strategy = AgenticChunkStrategy(
            llm=FakeLLM('{"boundaries": [2]}'), chunk_size=60, chunk_overlap=0,
        )
        chunks = await strategy.async_split([make_doc()])

        assert len(chunks) == 2
        assert "向量数据库用于相似度检索。" in chunks[0].page_content
        assert "Milvus 是常用的向量数据库实现。" in chunks[0].page_content
        assert chunks[1].page_content.startswith("今天天气不错")

    async def test_invalid_boundary_falls_back_to_hard_cut(self):
        """LLM 给出的越界下标被忽略，转走预算硬切。"""
        strategy = AgenticChunkStrategy(
            llm=FakeLLM('{"boundaries": [99]}'), chunk_size=60, chunk_overlap=0,
        )
        chunks = await strategy.async_split([make_doc()])
        assert chunks, "越界边界不应导致丢内容"

    async def test_hard_cut_when_llm_returns_no_boundary(self):
        """LLM 认为同一主题时按预算硬切，分片不会无限增长。"""
        strategy = AgenticChunkStrategy(
            llm=FakeLLM('{"boundaries": []}'), chunk_size=20, chunk_overlap=0,
        )
        chunks = await strategy.async_split([make_doc()])
        assert len(chunks) >= 2
        for chunk in chunks:
            assert len(chunk.page_content) <= 20 * 1.5 + len(PARAGRAPHS[0])

    async def test_hard_cut_without_llm(self):
        """未注入 LLM 也能切片（退化为按预算硬切）。"""
        strategy = AgenticChunkStrategy(llm=None, chunk_size=20, chunk_overlap=0)
        chunks = await strategy.async_split([make_doc()])
        assert len(chunks) >= 2

    async def test_llm_failure_does_not_raise(self):
        """LLM 抛异常时回退硬切，索引流程不中断。"""
        strategy = AgenticChunkStrategy(
            llm=FakeLLM(fail=True), chunk_size=20, chunk_overlap=0,
        )
        chunks = await strategy.async_split([make_doc()])
        assert chunks

    async def test_short_document_is_single_chunk(self):
        strategy = AgenticChunkStrategy(llm=FakeLLM('{"boundaries": []}'), chunk_size=1000)
        chunks = await strategy.async_split([make_doc(["只有一段。"])])
        assert len(chunks) == 1
        assert chunks[0].page_content == "只有一段。"

    async def test_empty_document_returns_nothing(self):
        strategy = AgenticChunkStrategy(llm=FakeLLM('{"boundaries": []}'))
        assert await strategy.async_split([make_doc(["\n\n   \n\n"])]) == []

    async def test_metadata_preserved_and_indexed(self):
        strategy = AgenticChunkStrategy(llm=None, chunk_size=20, chunk_overlap=0)
        chunks = await strategy.async_split([make_doc()])
        assert chunks[0].metadata["source"] == "test.txt"
        assert chunks[0].metadata["splitter"] == "agentic"
        assert [c.metadata["chunk_index"] for c in chunks] == list(range(len(chunks)))

    async def test_overlap_carries_tail_paragraph(self):
        """chunk_overlap 足够容纳上一片尾段时，该段会出现在下一片开头。"""
        strategy = AgenticChunkStrategy(
            llm=FakeLLM('{"boundaries": []}'), chunk_size=20, chunk_overlap=15,
        )
        chunks = await strategy.async_split([make_doc()])
        assert chunks[1].page_content.startswith(PARAGRAPHS[0])
        assert chunks[1].page_content != chunks[0].page_content

    async def test_overlap_smaller_than_paragraph_is_skipped(self):
        """重叠预算放不下整段时不强行截断（避免切出半个句子）。"""
        strategy = AgenticChunkStrategy(
            llm=FakeLLM('{"boundaries": []}'), chunk_size=20, chunk_overlap=1,
        )
        chunks = await strategy.async_split([make_doc()])
        assert not chunks[1].page_content.startswith(PARAGRAPHS[0])

    async def test_zero_overlap_has_no_repetition(self):
        strategy = AgenticChunkStrategy(
            llm=FakeLLM('{"boundaries": []}'), chunk_size=20, chunk_overlap=0,
        )
        chunks = await strategy.async_split([make_doc()])
        assert PARAGRAPHS[1] in chunks[1].page_content

    async def test_prompt_contains_numbered_paragraphs(self):
        llm = FakeLLM('{"boundaries": []}')
        strategy = AgenticChunkStrategy(llm=llm, chunk_size=20, chunk_overlap=0)
        await strategy.async_split([make_doc()])
        assert llm.prompts, "应至少询问一次 LLM"
        assert "[0]" in llm.prompts[0]
        assert llm.systems[0], "应带系统提示"

    async def test_multiple_documents(self):
        strategy = AgenticChunkStrategy(llm=None, chunk_size=20, chunk_overlap=0)
        chunks = await strategy.async_split([make_doc(), make_doc(["另一篇文档内容。"])])
        assert len(chunks) >= 3

    def test_sync_split_works_outside_event_loop(self):
        """无事件循环时同步入口可用（兼容既有调用方）。"""
        strategy = AgenticChunkStrategy(llm=None, chunk_size=20, chunk_overlap=0)
        chunks = strategy.split([make_doc()])
        assert len(chunks) >= 2

    async def test_sync_split_refuses_inside_event_loop(self):
        """事件循环内同步调用会给出明确错误，而不是静默死锁。"""
        strategy = AgenticChunkStrategy(llm=None, chunk_size=20, chunk_overlap=0)
        with pytest.raises(RuntimeError, match="async_split"):
            strategy.split([make_doc()])

    async def test_single_paragraph_document(self):
        strategy = AgenticChunkStrategy(llm=FakeLLM('{"boundaries": [1]}'), chunk_size=5)
        chunks = await strategy.async_split([make_doc(["很长的一大段内容没有任何空行分隔。"])])
        assert len(chunks) == 1


# ─── LLM 客户端 ──────────────────────────────────────────────────────────────


def make_client(handler, **kwargs) -> ChatClient:
    return ChatClient(
        model="deepseek-v3",
        api_base="https://api.example.com/v1",
        api_key="sk-test",
        transport=httpx.MockTransport(handler),
        **kwargs,
    )


class TestExtractMessageContent:
    def test_string_content(self):
        payload = {"choices": [{"message": {"content": "你好"}}]}
        assert extract_message_content(payload) == "你好"

    def test_array_content(self):
        payload = {"choices": [{"message": {"content": [
            {"type": "text", "text": "你"},
            {"type": "text", "text": "好"},
        ]}}]}
        assert extract_message_content(payload) == "你好"

    @pytest.mark.parametrize("payload", [
        None, {}, {"choices": []}, {"choices": [{}]},
        {"choices": [{"message": {}}]}, {"choices": ["junk"]},
    ])
    def test_missing_fields(self, payload):
        assert extract_message_content(payload) is None


class TestChatClient:
    async def test_request_shape(self):
        captured: list[httpx.Request] = []

        def handler(request):
            captured.append(request)
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

        client = make_client(handler)
        result = await client.acomplete("问题", system="系统提示")

        assert result == "ok"
        request = captured[0]
        assert str(request.url) == "https://api.example.com/v1/chat/completions"
        assert request.headers["Authorization"] == "Bearer sk-test"
        body = json.loads(request.content)
        assert body["model"] == "deepseek-v3"
        assert body["messages"] == [
            {"role": "system", "content": "系统提示"},
            {"role": "user", "content": "问题"},
        ]

    async def test_no_system_message_when_omitted(self):
        captured: list[httpx.Request] = []

        def handler(request):
            captured.append(request)
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

        await make_client(handler).acomplete("问题")
        body = json.loads(captured[0].content)
        assert body["messages"] == [{"role": "user", "content": "问题"}]

    async def test_http_error_returns_none(self):
        def handler(request):
            return httpx.Response(500, json={"error": "boom"})

        assert await make_client(handler).acomplete("q") is None

    async def test_invalid_json_returns_none(self):
        def handler(request):
            return httpx.Response(200, content=b"not json")

        assert await make_client(handler).acomplete("q") is None

    async def test_network_error_returns_none(self):
        def handler(request):
            raise httpx.ConnectError("refused")

        assert await make_client(handler).acomplete("q") is None
