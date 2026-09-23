"""Tests for core.rag.reranker — 精排客户端与响应解析。

用 httpx.MockTransport 离线模拟各家 rerank 接口，覆盖：
- 三种常见响应包裹形式的解析；
- 得分排序 / top_n 截断 / 越界下标过滤；
- 请求体与鉴权头正确；
- 任何失败都回退 ``None``（精排不能拖垮检索）。
"""

import json

import httpx
import pytest

from core.rag.reranker import (
    PAYLOAD_STYLE_COHERE,
    PAYLOAD_STYLE_DASHSCOPE,
    RERANK_CANDIDATE_MULTIPLIER,
    RerankerClient,
    detect_payload_style,
    extract_rerank_results,
    resolve_dashscope_rerank_url,
)

pytestmark = pytest.mark.anyio


def make_client(handler, **kwargs) -> RerankerClient:
    return RerankerClient(
        model="bge-reranker-v2-m3",
        api_base="https://api.example.com/v1",
        api_key="sk-test",
        transport=httpx.MockTransport(handler),
        **kwargs,
    )


def ok_handler(payload: dict, captured: list[httpx.Request] | None = None):
    def handler(request: httpx.Request) -> httpx.Response:
        if captured is not None:
            captured.append(request)
        return httpx.Response(200, json=payload)
    return handler


class TestExtractRerankResults:
    def test_cohere_jina_shape(self):
        """Cohere / Jina / SiliconFlow：顶层 results。"""
        payload = {
            "results": [
                {"index": 1, "relevance_score": 0.7},
                {"index": 0, "relevance_score": 0.9},
            ]
        }
        assert extract_rerank_results(payload) == [(0, 0.9), (1, 0.7)]

    def test_dashscope_nested_shape(self):
        """阿里云百炼：output.results。"""
        payload = {"output": {"results": [{"index": 0, "relevance_score": 0.42}]}}
        assert extract_rerank_results(payload) == [(0, 0.42)]

    def test_data_shape(self):
        payload = {"data": [{"index": 2, "score": 0.3}]}
        assert extract_rerank_results(payload) == [(2, 0.3)]

    def test_missing_results_returns_none(self):
        assert extract_rerank_results({"message": "ok"}) is None

    def test_non_dict_returns_none(self):
        assert extract_rerank_results([1, 2, 3]) is None
        assert extract_rerank_results("nope") is None

    def test_malformed_items_are_skipped(self):
        payload = {"results": [{"relevance_score": 0.5}, {"index": 1}, "junk",
                               {"index": 2, "relevance_score": 0.1}]}
        assert extract_rerank_results(payload) == [(2, 0.1)]

    def test_empty_results_returns_none(self):
        assert extract_rerank_results({"results": []}) is None

    def test_string_numbers_are_coerced(self):
        payload = {"results": [{"index": "0", "relevance_score": "0.75"}]}
        assert extract_rerank_results(payload) == [(0, 0.75)]


class TestRequestShape:
    async def test_payload_and_headers(self):
        captured: list[httpx.Request] = []
        client = make_client(ok_handler({"results": []}, captured))

        await client.rerank("查询文本", ["文档一", "文档二"], top_n=1)

        request = captured[0]
        assert str(request.url) == "https://api.example.com/v1/rerank"
        assert request.headers["Authorization"] == "Bearer sk-test"
        body = json.loads(request.content)
        assert body["model"] == "bge-reranker-v2-m3"
        assert body["query"] == "查询文本"
        assert body["documents"] == ["文档一", "文档二"]
        assert body["top_n"] == 1

    async def test_top_n_omitted_when_not_requested(self):
        captured: list[httpx.Request] = []
        client = make_client(ok_handler({"results": []}, captured))

        await client.rerank("q", ["d"])

        assert "top_n" not in json.loads(captured[0].content)

    async def test_api_base_trailing_slash_tolerated(self):
        captured: list[httpx.Request] = []
        client = RerankerClient(
            model="m", api_base="https://api.example.com/v1/", api_key="k",
            transport=httpx.MockTransport(ok_handler({"results": []}, captured)),
        )
        await client.rerank("q", ["d"])
        assert str(captured[0].url) == "https://api.example.com/v1/rerank"

    async def test_empty_documents_short_circuits(self):
        """空候选不发请求，直接返回空列表。"""
        captured: list[httpx.Request] = []
        client = make_client(ok_handler({"results": []}, captured))

        assert await client.rerank("q", []) == []
        assert captured == []


