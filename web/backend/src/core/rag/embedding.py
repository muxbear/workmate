"""Embedding 模型工厂。

对 DashScope 等非 OpenAI 原生 API，使用 httpx 直接调用以避免
OpenAIEmbeddings 自动 tokenize 输入（tiktoken）或从 HuggingFace 下载 tokenizer。
"""

from __future__ import annotations

import asyncio
import logging
import random
from collections.abc import Awaitable, Callable

import httpx

from core.metrics import KB_EMBEDDING_CALLS

logger = logging.getLogger(__name__)

#: 单批向量化完成后的回调：(起始下标, 本批文本, 本批向量)。
#: 供索引流水线"embed 一批、写一批"，避免全量向量驻留内存。
BatchCallback = Callable[[int, list[str], list[list[float]]], Awaitable[None]]


class _DashScopeEmbeddings:
    """DashScope Embedding 模型（兼容 OpenAI API 格式的文本向量化）。

    直接使用 httpx 发送原始文本，避免 OpenAIEmbeddings 的 tokenize 行为。
    DashScope API 单次批量上限 10 条，自动分批。

    **并发 + 重试**：此前是串行 for 循环、无任何重试——一批失败整篇文档就得从头再来，
    而限流（429）在批量索引时是常态而非异常。现在按信号量并发发送若干批，遇到
    429/5xx/网络错误指数退避重试（尊重 ``Retry-After``），重试用尽才向上抛。
    """

    _BATCH_SIZE = 10  # DashScope 兼容模式 API 限制
    #: 并发批次上限——取值偏保守：DashScope 对并发有配额，而并发过高触发限流后
    #: 反而要靠退避等待，吞吐未必更高。可通过构造参数覆盖。
    _DEFAULT_CONCURRENCY = 4
    #: 单批请求超时（秒）
    _TIMEOUT = 120.0
    #: 可重试的 HTTP 状态：限流与**服务端瞬时故障**（4xx 里的 400/401 重试无意义）
    _RETRYABLE_STATUS = frozenset({408, 429, 500, 502, 503, 504})
    _MAX_RETRIES = 4
    _BACKOFF_BASE = 1.0
    _BACKOFF_CAP = 30.0

    def __init__(
        self,
        model: str,
        api_base: str,
        api_key: str,
        dimensions: int | None = None,
        *,
        concurrency: int | None = None,
        max_retries: int | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.model = model
        self._base = api_base.rstrip("/")
        self._key = api_key
        self._dimensions = dimensions
        self._concurrency = max(1, concurrency or self._DEFAULT_CONCURRENCY)
        self._max_retries = (
            self._MAX_RETRIES if max_retries is None else max(0, max_retries)
        )
        #: 可注入的传输层（测试用），生产为 None
        self._transport = transport

    async def _embed_batch(self, texts: list[str], client: httpx.AsyncClient) -> list[list[float]]:
        """发送单次 embedding 请求（≤_BATCH_SIZE 条）。"""
        payload: dict = {"model": self.model, "input": texts}
        if self._dimensions:
            payload["dimensions"] = self._dimensions

        resp = await client.post(
            f"{self._base}/embeddings",
            headers={
                "Authorization": f"Bearer {self._key}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
        resp.raise_for_status()
        data = resp.json()
        if "data" not in data:
            raise RuntimeError(f"Embedding API error: {data}")
        return [item["embedding"] for item in data["data"]]

    def _retry_delay(self, attempt: int, response: httpx.Response | None) -> float:
        """下一次重试前的等待时长。

        优先用服务端给的 ``Retry-After``（限流场景下它才是正确的等待时间），
        否则指数退避并加抖动——固定间隔会让并发批次"同时醒来"再次撞上限流。
        """
        if response is not None:
            header = response.headers.get("Retry-After")
            if header:
                try:
                    return min(float(header), self._BACKOFF_CAP)
                except ValueError:
                    pass
        delay = min(self._BACKOFF_BASE * (2 ** attempt), self._BACKOFF_CAP)
        return delay * (0.5 + random.random() / 2)

    async def _embed_batch_with_retry(
        self, texts: list[str], client: httpx.AsyncClient,
    ) -> list[list[float]]:
        """带退避重试的单批向量化（失败计入指标：embedding 是索取的付费上游）。"""
        last_error: Exception | None = None
        for attempt in range(self._max_retries + 1):
            response: httpx.Response | None = None
            try:
                return await self._embed_batch(texts, client)
            except httpx.HTTPStatusError as exc:
                response = exc.response
                if response.status_code not in self._RETRYABLE_STATUS:
                    raise
                last_error = exc
            except (httpx.TransportError, httpx.TimeoutException) as exc:
                last_error = exc

            if attempt >= self._max_retries:
                break
            delay = self._retry_delay(attempt, response)
            logger.warning(
                "Embedding 请求失败（第 %d 次尝试），%.1fs 后重试：%s",
                attempt + 1, delay, last_error,
            )
            await asyncio.sleep(delay)

        KB_EMBEDDING_CALLS.labels(result="failed").inc()
        raise RuntimeError(
            f"Embedding 调用重试 {self._max_retries} 次后仍失败：{last_error}"
        )

    async def aembed_documents(
        self, texts: list[str], on_batch: BatchCallback | None = None,
    ) -> list[list[float]]:
        """批量向量化文本——分片后**并发**发送，遇限流自动退避。

        Args:
            texts: 待向量化文本。
            on_batch: 每批完成后的异步回调（``start_index, batch_texts, vectors``）。
                索引流水线用它"embed 一批、写一批"，把峰值内存从"全量向量"降到
                "单批向量"（1024 维 float 约 8KB/片，10 万片就是 800MB）。

        Returns:
            与 ``texts`` 等长的向量列表，**顺序与输入一致**（并发不改变顺序）。
        """
        if not texts:
            return []

        batches = [
            texts[i:i + self._BATCH_SIZE]
            for i in range(0, len(texts), self._BATCH_SIZE)
        ]
        results: list[list[list[float]]] = [[] for _ in batches]
        semaphore = asyncio.Semaphore(self._concurrency)

        async with httpx.AsyncClient(
            timeout=self._TIMEOUT, transport=self._transport,
        ) as client:
            async def run(index: int, batch: list[str]) -> None:
                # 回调放在信号量内：写入很慢时不该继续放行新的批次，
                # 否则"待写入的向量"会重新堆满内存，白做分批
                async with semaphore:
                    vectors = await self._embed_batch_with_retry(batch, client)
                    KB_EMBEDDING_CALLS.labels(result="success").inc()
                    results[index] = vectors
                    if on_batch is not None:
                        await on_batch(index * self._BATCH_SIZE, batch, vectors)

            await asyncio.gather(*(
                run(index, batch) for index, batch in enumerate(batches)
            ))

        logger.debug("Embedded %d texts in %d batches", len(texts), len(batches))
        return [vector for batch_vectors in results for vector in batch_vectors]

    async def aembed_query(self, text: str) -> list[float]:
        """单条文本向量化。"""
        results = await self.aembed_documents([text])
        return results[0]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        """同步向量化（内部调用异步版）。

        安全处理已在运行的事件循环的情况。
        """
        import asyncio
        import concurrent.futures

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(self.aembed_documents(texts))
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(asyncio.run, self.aembed_documents(texts))
                return future.result()

    def embed_query(self, text: str) -> list[float]:
        """同步单条向量化。"""
        import asyncio
        import concurrent.futures

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(self.aembed_query(text))
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(asyncio.run, self.aembed_query(text))
                return future.result()


def get_embedding_model(model_name: str, api_base: str, api_key: str,
                        dimensions: int | None = None, **kwargs):
    """获取 Embedding 模型实例。

    对 DashScope API 使用 httpx 直接调用（避免 OpenAIEmbeddings 的 tokenize 问题）。
    对 OpenAI 原生 API 使用 langchain_openai.OpenAIEmbeddings。
    """
    if "dashscope" in api_base:
        return _DashScopeEmbeddings(
            model=model_name,
            api_base=api_base,
            api_key=api_key,
            dimensions=dimensions,
        )

    from langchain_openai import OpenAIEmbeddings
    from pydantic import SecretStr

    return OpenAIEmbeddings(
        model=model_name,
        base_url=api_base,
        api_key=SecretStr(api_key),
        dimensions=dimensions,
        **kwargs,
    )
