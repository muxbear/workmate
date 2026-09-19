"""自动化任务执行器.

单次执行流程：推进排期 -> 创建运行记录 -> 组装上下文 -> 调用 Agent -> 落库结果并重排期。
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from langchain_core.messages import HumanMessage
from langchain_core.runnables import RunnableConfig
from sqlalchemy import select

from agent import get_graph_for, get_sandbox_manager
from agent.context.context import Context
from agent.sandbox.workspace import ensure_workspace, normalize_workspace_id
from api.agent.artifacts import record_artifacts
from api.automation.service import now_ms, schedule_task_from
from db.engine import async_session
from db.models.automation import AutomationRun, AutomationTask
from db.models.chat_attachment import ChatAttachment
from db.models.expert import Expert
from db.models.knowledge_base import KnowledgeBase
from db.models.skill import Skill

logger = logging.getLogger(__name__)

RUN_TIMEOUT_SECONDS = 10 * 60
OUTPUT_PREVIEW_LIMIT = 2000
OUTPUT_TEXT_LIMIT = 200000

_MODE_LABELS = {
    "default": "默认",
    "files": "引用上传文件",
    "knowledge": "引用知识库",
}


def _classify_error(error: BaseException) -> tuple[str, str]:
    """把执行异常归类为可展示的失败原因."""
    if isinstance(error, TimeoutError):
        return "timeout", "执行超时，已中断"
    message = str(error) or error.__class__.__name__
    lowered = message.lower()
    if "deepseek_api_key" in lowered or "api_key" in lowered or "凭据" in message:
        return "model_not_configured", message
    if "enoent" in lowered or "文件不存在" in message or "不是文件" in message:
        return "file_missing", message
    if "工作空间" in message or "workspace" in lowered:
        return "workspace_unavailable", message
    return "agent_error", message


class AutomationRunner:
    """任务执行器：调度触发与手动运行共用同一套执行逻辑."""

    def __init__(self) -> None:
        """初始化执行锁与后台任务集合."""
        self._schedule_lock = asyncio.Lock()
        self._run_lock = asyncio.Lock()
        self._background_tasks: set[asyncio.Task[Any]] = set()

    async def submit_manual(self, user_id: str, task_id: str) -> str:
        """立即运行任务并返回运行记录 id."""
        run_id = await self._prepare_run(
            user_id, task_id, "manual", None, require_due=False
        )
        if run_id is None:
            raise RuntimeError("任务不存在或已被删除")
        task = asyncio.create_task(self._execute(run_id))
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)
        return run_id

    async def run_scheduled(
        self,
        user_id: str,
        task_id: str,
        trigger: str,
        scheduled_at: int,
    ) -> str | None:
        """由调度器触发一次运行."""
        run_id = await self._prepare_run(
            user_id,
            task_id,
            trigger,
            scheduled_at,
            require_due=True,
        )
        if run_id is None:
            return None
        await self._execute(run_id)
        return run_id

    async def record_skipped(
        self,
        user_id: str,
        task_id: str,
        scheduled_at: int,
        reason: str,
    ) -> str | None:
        """记录一次跳过并重排下一次触发."""
        current = now_ms()
        async with self._schedule_lock:
            async with async_session() as db:
                task = (
                    await db.execute(
                        select(AutomationTask).where(
                            AutomationTask.id == task_id,
                            AutomationTask.user_id == user_id,
                            AutomationTask.deleted_at.is_(None),
                        )
                    )
                ).scalar_one_or_none()
                if task is None:
                    return None
                schedule_task_from(task, current)
                run = AutomationRun(
                    task_id=task.id,
                    user_id=user_id,
                    trigger="schedule",
                    status="skipped",
                    scheduled_at=scheduled_at,
                    started_at=current,
                    finished_at=current,
                    duration_ms=0,
                    error_message=reason,
                    artifacts=[],
                )
                task.run_count = (task.run_count or 0) + 1
                task.fail_count = (task.fail_count or 0) + 1
                task.last_run_at = current
                task.last_run_status = "skipped"
                task.updated_at = current
                db.add(run)
                await db.commit()
                await db.refresh(run)
                return run.id

    async def _prepare_run(
        self,
        user_id: str,
        task_id: str,
        trigger: str,
        scheduled_at: int | None,
        *,
        require_due: bool,
    ) -> str | None:
        current = now_ms()
        async with self._schedule_lock:
            async with async_session() as db:
                task = (
                    await db.execute(
                        select(AutomationTask).where(
                            AutomationTask.id == task_id,
                            AutomationTask.user_id == user_id,
                            AutomationTask.deleted_at.is_(None),
                        )
                    )
                ).scalar_one_or_none()
                if task is None:
                    return None
                if require_due:
                    if not task.enabled or task.status != "enabled":
                        return None
                    if task.next_run_at is None or task.next_run_at > current:
                        return None
                    if scheduled_at is not None and task.next_run_at > scheduled_at:
                        return None

                # 先推进排期，避免任务执行期间被重复触发。
                schedule_task_from(task, current)
                thread_id = "automation-" + task.id
                run = AutomationRun(
                    task_id=task.id,
                    user_id=user_id,
                    trigger=trigger,
                    status="running",
                    scheduled_at=scheduled_at,
                    started_at=current,
                    conversation_id=task.id,
                    thread_id=thread_id,
                    artifacts=[],
                )
                db.add(run)
                await db.commit()
                await db.refresh(run)
                return run.id

    async def _execute(self, run_id: str) -> None:
        async with self._run_lock:
            async with async_session() as db:
                run = await db.get(AutomationRun, run_id)
                if run is None:
                    return
                task_row = await db.get(AutomationTask, run.task_id)
                if task_row is None:
                    run.status = "interrupted"
                    run.finished_at = now_ms()
                    run.error_code = "interrupted"
                    run.error_message = "任务已删除"
                    await db.commit()
                    return
                task = task_row

            output = ""
            artifacts: list[dict[str, Any]] = []
            status = "success"
            error_code: str | None = None
            error_message: str | None = None
            model_name = task.model or task.custom_model_id

            try:
                output, artifacts = await asyncio.wait_for(
                    self._invoke_agent(task),
                    timeout=RUN_TIMEOUT_SECONDS,
                )
            except BaseException as error:
                if isinstance(error, asyncio.CancelledError):
                    raise
                status = "failed"
                error_code, error_message = _classify_error(error)
                logger.warning(
                    "Automation run failed: %s", error_message, exc_info=True
                )

            finished_at = now_ms()
            async with async_session() as db:
                run_row = await db.get(AutomationRun, run_id)
                task_row = await db.get(AutomationTask, task.id)
                if run_row is not None:
                    run_row.status = status
                    run_row.finished_at = finished_at
                    run_row.duration_ms = max(0, finished_at - run_row.started_at)
                    run_row.output_preview = output[:OUTPUT_PREVIEW_LIMIT] or None
                    run_row.output_text = output[:OUTPUT_TEXT_LIMIT] or None
                    run_row.model = model_name
                    run_row.error_code = error_code
                    run_row.error_message = error_message
                    run_row.artifacts = artifacts
                if task_row is not None:
                    task_row.run_count = (task_row.run_count or 0) + 1
                    if status != "success":
                        task_row.fail_count = (task_row.fail_count or 0) + 1
                    task_row.last_run_at = finished_at
                    task_row.last_run_status = status
                    schedule_task_from(task_row, finished_at)
                await db.commit()

    async def _invoke_agent(
        self, task: AutomationTask
    ) -> tuple[str, list[dict[str, Any]]]:
        message, attachment_paths = await self._build_message(task)
        workspace_id = normalize_workspace_id(task.workspace_id)
        allow_network = bool(task.allow_network or task.full_access)
        allow_shell = bool(task.allow_shell or task.full_access)
        thread_id = "automation-" + task.id

        try:
            await asyncio.to_thread(
                get_sandbox_manager().apply_session_network_policy,
                task.user_id,
                allow_network,
            )
        except Exception:
            logger.warning("Apply automation network policy failed", exc_info=True)
        if workspace_id:
            try:
                await asyncio.to_thread(
                    ensure_workspace,
                    get_sandbox_manager().get_or_create_backend(task.user_id),
                    workspace_id,
                )
            except Exception:
                logger.warning("Ensure automation workspace failed", exc_info=True)

        context = Context(
            server_info="ke_hermes_server",
            user_id=task.user_id,
            org_id="default-org",
            allow_network=allow_network,
            allow_shell=allow_shell,
            workspace_id=workspace_id,
        )
        graph = await get_graph_for(task.provider_id, task.model_id)
        config: RunnableConfig = {
            "configurable": {"thread_id": thread_id},
            "recursion_limit": 50,
        }

        output_parts: list[str] = []
        artifacts: list[dict[str, Any]] = []
        stream = await graph.astream_events(
            {"messages": [HumanMessage(content=message)]},
            config=config,
            context=context,
            version="v3",
        )

        async def consume_messages() -> None:
            async for item in stream.messages:
                async for delta in item.text:
                    output_parts.append(str(delta))

        async def consume_tools() -> None:
            async for call in stream.tool_calls:
                input_str = json.dumps(call.input, ensure_ascii=False, default=str)
                added = await record_artifacts(
                    thread_id,
                    task.user_id,
                    call.tool_name,
                    input_str,
                )
                artifacts.extend(item.to_dict() for item in added)

        async def consume_subagents() -> None:
            async for subagent in stream.subagents:
                async for item in subagent.messages:
                    async for _ in item.text:
                        pass

        results = await asyncio.gather(
            consume_messages(),
            consume_tools(),
            consume_subagents(),
            return_exceptions=True,
        )
        for result in results:
            if isinstance(result, BaseException) and not isinstance(
                result, asyncio.CancelledError
            ):
                raise result

        output = "".join(output_parts).strip()
        if attachment_paths:
            logger.debug(
                "Automation task %s attached %d files", task.id, len(attachment_paths)
            )
        return output, artifacts

    async def _build_message(self, task: AutomationTask) -> tuple[str, list[str]]:
        """组装任务上下文、附件路径与用户提示词."""
        hints: list[str] = []
        async with async_session() as db:
            if task.expert_id:
                expert = (
                    await db.execute(select(Expert).where(Expert.id == task.expert_id))
                ).scalar_one_or_none()
                if (
                    expert is not None
                    and expert.is_published
                    and expert.status == "active"
                ):
                    hints.append("【专家】本次任务已选择专家「" + expert.name + "」。")

            if task.skill_ids:
                skill_rows = (
                    (
                        await db.execute(
                            select(Skill).where(
                                Skill.id.in_(task.skill_ids),
                                Skill.valid.is_(True),
                                Skill.enabled.is_(True),
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                if skill_rows:
                    hints.append(
                        "【技能】本次任务需要用到以下技能："
                        + "、".join(item.name for item in skill_rows)
                        + "。"
                    )

            if task.kb_ids:
                kb_rows = (
                    (
                        await db.execute(
                            select(KnowledgeBase).where(
                                KnowledgeBase.id.in_(task.kb_ids),
                                KnowledgeBase.user_id == task.user_id,
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                if kb_rows:
                    hints.append(
                        "【知识库】知识检索范围限定为："
                        + "、".join(item.name for item in kb_rows)
                        + "。"
                    )

            attachment_ids = [
                str(part.get("attachmentId"))
                for part in (task.prompt_parts or [])
                if part.get("type") == "file" and part.get("attachmentId")
            ]
            attachment_paths: list[str] = []
            if attachment_ids:
                rows = (
                    (
                        await db.execute(
                            select(ChatAttachment).where(
                                ChatAttachment.id.in_(attachment_ids),
                                ChatAttachment.status == "success",
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                for row in rows:
                    attachment_paths.append("/" + row.file_path)

        mode = task.context_mode if task.context_mode in _MODE_LABELS else "default"
        if mode != "default":
            hints.append("【模式】当前任务模式：" + _MODE_LABELS[mode] + "。")
        if task.workspace_id:
            hints.append(
                "【工作区】本次任务的工作目录为 /workspace/"
                + task.workspace_id
                + "，产物文件请写入该目录。"
            )
        if task.allow_network or task.full_access:
            hints.append("【权限】本次任务允许联网访问外部资源。")
        if task.allow_shell or task.full_access:
            hints.append("【权限】本次任务允许执行命令与代码。")

        body_parts: list[str] = []
        for part in task.prompt_parts or []:
            if part.get("type") == "text" and part.get("text"):
                body_parts.append(str(part["text"]))
            elif part.get("type") == "file" and part.get("filename"):
                body_parts.append("[" + str(part["filename"]) + "]")
        body = "".join(body_parts).strip() or (task.prompt_text or "").strip()

        blocks: list[str] = []
        if hints:
            blocks.append("【任务配置】\n" + "\n".join("- " + hint for hint in hints))
        if attachment_paths:
            blocks.append(
                "任务引用了以下附件文件：\n"
                + "\n".join("  - [FILE] " + path for path in attachment_paths)
            )
        blocks.append("任务内容：" + body)
        return "\n\n".join(blocks), attachment_paths

    async def shutdown(self) -> None:
        """停止后台手动运行任务."""
        for task in list(self._background_tasks):
            task.cancel()
        if self._background_tasks:
            await asyncio.gather(*self._background_tasks, return_exceptions=True)
        self._background_tasks.clear()


automation_runner = AutomationRunner()
