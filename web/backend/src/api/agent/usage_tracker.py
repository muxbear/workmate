"""ChatUsage 记录工具——在 chat 流程结束时写入审计记录."""

from __future__ import annotations

import logging
import time
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from db.models.chat_usage import ChatUsage

logger = logging.getLogger(__name__)


def extract_usage_metadata(result: Any) -> dict[str, int]:
    """从 LangGraph 结果中提取 usage_metadata.

    查找 messages 列表中最后一条 AIMessage 的 usage_metadata 字段。
    """
    messages = None
    if isinstance(result, dict):
        messages = result.get("messages", [])
    elif hasattr(result, "messages"):
        messages = result.messages

    if not messages:
        return {}

    # 从后往前找第一条带 usage_metadata 的 AIMessage
    for msg in reversed(messages):
        usage = getattr(msg, "usage_metadata", None)
        if usage and isinstance(usage, dict):
            return {
                "prompt_tokens": usage.get("input_tokens", 0),
                "completion_tokens": usage.get("output_tokens", 0),
                "total_tokens": usage.get("total_tokens", 0),
            }
    return {}


async def record_chat_usage(
    db: AsyncSession,
    user_id: str,
    thread_id: str,
    start_time: float,
    result: Any = None,
    status: str = "success",
    provider_id: str | None = None,
    model_id: str | None = None,
    agent_name: str | None = None,
) -> None:
    """记录一次对话调用的审计信息.

    Args:
        db: 数据库会话。
        user_id: 用户 ID。
        thread_id: 会话线程 ID。
        start_time: 请求开始时间戳（time.time()）。
        result: LangGraph 返回结果（用于提取 token 用量）。
        status: success / error。
        provider_id: 模型提供商 ID（可选）。
        model_id: 模型 ID（可选）。
        agent_name: 代理名称（可选）。
    """
    try:
        usage = extract_usage_metadata(result) if result else {}
        duration_ms = int((time.time() - start_time) * 1000)

        record = ChatUsage(
            user_id=user_id,
            thread_id=thread_id,
            provider_id=provider_id,
            model_id=model_id,
            agent_name=agent_name,
            prompt_tokens=usage.get("prompt_tokens", 0),
            completion_tokens=usage.get("completion_tokens", 0),
            total_tokens=usage.get("total_tokens", 0),
            duration_ms=duration_ms,
            status=status,
        )
        db.add(record)
        await db.commit()
    except Exception:
        logger.exception("Failed to record chat usage")
        await db.rollback()
