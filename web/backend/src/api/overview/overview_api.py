"""概览统计 API 路由."""

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user_id, get_db
from core.decorators import handle_errors
from core.response import ok

from .service import (
    get_events,
    get_kpi,
    get_provider_usage,
    get_resource_stats,
    get_system_health,
    get_system_metrics_with_state,
    get_token_stats,
    get_top_users,
    get_usage_trend,
)

router = APIRouter(prefix="/api/overview", tags=["概览"])


@router.get("/resource-stats")
@handle_errors
async def resource_stats(
    db: AsyncSession = Depends(get_db),
    _user_id: str = Depends(get_current_user_id),
):
    """获取资源类统计聚合数据."""
    data = await get_resource_stats(db)
    return ok(data)


@router.get("/health")
@handle_errors
async def health(
    request: Request,
    db: AsyncSession = Depends(get_db),
    _user_id: str = Depends(get_current_user_id),
):
    """系统健康检查."""
    data = await get_system_health(db, request.app.state)
    return ok(data)


@router.get("/kpi")
@handle_errors
async def kpi(
    period: str = "day",
    db: AsyncSession = Depends(get_db),
    _user_id: str = Depends(get_current_user_id),
):
    """获取 KPI 概要统计."""
    data = await get_kpi(db, period)
    return ok(data)


@router.get("/usage-trend")
@handle_errors
async def usage_trend(
    period: str = "day",
    db: AsyncSession = Depends(get_db),
    _user_id: str = Depends(get_current_user_id),
):
    """获取使用趋势数据."""
    data = await get_usage_trend(db, period)
    return ok(data)


@router.get("/provider-usage")
@handle_errors
async def provider_usage(
    db: AsyncSession = Depends(get_db),
    _user_id: str = Depends(get_current_user_id),
):
    """获取模型提供商使用率."""
    data = await get_provider_usage(db)
    return ok(data)


@router.get("/top-users")
@handle_errors
async def top_users(
    limit: int = 5,
    period: str = "day",
    db: AsyncSession = Depends(get_db),
    _user_id: str = Depends(get_current_user_id),
):
    """获取人员调用排行."""
    data = await get_top_users(db, limit=limit, period=period)
    return ok(data)


@router.get("/system-metrics")
@handle_errors
async def system_metrics(
    request: Request,
    db: AsyncSession = Depends(get_db),
    _user_id: str = Depends(get_current_user_id),
):
    """获取系统健康监控指标."""
    data = await get_system_metrics_with_state(db, request.app.state)
    return ok(data)


@router.get("/token-stats")
@handle_errors
async def token_stats(
    period: str = "day",
    db: AsyncSession = Depends(get_db),
    _user_id: str = Depends(get_current_user_id),
):
    """获取 Token 消耗统计."""
    data = await get_token_stats(db, period)
    return ok(data)


@router.get("/events")
@handle_errors
async def events(
    limit: int = 20,
    category: str | None = None,
    type: str | None = None,
    db: AsyncSession = Depends(get_db),
    _user_id: str = Depends(get_current_user_id),
):
    """获取最新系统事件日志."""
    data = await get_events(db, limit=limit, category=category, event_type=type)
    return ok(data)
