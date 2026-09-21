"""产物回灌中间件 — 沙箱重建后把已持久化的会话产物补回沙箱。"""

from __future__ import annotations

import asyncio
import logging
import shlex
from typing import TYPE_CHECKING, Annotated, Any, NotRequired

from langchain.agents.middleware.types import (
    AgentMiddleware,
    AgentState,
    PrivateStateAttr,
)

from agent.config import settings
from agent.sandbox.sandbox_manager import SandboxManager
from core.storage.agent_staging import is_agent_artifact_path

if TYPE_CHECKING:
    from collections.abc import Sequence

    from langchain_core.runnables import RunnableConfig
    from langgraph.runtime import Runtime

    from api.agent.artifacts import Artifact

logger = logging.getLogger(__name__)

# 单次回灌的文件数量上限
DEFAULT_MAX_FILES = 20


class ArtifactRestoreState(AgentState):
    """产物回灌中间件状态 — 记录已回灌的沙箱与会话。"""

    _artifacts_restored: NotRequired[Annotated[str | None, PrivateStateAttr]]


class ArtifactRestoreMiddleware(AgentMiddleware[ArtifactRestoreState, Any, Any]):
    """沙箱重建后把本次会话的持久化产物回灌回沙箱。

    以「沙箱 ID + 会话 ID」为标记：同一沙箱内不重复回灌，沙箱因 TTL 过期
    被重建后会自动补一次，使智能体在后续轮次仍能读写上一轮的产物。
    """

    state_schema = ArtifactRestoreState

    def __init__(
        self,
        *,
        sandbox_manager: SandboxManager,
        max_files: int = DEFAULT_MAX_FILES,
    ) -> None:
        """初始化回灌中间件。

        Args:
            sandbox_manager: 沙箱管理器，用于获取用户沙箱后端。
            max_files: 单次回灌的文件数量上限。
        """
        self._sandbox_manager = sandbox_manager
        self._max_files = max(1, max_files)

    async def abefore_agent(  # type: ignore[override]
        self,
        state: ArtifactRestoreState,
        runtime: Runtime,
        config: RunnableConfig,
    ) -> dict[str, str] | None:
        """在智能体执行前把会话产物回灌到沙箱（幂等）。"""
        thread_id = _thread_id_from_config(config)
        user_id = _user_id_from_runtime(runtime)
        if not thread_id or not user_id:
            return None

        backend = await asyncio.to_thread(
            self._sandbox_manager.get_or_create_backend, user_id
        )
        marker = f"{backend.id}::{thread_id}"
        if state.get("_artifacts_restored") == marker:
            return None

        restored = 0
        try:
            restored = await self._restore_artifacts(user_id, thread_id, backend)
        except Exception:
            logger.warning("产物回灌失败（thread_id=%s）", thread_id, exc_info=True)
        if restored:
            logger.info(
                "已回灌 %d 个会话产物到沙箱 %s（thread_id=%s）",
                restored,
                backend.id,
                thread_id,
            )
        return {"_artifacts_restored": marker}

    async def _restore_artifacts(
        self, user_id: str, thread_id: str, backend: Any
    ) -> int:
        """把沙箱内缺失的持久化产物上传回沙箱，返回成功数量。"""
        from api.agent.artifacts import list_ready_artifacts
        from core.storage import get_artifact_store

        artifacts: list[Artifact] = await list_ready_artifacts(
            thread_id, user_id, limit=self._max_files
        )
        if not artifacts:
            return 0

        store = get_artifact_store()
        max_bytes = _max_file_bytes()
        payload: list[tuple[str, bytes]] = []
        for item in artifacts:
            if not item.storage_key or not item.path:
                continue
            if is_agent_artifact_path(item.path):
                # 交付目录由宿主 staging 提供，无需回灌到沙箱
                continue
            if await self._exists_in_sandbox(backend, item.path):
                continue
            content = await asyncio.to_thread(store.open, item.storage_key)
            if content is None:
                continue
            if max_bytes and len(content) > max_bytes:
                logger.info("产物超过回灌大小上限，已跳过：%s", item.path)
                continue
            payload.append((item.path, content))

        if not payload:
            return 0

        responses: Sequence[Any] = await backend.aupload_files(payload)
        failed = [item for item in responses if getattr(item, "error", None)]
        if failed:
            logger.warning(
                "部分产物回灌失败：%s",
                [(getattr(item, "path", ""), item.error) for item in failed[:5]],
            )
        return len(payload) - len(failed)

    @staticmethod
    async def _exists_in_sandbox(backend: Any, path: str) -> bool:
        """判断沙箱内是否已存在该文件；存在则不覆盖，避免覆盖新内容。"""
        try:
            result = await asyncio.to_thread(
                backend.execute, f"test -e {shlex.quote(path)}"
            )
        except Exception:
            return False
        return getattr(result, "exit_code", 1) == 0


def _thread_id_from_config(config: RunnableConfig | None) -> str:
    """从 LangGraph 运行配置中取当前会话 ID。"""
    if not config:
        return ""
    configurable = config.get("configurable")
    if not isinstance(configurable, dict):
        return ""
    return str(configurable.get("thread_id") or "")


def _user_id_from_runtime(runtime: Any) -> str:
    """从运行时上下文中取用户 ID。"""
    context = getattr(runtime, "context", None)
    return str(getattr(context, "user_id", "") or "")


def _max_file_bytes() -> int:
    """读取单文件回灌大小上限（MB，0 表示不限制）。"""
    try:
        limit_mb = int(settings.ARTIFACT_MAX_FILE_MB)
    except (TypeError, ValueError):
        return 0
    return max(0, limit_mb) * 1024 * 1024
