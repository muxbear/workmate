"""自动化任务 API 端点."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from api.automation.runner import automation_runner
from api.automation.schemas import (
    AutomationRunResponse,
    AutomationRunStats,
    AutomationTaskDraft,
    AutomationTaskResponse,
    EnabledRequest,
    RunNowResponse,
)
from api.automation.service import (
    create_task,
    delete_task,
    get_run,
    get_task,
    get_task_model,
    list_runs,
    list_tasks,
    run_stats,
    set_task_enabled,
    update_task,
)
from api.deps import get_current_user_id, get_db
from core.decorators import handle_errors
from core.response import ApiResponse, ok

router = APIRouter(prefix="/api/automation", tags=["automation"])


@router.get("/tasks", response_model=ApiResponse[list[AutomationTaskResponse]])
@handle_errors
async def automation_tasks(
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[list[AutomationTaskResponse]]:
    """获取当前用户的自动化任务列表."""
    return ok(await list_tasks(db, user_id))


@router.post("/tasks", response_model=ApiResponse[AutomationTaskResponse])
@handle_errors
async def automation_task_create(
    req: AutomationTaskDraft,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[AutomationTaskResponse]:
    """新建自动化任务."""
    return ok(await create_task(db, user_id, req))


@router.get("/tasks/{task_id}", response_model=ApiResponse[AutomationTaskResponse])
@handle_errors
async def automation_task_get(
    task_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[AutomationTaskResponse]:
    """获取单个自动化任务."""
    return ok(await get_task(db, user_id, task_id))


@router.put("/tasks/{task_id}", response_model=ApiResponse[AutomationTaskResponse])
@handle_errors
async def automation_task_update(
    task_id: str,
    req: AutomationTaskDraft,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[AutomationTaskResponse]:
    """更新自动化任务."""
    return ok(await update_task(db, user_id, task_id, req))


@router.delete("/tasks/{task_id}", response_model=ApiResponse[None])
@handle_errors
async def automation_task_delete(
    task_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[None]:
    """删除自动化任务."""
    await delete_task(db, user_id, task_id)
    return ok(None)


@router.patch(
    "/tasks/{task_id}/enabled", response_model=ApiResponse[AutomationTaskResponse]
)
@handle_errors
async def automation_task_enabled(
    task_id: str,
    req: EnabledRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[AutomationTaskResponse]:
    """暂停或继续任务."""
    return ok(await set_task_enabled(db, user_id, task_id, req.enabled))


@router.post("/tasks/{task_id}/run", response_model=ApiResponse[RunNowResponse])
@handle_errors
async def automation_task_run(
    task_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[RunNowResponse]:
    """立即运行任务."""
    await get_task_model(db, user_id, task_id)
    run_id = await automation_runner.submit_manual(user_id, task_id)
    return ok(RunNowResponse(run_id=run_id))


@router.get("/runs/stats", response_model=ApiResponse[AutomationRunStats])
@handle_errors
async def automation_run_stats(
    since: int | None = Query(default=None),
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[AutomationRunStats]:
    """获取本周运行统计."""
    return ok(await run_stats(db, user_id, since))


@router.get("/runs", response_model=ApiResponse[list[AutomationRunResponse]])
@handle_errors
async def automation_runs(
    task_id: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    cursor: int | None = Query(default=None),
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[list[AutomationRunResponse]]:
    """分页查询运行记录."""
    return ok(await list_runs(db, user_id, task_id=task_id, limit=limit, cursor=cursor))


@router.get("/runs/{run_id}", response_model=ApiResponse[AutomationRunResponse])
@handle_errors
async def automation_run_get(
    run_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[AutomationRunResponse]:
    """获取运行结果详情."""
    return ok(await get_run(db, user_id, run_id))
