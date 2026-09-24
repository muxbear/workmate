"""索引进度事件总线——按知识库维度推送文档状态变更。

前端此前只能每 5 秒轮询一次文档列表，且轮询只刷新文档、不刷新知识库计数。这里
提供进程内的轻量事件流（与 ``core.notification_bus`` 同一套写法），由
``GET /api/knowledge-bases/{kb_id}/indexing/stream`` 以 SSE 转发给页面。

设计要点：

- **按 kb_id 订阅**：前端只在打开某个知识库的文档页时订阅，多个页面互不干扰；
- **只推送变更，不存历史**：订阅者连接后应先自己拉一次列表，再用事件增量更新；
- **丢事件可接受**：队列满或无人订阅时直接丢弃（进度是幂等的状态快照，
  下一次事件或一次轮询即可纠正）。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)

#: 每个知识库最多缓存的事件数——超出即丢弃（前端会自行兜底重拉）
_QUEUE_SIZE = 128


class IndexingEventBus:
    """按 kb_id 分组的进程内事件总线。"""

    _queues: dict[str, list[asyncio.Queue[dict[str, Any]]]] = {}

    @classmethod
    def subscribe(cls, kb_id: str) -> asyncio.Queue[dict[str, Any]]:
        """注册订阅者并返回其事件队列。"""
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=_QUEUE_SIZE)
        cls._queues.setdefault(kb_id, []).append(queue)
        logger.debug("索引事件订阅 kb=%s 订阅者=%d", kb_id, len(cls._queues[kb_id]))
        return queue

    @classmethod
    def unsubscribe(cls, kb_id: str, queue: asyncio.Queue[dict[str, Any]]) -> None:
        """移除订阅者；最后一个订阅者离开时清理该知识库的条目。"""
        subscribers = cls._queues.get(kb_id)
        if not subscribers:
            return
        try:
            subscribers.remove(queue)
        except ValueError:
            return
        if not subscribers:
            cls._queues.pop(kb_id, None)

    @classmethod
    def publish(cls, kb_id: str, payload: dict[str, Any]) -> None:
        """向某知识库的所有订阅者推送事件（不阻塞、不抛异常）。"""
        for queue in list(cls._queues.get(kb_id, [])):
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                # 进度事件是状态快照，丢一条不会导致状态错乱
                logger.debug("索引事件队列已满，丢弃事件 kb=%s", kb_id)

    @classmethod
    def subscriber_count(cls, kb_id: str) -> int:
        """当前订阅者数量（测试与诊断用）。"""
        return len(cls._queues.get(kb_id, []))

    @classmethod
    def reset(cls) -> None:
        """清空所有订阅（测试用）。"""
        cls._queues.clear()
