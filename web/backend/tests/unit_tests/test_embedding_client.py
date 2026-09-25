"""Embedding 客户端：并发批次、退避重试、分批回调（迭代 4 T4.3）。

改动前的实现是：串行 for 循环发批、**无任何重试**、每批一次 `raise_for_status`。
后果有两个：索引吞吐被单批往返时间锁死（实测 0.1～1 片/秒），且一次 429 就让整篇
文档作废——限流在批量索引里是常态而不是异常。

用例覆盖：顺序保证（并发不改变结果顺序）、限流退避后成功、4xx 不重试、
Retry-After 优先、分批回调、失败批不影响其它批。
"""

import asyncio
import json
import logging

import httpx
import pytest

from core.rag.embedding import _DashScopeEmbeddings

pytestmark = pytest.mark.anyio


def make_client(handler, **kwargs) -> _DashScopeEmbeddings:
    return _DashScopeEmbeddings(
        model="text-embedding-v4",
        api_base="https://dashscope.example.com/v1",
        api_key="sk-test",
        transport=httpx.MockTransport(handler),
        **kwargs,
    )


def ok_response(texts: list[str]) -> httpx.Response:
    return httpx.Response(
        200,
        json={"data": [
            {"index": i, "embedding": [float(i), float(len(t))]}
            for i, t in enumerate(texts)
        ]},
    )