class TestRerankResults:
    async def test_sorted_by_score_descending(self):
        client = make_client(ok_handler({"results": [
            {"index": 0, "relevance_score": 0.1},
            {"index": 1, "relevance_score": 0.9},
            {"index": 2, "relevance_score": 0.5},
        ]}))
        result = await client.rerank("q", ["a", "b", "c"])
        assert result == [(1, 0.9), (2, 0.5), (0, 0.1)]

    async def test_top_n_truncates(self):
        client = make_client(ok_handler({"results": [
            {"index": 0, "relevance_score": 0.1},
            {"index": 1, "relevance_score": 0.9},
        ]}))
        assert await client.rerank("q", ["a", "b"], top_n=1) == [(1, 0.9)]

    async def test_out_of_range_index_filtered(self):
        client = make_client(ok_handler({"results": [
            {"index": 5, "relevance_score": 0.9},
            {"index": 0, "relevance_score": 0.2},
        ]}))
        assert await client.rerank("q", ["a"]) == [(0, 0.2)]

    async def test_negative_index_filtered(self):
        client = make_client(ok_handler({"results": [{"index": -1, "relevance_score": 0.9}]}))
        assert await client.rerank("q", ["a"]) == []


class TestFailureFallback:
    """所有失败路径都必须返回 None，让调用方回退原排序。"""

    async def test_http_error(self):
        def handler(request):
            return httpx.Response(500, json={"error": "boom"})
        assert await make_client(handler).rerank("q", ["a"]) is None

    async def test_unauthorized(self):
        def handler(request):
            return httpx.Response(401, json={"error": "bad key"})
        assert await make_client(handler).rerank("q", ["a"]) is None

    async def test_network_error(self):
        def handler(request):
            raise httpx.ConnectError("connection refused")
        assert await make_client(handler).rerank("q", ["a"]) is None

    async def test_invalid_json(self):
        def handler(request):
            return httpx.Response(200, content=b"<html>not json</html>")
        assert await make_client(handler).rerank("q", ["a"]) is None

    async def test_unparseable_payload(self):
        client = make_client(ok_handler({"unexpected": "shape"}))
        assert await client.rerank("q", ["a"]) is None

    async def test_timeout(self):
        def handler(request):
            raise httpx.ReadTimeout("too slow")
        assert await make_client(handler).rerank("q", ["a"]) is None


class TestCandidateMultiplier:
    def test_multiplier_is_at_least_two(self):
        """精排候选必须多于最终返回条数，否则精排无从选择。"""
        assert RERANK_CANDIDATE_MULTIPLIER >= 2


# ─── 阿里云百炼（DashScope）风格 ─────────────────────────────────────────────


class TestDetectPayloadStyle:
    @pytest.mark.parametrize("api_base", [
        "https://dashscope.aliyuncs.com",
        "https://dashscope.aliyuncs.com/api/v1",
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "https://dashscope-intl.aliyuncs.com/api/v1",
    ])
    def test_dashscope_domains(self, api_base):
        assert detect_payload_style(api_base) == PAYLOAD_STYLE_DASHSCOPE

    @pytest.mark.parametrize("api_base", [
        "https://api.siliconflow.cn/v1",
        "https://api.jina.ai/v1",
        "https://api.cohere.com/v1",
        "https://my-gateway.internal/v1",
    ])
    def test_other_providers_use_flat_body(self, api_base):
        assert detect_payload_style(api_base) == PAYLOAD_STYLE_COHERE

    def test_empty_base_defaults_to_cohere(self):
        assert detect_payload_style("") == PAYLOAD_STYLE_COHERE


