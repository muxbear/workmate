"""会话产物留存期清理后台任务。"""

from __future__ import annotations

import asyncio
import contextlib
import logging

from api.agent.artifacts import purge_expired_artifacts, purge_orphan_objects
from core.storage.agent_staging import purge_agent_staging

logger = logging.getLogger(__name__)

# 默认清理间隔（秒）与默认留存天数
DEFAULT_INTERVAL_SECONDS = 3600
DEFAULT_RETENTION_DAYS = 30


def _setting_int(name: str, default: int) -> int:
    """读取产物相关整型配置（缺省或非法值回退默认值）。"""
    from agent.config import settings

    try:
        return int(getattr(settings, name, default))
    except (TypeError, ValueError):
        return default


class ArtifactMaintenance:
    """按固定间隔清理超过留存期的会话产物。"""

    def __init__(self) -> None:
        """初始化后台循环状态。"""
        self._task: asyncio.Task[None] | None = None
        self._running = False

    async def start(self) -> None:
        """启动后台清理循环（重复调用无副作用）。"""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())
        logger.info(
            "产物清理任务已启动（interval=%ds）",
            _setting_int("ARTIFACT_GC_INTERVAL_SECONDS", DEFAULT_INTERVAL_SECONDS),
        )

    async def stop(self) -> None:
        """停止后台清理循环。"""
        self._running = False
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def tick(self) -> int:
        """执行一次清理（留存期产物 + 孤儿对象），返回清理数量。"""
        days = _setting_int("ARTIFACT_RETENTION_DAYS", DEFAULT_RETENTION_DAYS)
        removed = 0
        try:
            removed += await purge_expired_artifacts(days)
        except Exception:
            logger.exception("产物留存期清理失败")
        try:
            removed += await purge_orphan_objects()
        except Exception:
            logger.exception("孤儿产物对象清理失败")
        try:
            # 交付目录（/artifacts/）的残留文件按留存期清理，已物化内容仍在持久存储中
            removed += purge_agent_staging(older_than_seconds=max(0, days) * 86400)
        except Exception:
            logger.exception("交付目录残留文件清理失败")
        return removed

    async def _loop(self) -> None:
        """按固定间隔周期执行清理，异常不中断循环。"""
        interval = _setting_int("ARTIFACT_GC_INTERVAL_SECONDS", DEFAULT_INTERVAL_SECONDS)
        while self._running:
            try:
                await asyncio.sleep(max(1, interval))
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("产物清理循环异常")


artifact_maintenance = ArtifactMaintenance()