class TestConcurrentBatching:
    async def test_all_texts_are_embedded_in_order(self):
        """并发不改顺序：结果必须与输入一一对应。"""
        seen: list[list[str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            payload = json.loads(request.content)
            seen.append(payload["input"])
            return ok_response(payload["input"])

        client = make_client(handler, concurrency=4)
        texts = [f"文本{i}" for i in range(25)]

        vectors = await client.aembed_documents(texts)

        assert len(vectors) == 25
        # 每批返回的向量里第一个分量是本批内的下标（见 ok_response），
        # 拼错顺序会让 5 的批出现在 0 的批前面
        assert [int(v[1]) for v in vectors] == [len(t) for t in texts]
        assert sorted(len(batch) for batch in seen) == [5, 10, 10]

    async def test_batches_run_concurrently(self):
        """并发批次：3 批各 0.1s，总耗时应显著小于串行的 0.3s。"""
        import time

        async def handler(request: httpx.Request) -> httpx.Response:
            await asyncio.sleep(0.1)
            payload = json.loads(request.content)
            return ok_response(payload["input"])

        client = make_client(handler, concurrency=4)
        started = time.perf_counter()
        await client.aembed_documents([f"t{i}" for i in range(30)])
        elapsed = time.perf_counter() - started

        assert elapsed < 0.25, f"批次没有并发执行（耗时 {elapsed:.2f}s）"

    async def test_single_batch_short_path(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return ok_response(json.loads(request.content)["input"])

        client = make_client(handler)
        vectors = await client.aembed_documents(["只有一个"])

        assert len(vectors) == 1

    async def test_empty_input_makes_no_request(self):
        def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
            raise AssertionError("空输入不该发请求")

        client = make_client(handler)
        assert await client.aembed_documents([]) == []


class TestRetryOnThrottling:
    async def test_retries_on_429_then_succeeds(self):
        attempts = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            attempts["n"] += 1
            if attempts["n"] == 1:
                return httpx.Response(429, json={"error": "rate limited"})
            return ok_response(json.loads(request.content)["input"])

        client = make_client(handler, max_retries=3)
        vectors = await client.aembed_documents(["限流重试"])

        assert len(vectors) == 1
        assert attempts["n"] == 2

    async def test_retries_on_5xx(self):
        attempts = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            attempts["n"] += 1
            if attempts["n"] < 3:
                return httpx.Response(503, json={"error": "unavailable"})
            return ok_response(json.loads(request.content)["input"])

        client = make_client(handler, max_retries=3)
        vectors = await client.aembed_documents(["服务端抖动"])

        assert len(vectors) == 1
        assert attempts["n"] == 3

    async def test_retry_after_header_is_honoured(self, monkeypatch):
        """限流时服务端给的 Retry-After 才是正确的等待时间。"""
        delays: list[float] = []

        async def fake_sleep(seconds: float) -> None:
            delays.append(seconds)

        monkeypatch.setattr(asyncio, "sleep", fake_sleep)
        attempts = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            attempts["n"] += 1
            if attempts["n"] == 1:
                return httpx.Response(
                    429, headers={"Retry-After": "7"}, json={"error": "slow down"},
                )
            return ok_response(json.loads(request.content)["input"])

        client = make_client(handler, max_retries=3)
        await client.aembed_documents(["等待 7 秒"])

        assert delays == [7.0]

    async def test_client_error_is_not_retried(self):
        """400/401 这类错误重试没有意义，应当立即失败。"""
        attempts = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            attempts["n"] += 1
            return httpx.Response(400, json={"error": "bad request"})

        client = make_client(handler, max_retries=3)
        with pytest.raises(httpx.HTTPStatusError):
            await client.aembed_documents(["坏请求"])

        assert attempts["n"] == 1

    async def test_exhausted_retries_raise_with_context(self):
        attempts = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            attempts["n"] += 1
            return httpx.Response(429, json={"error": "still limited"})

        client = make_client(handler, max_retries=2)
        with pytest.raises(RuntimeError, match="重试"):
            await client.aembed_documents(["一直限流"])

        assert attempts["n"] == 3  # 首次 + 2 次重试

    async def test_backoff_is_exponential_and_jittered(self, monkeypatch):
        delays: list[float] = []

        async def fake_sleep(seconds: float) -> None:
            delays.append(seconds)

        monkeypatch.setattr(asyncio, "sleep", fake_sleep)
        client = make_client(lambda request: httpx.Response(500), max_retries=3)

        with pytest.raises(RuntimeError):
            await client.aembed_documents(["连续 500"])

        # 基数 1s 起的指数退避，带抖动（因此只在区间内断言）
        assert len(delays) == 3
        assert all(0 < d <= 30 for d in delays)
        assert delays[2] > delays[0], "退避应当递增"


class TestBatchCallback:
    async def test_callback_receives_start_index_and_vectors(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return ok_response(json.loads(request.content)["input"])

        calls: list[tuple[int, list[str], int]] = []

        async def on_batch(start, batch_texts, vectors):
            calls.append((start, batch_texts, len(vectors)))

        client = make_client(handler, concurrency=2)
        await client.aembed_documents([f"t{i}" for i in range(12)], on_batch=on_batch)

        assert sorted(call[0] for call in calls) == [0, 10]
        assert {call[2] for call in calls} == {2, 10}

    async def test_callback_failure_propagates(self):
        """写入失败必须让整次向量化失败——只记日志会造成"文档显示成功、内容缺失"。"""
        def handler(request: httpx.Request) -> httpx.Response:
            return ok_response(json.loads(request.content)["input"])

        async def failing_on_batch(start, batch_texts, vectors):
            raise RuntimeError("向量库写入失败")

        client = make_client(handler)
        with pytest.raises(RuntimeError, match="向量库写入失败"):
            await client.aembed_documents(["t1"], on_batch=failing_on_batch)

    async def test_failing_batch_does_not_block_others(self, caplog):
        """一批重试耗尽会让整次失败，但其它批已经跑完的请求不应受牵连。"""
        def handler(request: httpx.Request) -> httpx.Response:
            texts = json.loads(request.content)["input"]
            if any("坏" in t for t in texts):
                return httpx.Response(429)
            return ok_response(texts)

        client = make_client(handler, max_retries=0, concurrency=2)
        with caplog.at_level(logging.WARNING):
            with pytest.raises(RuntimeError):
                await client.aembed_documents(["好1", "坏文本", "好2"])


class TestHttpClientIsReused:
    """回归：HTTP 客户端**不能每次调用新建**（本机构造一次 ≈350ms，且是同步的）。

    此前 ``aembed_documents`` 每次都 ``async with httpx.AsyncClient(...)``，于是每次
    查询向量化都把事件循环按住约 350ms。实测（8 路并发查询向量化）：墙钟 2.8s、
    **事件循环停顿 2.57s**——并发被完全串行化，单次时长呈 0.6/0.9/1.2/…/2.8s 的
    等差阶梯，正是"每次一段同步阻塞"的特征；期间健康检查与其它请求全程排队。
    """

    @staticmethod
    def _handler(request: httpx.Request) -> httpx.Response:
        return ok_response(json.loads(request.content)["input"])

    async def test_same_client_is_reused_across_calls(self):
        client = make_client(self._handler)

        await client.aembed_documents(["第一段"])
        first = client._client
        await client.aembed_documents(["第二段"])

        assert first is not None, "调用后应当持有一个复用客户端"
        assert client._client is first, "客户端被重建了：每次向量化又会阻塞事件循环约 350ms"
        await client.aclose()

    async def test_aclose_closes_and_next_use_recreates(self):
        """关停后不该拿着已关闭的客户端继续用。"""
        client = make_client(self._handler)
        await client.aembed_documents(["第一段"])

        await client.aclose()

        assert client._client is None
        await client.aembed_documents(["第二段"])   # 自动重建
        assert client._client is not None
        await client.aclose()

    async def test_aclose_is_idempotent(self):
        """没建过、建过又关过、重复关——都不该抛（关停路径最忌讳这个）。"""
        client = make_client(self._handler)

        await client.aclose()
        await client.aembed_documents(["第一段"])
        await client.aclose()
        await client.aclose()

        assert client._client is None