class TestResolveDashscopeUrl:
    @pytest.mark.parametrize("api_base", [
        "https://dashscope.aliyuncs.com",
        "https://dashscope.aliyuncs.com/api/v1",
        "https://dashscope.aliyuncs.com/api/v1/",
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
    ])
    def test_all_base_forms_normalize(self, api_base):
        assert resolve_dashscope_rerank_url(api_base) == (
            "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank"
        )

    def test_intl_domain_preserved(self):
        assert resolve_dashscope_rerank_url("https://dashscope-intl.aliyuncs.com/api/v1").startswith(
            "https://dashscope-intl.aliyuncs.com/"
        )


class TestDashscopePayload:
    def test_nested_input_and_parameters(self):
        """百炼要求 input/parameters 嵌套；扁平 body 会被 400 拒绝。"""
        client = RerankerClient(model="qwen3-rerank", api_base="https://dashscope.aliyuncs.com/api/v1", api_key="k")
        payload = client.build_payload("查询", ["文档一", "文档二"], top_n=1)

        assert payload["model"] == "qwen3-rerank"
        assert payload["input"] == {"query": "查询", "documents": ["文档一", "文档二"]}
        assert payload["parameters"]["top_n"] == 1
        assert payload["parameters"]["return_documents"] is False
        assert "query" not in payload, "不得同时出现扁平字段"

    def test_flat_body_for_cohere_style(self):
        client = RerankerClient(model="bge-reranker-v2-m3", api_base="https://api.siliconflow.cn/v1", api_key="k")
        payload = client.build_payload("查询", ["文档"], top_n=2)
        assert payload["query"] == "查询"
        assert payload["documents"] == ["文档"]
        assert payload["top_n"] == 2
        assert "input" not in payload

    def test_explicit_style_overrides_detection(self):
        client = RerankerClient(
            model="m", api_base="https://dashscope.aliyuncs.com/api/v1", api_key="k",
            payload_style=PAYLOAD_STYLE_COHERE,
        )
        assert client.payload_style == PAYLOAD_STYLE_COHERE
        assert str(client._url).endswith("/api/v1/rerank")

    async def test_request_goes_to_native_endpoint(self):
        captured: list[httpx.Request] = []

        def handler(request):
            captured.append(request)
            return httpx.Response(200, json={"output": {"results": [
                {"index": 1, "relevance_score": 0.91},
                {"index": 0, "relevance_score": 0.12},
            ]}})

        client = RerankerClient(
            model="qwen3-rerank",
            api_base="https://dashscope.aliyuncs.com/compatible-mode/v1",
            api_key="sk-test",
            transport=httpx.MockTransport(handler),
        )
        result = await client.rerank("查询", ["甲", "乙"], top_n=2)

        assert str(captured[0].url) == (
            "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank"
        )
        body = json.loads(captured[0].content)
        assert body["input"]["query"] == "查询"
        assert result == [(1, 0.91), (0, 0.12)]

    async def test_top_n_absent_from_parameters_when_not_requested(self):
        captured: list[httpx.Request] = []

        def handler(request):
            captured.append(request)
            return httpx.Response(200, json={"output": {"results": [
                {"index": 0, "relevance_score": 0.5},
            ]}})

        client = RerankerClient(
            model="qwen3-rerank", api_base="https://dashscope.aliyuncs.com/api/v1",
            api_key="k", transport=httpx.MockTransport(handler),
        )
        await client.rerank("查询", ["甲"])
        body = json.loads(captured[0].content)
        assert "top_n" not in body["parameters"]

    async def test_dashscope_failure_returns_none(self):
        """百炼返回 400（如模型名写错）时必须回退而不是崩。"""
        def handler(request):
            return httpx.Response(400, json={
                "code": "InvalidParameter",
                "message": "Field required: input.query",
            })

        client = RerankerClient(
            model="bad-model", api_base="https://dashscope.aliyuncs.com/api/v1",
            api_key="k", transport=httpx.MockTransport(handler),
        )
        assert await client.rerank("查询", ["甲"]) is None
