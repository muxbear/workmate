"""轻量 LLM 对话客户端——供索引链路内部使用（如 Agentic 切片的边界判断）。

只走 OpenAI 兼容的 ``POST {api_base}/chat/completions``，不引入 langchain 依赖，
便于单测注入 ``httpx`` 传输层。模型与凭据来自「模型」页面（见
``api.knowledge_base.model_provider``），不读环境变量。
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT_SECONDS = 60.0


class ChatClient:
    """最小可用的聊天补全客户端。

    Args:
        model: 模型名。
        api_base: 提供商 API 根地址（不含 ``/chat/completions``）。
        api_key: API 密钥。
        timeout: 单次请求超时（秒）。
        transport: 可注入的 httpx 传输层，便于离线测试。
    """

    def __init__(
        self,
        model: str,
        api_base: str,
        api_key: str,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.model = model
        self._url = f"{api_base.rstrip('/')}/chat/completions"
        self._api_key = api_key
        self._timeout = timeout
        self._transport = transport

    async def acomplete(self, prompt: str, system: str | None = None) -> str | None:
        """发送单轮对话请求。

        Args:
            prompt: 用户消息。
            system: 系统消息（可选）。

        Returns:
            模型返回的文本；调用失败或响应缺字段时返回 ``None``。
        """
        messages: list[dict[str, str]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

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
                    json={"model": self.model, "messages": messages},
                )
                response.raise_for_status()
                data = response.json()
        except Exception:
            logger.warning("LLM 调用失败（model=%s）", self.model, exc_info=True)
            return None

        return extract_message_content(data)


def extract_message_content(payload: Any) -> str | None:
    """从 OpenAI 兼容响应体中取出首条回复文本。"""
    if not isinstance(payload, dict):
        return None
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    first = choices[0]
    if not isinstance(first, dict):
        return None
    message = first.get("message")
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    if isinstance(content, str):
        return content
    # 部分服务返回分段内容数组
    if isinstance(content, list):
        parts = [
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and part.get("type") in (None, "text")
        ]
        return "".join(parts) or None
    return None
