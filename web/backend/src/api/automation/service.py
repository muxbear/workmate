"""自动化任务业务服务."""

from __future__ import annotations

import time
from datetime import datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.automation.schedule import (
    build_freq_summary,
    build_validity_summary,
    compute_next_run,
    parse_date,
    parse_time,
    validity_bounds,
)
from api.automation.schemas import (
    AutomationRunResponse,
    AutomationRunStats,
    AutomationSchedule,
    AutomationTaskDraft,
    AutomationTaskResponse,
)
from db.models.automation import AutomationRun, AutomationTask


def now_ms() -> int:
    """当前毫秒时间戳."""
    return int(time.time() * 1000)


def week_start_ms(value: int | None = None) -> int:
    """本周一 00:00 的毫秒时间戳."""
    current = datetime.fromtimestamp((value or now_ms()) / 1000)
    start = current.fromordinal(current.date().toordinal() - current.weekday())
    start = datetime(start.year, start.month, start.day, 0, 0, 0)
    return int(start.timestamp() * 1000)


def _dedupe(values: list[str], limit: int) -> list[str]:
    result: list[str] = []
    for value in values:
        text = str(value).strip()
        if text and text not in result:
            result.append(text)
        if len(result) >= limit:
            break
    return result


def _validate_schedule_bounds(schedule: AutomationSchedule) -> None:
    """校验有效期与频率参数的真实日期范围."""
    if schedule.validity_mode != "range":
        return
    start_date = parse_date(schedule.valid_from)
    end_date = parse_date(schedule.valid_to)
    if start_date is None or end_date is None:
        raise HTTPException(status_code=400, detail="有效期时间格式非法")
    start_time = parse_time(schedule.valid_from_time)
    end_time = parse_time(schedule.valid_to_time)
    start_ts = int(
        datetime(
            start_date[0],
            start_date[1],
            start_date[2],
            start_time[0],
            start_time[1],
        ).timestamp()
        * 1000
    )
    end_ts = int(
        datetime(
            end_date[0],
            end_date[1],
            end_date[2],
            end_time[0],
            end_time[1],
        ).timestamp()
        * 1000
    )
    if start_ts > end_ts:
        raise HTTPException(status_code=400, detail="有效期开始时间不能晚于结束时间")


def _normalize_draft(draft: AutomationTaskDraft) -> dict[str, Any]:
    """把请求草稿转换为可落库字段."""
    _validate_schedule_bounds(draft.schedule)
    prompt_text = (draft.prompt_text or "").strip()
    title = (draft.title or "").strip() or prompt_text[:18] or "未命名自动化任务"
    valid_from_ts, valid_to_ts = validity_bounds(draft.schedule)
    return {
        "title": title,
        "prompt_text": prompt_text,
        "prompt_parts": [
            part.model_dump(by_alias=True, exclude_none=True)
            for part in draft.prompt_parts
        ],
        "icon": (draft.icon or "⏰").strip() or "⏰",
        "source": draft.source,
        "template_id": draft.template_id,
        "schedule": draft.schedule.model_dump(by_alias=True),
        "freq_summary": build_freq_summary(draft.schedule),
        "validity_summary": build_validity_summary(draft.schedule),
        "valid_from_ts": valid_from_ts,
        "valid_to_ts": valid_to_ts,
        "model": draft.model,
        "custom_model_id": draft.custom_model_id,
        "provider_id": draft.provider_id,
        "model_id": draft.model_id,
        "expert_id": draft.expert_id,
        "expert_name": draft.expert_name,
        "context_mode": draft.context_mode,
        "skill_ids": _dedupe(draft.skill_ids, 50),
        "kb_ids": _dedupe(draft.kb_ids, 20),
        "workspace_id": draft.workspace_id,
        "workspace_name": draft.workspace_name,
        "allow_network": draft.allow_network,
        "allow_shell": draft.allow_shell,
        "full_access": draft.full_access,
    }


def schedule_task_from(task: AutomationTask, from_ts: int) -> None:
    """按任务当前配置重算 next_run_at 与 status."""
    schedule = AutomationSchedule.model_validate(task.schedule)
    next_run_at, terminal = compute_next_run(
        schedule,
        from_ts=from_ts,
        valid_to_ts=task.valid_to_ts,
        last_run_at=task.last_run_at,
        executed_once=(task.run_count or 0) > 0,
    )
    if terminal == "expired":
        task.next_run_at = None
        task.status = "expired"
    elif terminal == "finished":
        task.next_run_at = None
        task.status = "finished"
    else:
        task.next_run_at = next_run_at
        task.status = "enabled"
    if not task.enabled:
        task.next_run_at = None
        task.status = "paused"
    task.updated_at = now_ms()


