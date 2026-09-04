"""进程内通知事件总线：负责持久化与在线用户实时推送."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class NotificationEvent:
    """通知事件：user_id 用于定位单用户推送队列."""

    user_id: str
    type: str
    title: str
    content: str = ""
    level: str = "info"
    link: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    source: str = "notification"


NotificationHandler = Callable[[NotificationEvent], Awaitable[Any]]


class NotificationBus:
    """通知事件总线."""

    _handlers: list[NotificationHandler] = []
    _user_queues: dict[str, asyncio.Queue[NotificationEvent]] = {}

    @classmethod
    def subscribe(cls, handler: NotificationHandler) -> None:
        """注册持久化处理器（每个事件写一条用户通知）."""
        if handler not in cls._handlers:
            cls._handlers.append(handler)

    @classmethod
    async def publish(cls, event: NotificationEvent) -> None:
        """发布并持久化单用户通知，同时推送到在线队列."""
        for handler in cls._handlers:
            try:
                await handler(event)
            except Exception:
                logger.exception("NotificationBus handler error")
        cls.deliver_to_users([event.user_id], event)

    @classmethod
    def online_user_ids(cls) -> list[str]:
        """返回当前 SSE 在线用户 ID 列表."""
        return list(cls._user_queues.keys())

    @classmethod
    def deliver_to_users(
        cls, user_ids: list[str], event: NotificationEvent
    ) -> None:
        """仅推送到指定用户的在线 SSE 队列，不触发持久化."""
        for user_id in user_ids:
            queue = cls._user_queues.get(user_id)
            if queue is None:
                continue
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                logger.warning("User %s queue full", user_id)

    @classmethod
    def register_user(cls, user_id: str) -> asyncio.Queue[NotificationEvent]:
        """注册用户在线队列并返回."""
        queue: asyncio.Queue[NotificationEvent] = asyncio.Queue(maxsize=256)
        cls._user_queues[user_id] = queue
        return queue

    @classmethod
    def unregister_user(cls, user_id: str) -> None:
        """移除用户在线队列."""
        cls._user_queues.pop(user_id, None)
