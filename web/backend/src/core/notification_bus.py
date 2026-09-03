from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class NotificationEvent:
    user_id: str
    type: str
    title: str
    content: str = ""
    level: str = "info"
    link: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


class NotificationBus:
    _handlers: list = []
    _user_queues: dict[str, asyncio.Queue] = {}

    @classmethod
    def subscribe(cls, handler) -> None:
        if handler not in cls._handlers:
            cls._handlers.append(handler)

    @classmethod
    async def publish(cls, event: NotificationEvent) -> None:
        for handler in cls._handlers:
            try:
                await handler(event)
            except Exception:
                logger.exception("NotificationBus handler error")
        queue = cls._user_queues.get(event.user_id)
        if queue is not None:
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                logger.warning("User %s queue full", event.user_id)

    @classmethod
    def register_user(cls, user_id: str) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=256)
        cls._user_queues[user_id] = queue
        return queue

    @classmethod
    def unregister_user(cls, user_id: str) -> None:
        cls._user_queues.pop(user_id, None)