async def list_tasks(db: AsyncSession, user_id: str) -> list[AutomationTaskResponse]:
    """当前用户的任务列表."""
    rows = (
        (
            await db.execute(
                select(AutomationTask)
                .where(
                    AutomationTask.user_id == user_id,
                    AutomationTask.deleted_at.is_(None),
                )
                .order_by(AutomationTask.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    return [AutomationTaskResponse.model_validate(row) for row in rows]


async def get_task_model(
    db: AsyncSession, user_id: str, task_id: str
) -> AutomationTask:
    """按用户与任务 id 获取任务实体."""
    row = (
        await db.execute(
            select(AutomationTask).where(
                AutomationTask.user_id == user_id,
                AutomationTask.id == task_id,
                AutomationTask.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="任务不存在或已被删除")
    return row


async def get_task(
    db: AsyncSession, user_id: str, task_id: str
) -> AutomationTaskResponse:
    """获取单个任务."""
    return AutomationTaskResponse.model_validate(
        await get_task_model(db, user_id, task_id)
    )


async def create_task(
    db: AsyncSession,
    user_id: str,
    draft: AutomationTaskDraft,
) -> AutomationTaskResponse:
    """新建任务并计算首次排期."""
    data = _normalize_draft(draft)
    current = now_ms()
    task = AutomationTask(user_id=user_id, enabled=True, status="enabled", **data)
    schedule_task_from(task, current)
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return AutomationTaskResponse.model_validate(task)


async def update_task(
    db: AsyncSession,
    user_id: str,
    task_id: str,
    draft: AutomationTaskDraft,
) -> AutomationTaskResponse:
    """更新任务定义并重算排期."""
    task = await get_task_model(db, user_id, task_id)
    data = _normalize_draft(draft)
    for key, value in data.items():
        setattr(task, key, value)
    task.updated_at = now_ms()
    schedule_task_from(task, now_ms())
    await db.commit()
    await db.refresh(task)
    return AutomationTaskResponse.model_validate(task)


async def delete_task(db: AsyncSession, user_id: str, task_id: str) -> None:
    """软删除任务，保留运行历史."""
    task = await get_task_model(db, user_id, task_id)
    current = now_ms()
    task.deleted_at = current
    task.enabled = False
    task.next_run_at = None
    task.status = "paused"
    task.updated_at = current
    await db.commit()


async def set_task_enabled(
    db: AsyncSession,
    user_id: str,
    task_id: str,
    enabled: bool,
) -> AutomationTaskResponse:
    """暂停或继续任务."""
    task = await get_task_model(db, user_id, task_id)
    task.enabled = enabled
    schedule_task_from(task, now_ms())
    await db.commit()
    await db.refresh(task)
    return AutomationTaskResponse.model_validate(task)


async def list_due_tasks(
    db: AsyncSession, current: int, limit: int = 20
) -> list[AutomationTask]:
    """查询已到期的启用任务."""
    rows = (
        (
            await db.execute(
                select(AutomationTask)
                .where(
                    AutomationTask.deleted_at.is_(None),
                    AutomationTask.enabled.is_(True),
                    AutomationTask.status == "enabled",
                    AutomationTask.next_run_at.is_not(None),
                    AutomationTask.next_run_at <= current,
                )
                .order_by(AutomationTask.next_run_at.asc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    return list(rows)


async def earliest_next_run_at(db: AsyncSession) -> int | None:
    """最近一次到期时间."""
    rows = (
        await db.execute(
            select(AutomationTask.next_run_at)
            .where(
                AutomationTask.deleted_at.is_(None),
                AutomationTask.enabled.is_(True),
                AutomationTask.status == "enabled",
                AutomationTask.next_run_at.is_not(None),
            )
            .order_by(AutomationTask.next_run_at.asc())
            .limit(1)
        )
    ).scalar_one_or_none()
    return int(rows) if rows is not None else None


async def list_runs(
    db: AsyncSession,
    user_id: str,
    *,
    task_id: str | None = None,
    limit: int = 50,
    cursor: int | None = None,
) -> list[AutomationRunResponse]:
    """分页查询运行记录."""
    query = select(AutomationRun).where(AutomationRun.user_id == user_id)
    if task_id:
        query = query.where(AutomationRun.task_id == task_id)
    if cursor is not None:
        query = query.where(AutomationRun.started_at < cursor)
    rows = (
        (await db.execute(query.order_by(AutomationRun.started_at.desc()).limit(limit)))
        .scalars()
        .all()
    )
    return [AutomationRunResponse.model_validate(row) for row in rows]


async def get_run(db: AsyncSession, user_id: str, run_id: str) -> AutomationRunResponse:
    """获取单条运行记录."""
    row = (
        await db.execute(
            select(AutomationRun).where(
                AutomationRun.user_id == user_id,
                AutomationRun.id == run_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="运行记录不存在")
    return AutomationRunResponse.model_validate(row)


async def run_stats(
    db: AsyncSession,
    user_id: str,
    since: int | None = None,
) -> AutomationRunStats:
    """统计指定时间后的运行情况."""
    since_ts = since if since is not None else week_start_ms()
    rows = (
        (
            await db.execute(
                select(AutomationRun).where(
                    AutomationRun.user_id == user_id,
                    AutomationRun.started_at >= since_ts,
                )
            )
        )
        .scalars()
        .all()
    )
    durations = [row.duration_ms for row in rows if row.duration_ms is not None]
    return AutomationRunStats(
        total=len(rows),
        success=sum(1 for row in rows if row.status == "success"),
        failed=sum(1 for row in rows if row.status == "failed"),
        skipped=sum(1 for row in rows if row.status == "skipped"),
        running=sum(1 for row in rows if row.status == "running"),
        avg_duration_ms=(int(sum(durations) / len(durations)) if durations else None),
    )


async def mark_running_interrupted(db: AsyncSession, current: int | None = None) -> int:
    """应用启动时把悬挂的 running 记录标记为中断."""
    at = current or now_ms()
    rows = (
        (
            await db.execute(
                select(AutomationRun).where(AutomationRun.status == "running")
            )
        )
        .scalars()
        .all()
    )
    for row in rows:
        row.status = "interrupted"
        row.finished_at = at
        row.error_code = "interrupted"
        row.error_message = "服务重启导致运行中断"
        if row.duration_ms is None:
            row.duration_ms = max(0, at - row.started_at)
    await db.commit()
    return len(rows)
