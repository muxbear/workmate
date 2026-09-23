"""重排序（Reranker）客户端——对召回结果做二次精排。

此前 ``enable_reranker`` / ``reranker_model`` 只是配置项与 UI 装饰，检索链路
完全没有精排环节。本模块实现真正的精排调用：

1. 混合/向量检索先召回 ``top_k * RERANK_CANDIDATE_MULTIPLIER`` 个候选；
2. 把候选文本交给 rerank 模型（cross-encoder）逐条打分；
3. 按模型打分重排并截断到 ``top_k``。

Rerank 接口在不同厂商间**不是** OpenAI 兼容格式，本模块支持两种请求风格：

===========================  ===========================================================
payload_style                调用方式
===========================  ===========================================================
``cohere``（默认）            ``POST {api_base}/rerank``，扁平 body
                              ``{"model", "query", "documents", "top_n"}``
                              —— Cohere / Jina / 硅基流动
``dashscope``                  ``POST {base}/api/v1/services/rerank/text-rerank/text-rerank``
                              嵌套 body ``{"model", "input": {"query", "documents"},
                              "parameters": {"top_n"}}``
                              —— 阿里云百炼（扁平 body 会被 400 拒绝）
===========================  ===========================================================

``api_base`` 命中 DashScope 域名时自动选用 ``dashscope`` 风格（与
``core.rag.embedding`` 判定 DashScope 的方式一致），也可显式传入覆盖。

响应解析同时兼容 ``results`` / ``output.results`` / ``data`` 三种包裹。任何异常都
返回 ``None``，由调用方回退到原顺序——精排失败不应让整次检索失败。
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT_SECONDS = 30.0

#: 精排候选倍数——召回 4 倍候选再精排，平衡效果与 token 成本
RERANK_CANDIDATE_MULTIPLIER = 4

PAYLOAD_STYLE_COHERE = "cohere"
PAYLOAD_STYLE_DASHSCOPE = "dashscope"

_DASHSCOPE_API_VERSION = "/api/v1"
_DASHSCOPE_RERANK_PATH = "/services/rerank/text-rerank/text-rerank"
_DASHSCOPE_COMPATIBLE_SUFFIXES = ("/compatible-mode/v1", "/compatible-mode")


def detect_payload_style(api_base: str) -> str:
    """按 api_base 猜测请求风格：DashScope 域名用嵌套 body，其余用扁平 body。"""
    base = (api_base or "").lower()
    if "dashscope" in base or "aliyuncs" in base:
        return PAYLOAD_STYLE_DASHSCOPE
    return PAYLOAD_STYLE_COHERE


def resolve_dashscope_rerank_url(api_base: str) -> str:
    """把各种 DashScope base 归一到原生 rerank 端点。

    兼容三种配置写法::

        https://dashscope.aliyuncs.com
        https://dashscope.aliyuncs.com/api/v1
        https://dashscope.aliyuncs.com/compatible-mode/v1   # 兼容模式入口不提供原生 rerank
    """
    base = (api_base or "").rstrip("/")
    for suffix in _DASHSCOPE_COMPATIBLE_SUFFIXES:
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    if not base.endswith(_DASHSCOPE_API_VERSION):
        base = f"{base}{_DASHSCOPE_API_VERSION}"
    return f"{base}{_DASHSCOPE_RERANK_PATH}"


def extract_rerank_results(payload: Any) -> list[tuple[int, float]] | None:
    """从各厂商的响应体中提取 ``(原下标, 相关度)`` 列表。

    支持的包裹形式::

        {"results": [{"index": 0, "relevance_score": 0.9}]}      # Cohere / Jina
        {"output": {"results": [...]}}                           # 阿里云百炼
        {"data": [{"index": 0, "relevance_score": 0.9}]}         # 部分自建服务

    Returns:
        按下标升序排列的 ``(index, score)``；无法解析时返回 ``None``。
    """
    if not isinstance(payload, dict):
        return None

    results: Any = payload.get("results")
    if results is None:
        output = payload.get("output")
        if isinstance(output, dict):
            results = output.get("results")
    if results is None:
        results = payload.get("data")
    if not isinstance(results, list):
        return None

    parsed: list[tuple[int, float]] = []
    for item in results:
        if not isinstance(item, dict):
            continue
        index = item.get("index", item.get("document_index"))
        score = item.get("relevance_score", item.get("score"))
        if index is None or score is None:
            continue
        try:
            parsed.append((int(index), float(score)))
        except (TypeError, ValueError):
            continue

    if not parsed:
        return None
    parsed.sort(key=lambda pair: pair[0])
    return parsed


class RerankerClient:
    """调用 rerank 接口的轻量客户端。

    Args:
        model: rerank 模型名，例如 ``qwen3-rerank``、``BAAI/bge-reranker-v2-m3``。
        api_base: 提供商 API 根地址。
        api_key: API 密钥。
        timeout: 单次请求超时（秒）。
        transport: 可注入的 httpx 传输层，便于离线测试。
        payload_style: 请求体风格；缺省按 ``api_base`` 自动判定
            （见 :func:`detect_payload_style`）。
    """

    def __init__(
        self,
        model: str,
        api_base: str,
        api_key: str,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        transport: httpx.AsyncBaseTransport | None = None,
        payload_style: str | None = None,
    ) -> None:
        self.model = model
        self._api_base = api_base
        self._api_key = api_key
        self._timeout = timeout
        self._transport = transport
        self.payload_style = payload_style or detect_payload_style(api_base)
        self._url = (
            resolve_dashscope_rerank_url(api_base)
            if self.payload_style == PAYLOAD_STYLE_DASHSCOPE
            else f"{api_base.rstrip('/')}/rerank"
        )

    def build_payload(
        self, query: str, documents: list[str], top_n: int | None = None,
    ) -> dict[str, Any]:
        """按当前风格构造请求体。"""
        if self.payload_style == PAYLOAD_STYLE_DASHSCOPE:
            parameters: dict[str, Any] = {"return_documents": False}
            if top_n is not None:
                parameters["top_n"] = top_n
            return {
                "model": self.model,
                "input": {"query": query, "documents": documents},
                "parameters": parameters,
            }

        payload: dict[str, Any] = {
            "model": self.model,
            "query": query,
            "documents": documents,
        }
        if top_n is not None:
            payload["top_n"] = top_n
        return payload

    async def rerank(
        self, query: str, documents: list[str], top_n: int | None = None,
    ) -> list[tuple[int, float]] | None:
        """对候选文档精排。

        Args:
            query: 用户查询。
            documents: 候选文本列表。
            top_n: 期望返回条数；``None`` 表示全部。

        Returns:
            按得分降序的 ``(documents 中的下标, 相关度)``；调用失败返回 ``None``。
        """
        if not documents:
            return []

        payload = self.build_payload(query, documents, top_n)

        try:
            async with httpx.AsyncClient(
                timeout=self._timeout, transport=self._transport,
            ) as client:
                response = await client.post(
                    self._url,
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
                response.raise_for_status()
                data = response.json()
        except Exception:
            logger.warning("Rerank 调用失败（model=%s），回退原排序", self.model, exc_info=True)
            return None

        parsed = extract_rerank_results(data)
        if parsed is None:
            logger.warning("Rerank 响应无法解析（model=%s）: %s", self.model, str(data)[:200])
            return None

        valid = [(idx, score) for idx, score in parsed if 0 <= idx < len(documents)]
        valid.sort(key=lambda pair: pair[1], reverse=True)
        if top_n is not None:
            valid = valid[:top_n]
        return valid
