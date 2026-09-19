"""自动化任务调度器."""

from __future__ import annotations

import asyncio
import contextlib
import logging

from api.automation.runner import automation_runner
from api.automation.service import (
    list_due_tasks,
    mark_running_interrupted,
    now_ms,
)
from db.engine import async_session

logger = logging.getLogger(__name__)

TICK_INTERVAL_SECONDS = 30
CATCH_UP_GRACE_MS = 10 * 60 * 1000
DUE_BATCH_SIZE = 20


class AutomationScheduler:
    """轻量后台调度器：按到期时间批量触发任务."""

    def __init__(self) -> None:
        """初始化调度循环状态."""
        self._task: asyncio.Task[None] | None = None
        self._running = False

    async def start(self) -> None:
        """启动调度循环并清理上次服务遗留的悬挂运行."""
        if self._running:
            return
        self._running = True
        async with async_session() as db:
            interrupted = await mark_running_interrupted(db)
            if interrupted:
                logger.info("Marked %d automation runs as interrupted", interrupted)
        self._task = asyncio.create_task(self._loop())
        logger.info("Automation scheduler started")

    async def stop(self) -> None:
        """停止调度循环."""
        self._running = False
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        await automation_runner.shutdown()
        logger.info("Automation scheduler stopped")

    async def _loop(self) -> None:
        while self._running:
            try:
                await self.tick()
            except Exception:
                logger.exception("Automation scheduler tick failed")
            await asyncio.sleep(TICK_INTERVAL_SECONDS)

    async def tick(self) -> None:
        """处理一批到期任务."""
        current = now_ms()
        async with async_session() as db:
            due_tasks = await list_due_tasks(db, current, DUE_BATCH_SIZE)
            due_items = [
                (item.id, item.user_id, item.next_run_at) for item in due_tasks
            ]

        for task_id, user_id, scheduled_at in due_items:
            if not self._running:
                return
            if scheduled_at is None:
                continue
            overdue = current - scheduled_at
            if overdue > CATCH_UP_GRACE_MS:
                await automation_runner.record_skipped(
                    user_id,
                    task_id,
                    scheduled_at,
                    "服务未运行，已跳过本次触发",
                )
                continue
            trigger = (
                "catchup" if overdue > TICK_INTERVAL_SECONDS * 1000 else "schedule"
            )
            try:
                await automation_runner.run_scheduled(
                    user_id,
                    task_id,
                    trigger,
                    scheduled_at,
                )
            except Exception:
                logger.exception("Automation task %s failed to start", task_id)


automation_scheduler = AutomationScheduler()
