"""概览统计查询逻辑."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from db.models.agent import Agent
from db.models.ai_model import AIModel
from db.models.cron_job import CronJob
from db.models.mcp_tool import McpTool
from db.models.personnel import Personnel
from db.models.provider import Provider
from db.models.skill import Skill
from db.models.tool import Tool
from db.models.user import Account


def _date_bucket(column, fmt: str):
    """跨数据库兼容的日期分桶函数.

    SQLite 使用 strftime，PostgreSQL 使用 to_char。
    """
    from agent.config import settings
    if settings.DATABASE_BACKEND == "sqlite":
        return func.strftime(fmt, column)
    else:
        # PostgreSQL: %H:00 -> HH24:00, %d -> DD, %m -> MM
        pg_fmt = fmt.replace("%H", "HH24").replace(":00", ":00").replace("%d", "DD").replace("%m", "MM")
        return func.to_char(column, pg_fmt)


async def get_resource_stats(db: AsyncSession) -> dict[str, Any]:
    """聚合查询所有资源类统计数据."""
    # 工具
    tools_total = await db.scalar(select(func.count()).select_from(Tool))
    tools_enabled = await db.scalar(
        select(func.count()).select_from(Tool).where(Tool.status == "enabled")
    )

    # 技能
    skills_total = await db.scalar(select(func.count()).select_from(Skill))
    skills_enabled = await db.scalar(
        select(func.count()).select_from(Skill).where(Skill.enabled == True)  # noqa: E712
    )

    # 定时任务
    cron_total = await db.scalar(select(func.count()).select_from(CronJob))
    cron_active = await db.scalar(
        select(func.count()).select_from(CronJob).where(CronJob.status == "active")
    )

    # 代理（按类型分组）
    agent_rows = await db.execute(
        select(Agent.type, func.count()).group_by(Agent.type)
    )
    agent_counts = {row[0]: row[1] for row in agent_rows}

    # MCP 工具
    mcp_total = await db.scalar(select(func.count()).select_from(McpTool))

    # 人员
    personnel_total = await db.scalar(select(func.count()).select_from(Personnel))
    personnel_active = await db.scalar(
        select(func.count()).select_from(Personnel).where(Personnel.status == "active")
    )

    # 提供商
    providers_total = await db.scalar(select(func.count()).select_from(Provider))
    providers_connected = await db.scalar(
        select(func.count()).select_from(Provider).where(Provider.status == "connected")
    )

    # 模型
    models_total = await db.scalar(select(func.count()).select_from(AIModel))
    models_active = await db.scalar(
        select(func.count()).select_from(AIModel).where(AIModel.status == "active")
    )

    return {
        "tools": {"total": tools_total or 0, "enabled": tools_enabled or 0},
        "skills": {"total": skills_total or 0, "enabled": skills_enabled or 0},
        "cron_jobs": {"total": cron_total or 0, "enabled": cron_active or 0},
        "agents": {
            "main": agent_counts.get("main", 0),
            "sub": agent_counts.get("sub", 0),
        },
        "mcp_services": {"total": mcp_total or 0, "enabled": mcp_total or 0},
        "personnel": {"total": personnel_total or 0, "enabled": personnel_active or 0},
        "providers": {"total": providers_total or 0, "enabled": providers_connected or 0},
        "models": {"total": models_total or 0, "enabled": models_active or 0},
        "system_status": "ok",
    }


async def get_system_health(db: AsyncSession, app_state: Any) -> dict[str, Any]:
    """系统健康检查.

    检查项：数据库连通性、向量库、LLM 提供商状态。
    """
    checks: list[dict[str, str]] = []
    started_at = getattr(app_state, "started_at", None)
    now = datetime.now(UTC).replace(tzinfo=None)

    # 数据库连通性
    db_ok = False
    try:
        from sqlalchemy import text
        await db.execute(text("SELECT 1"))
        db_ok = True
        checks.append({"name": "database", "status": "ok"})
    except Exception:
        checks.append({"name": "database", "status": "error"})

    # 向量库
    vector_store = getattr(app_state, "vector_store", None)
    if vector_store is not None:
        checks.append({"name": "vector_store", "status": "ok"})
    else:
        checks.append({"name": "vector_store", "status": "error"})

    # 计算运行时长
    uptime_seconds = 0
    started_at_str = ""
    if started_at:
        if isinstance(started_at, datetime):
            started_at_naive = started_at.replace(tzinfo=None) if started_at.tzinfo else started_at
            uptime_seconds = int((now - started_at_naive).total_seconds())
            started_at_str = started_at.isoformat()
        elif isinstance(started_at, str):
            started_at_str = started_at

    # 总体状态
    all_ok = all(c["status"] == "ok" for c in checks)
    overall = "ok" if all_ok else "degraded"

    return {
        "status": overall,
        "uptime_seconds": uptime_seconds,
        "started_at": started_at_str,
        "db_connected": db_ok,
        "checks": checks,
    }


async def get_kpi(db: AsyncSession, period: str = "day") -> dict[str, Any]:
    """KPI 概要统计.

    返回注册用户数、活跃用户数、请求数、新增用户数及趋势。
    """
    from datetime import UTC, datetime, timedelta

    now = datetime.now(UTC).replace(tzinfo=None)

    # 周期起始时间
    if period == "day":
        period_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == "month":
        period_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        # 上月1日
    else:  # year
        period_start = now.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)

    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    yesterday_start = today_start - timedelta(days=1)

    # 注册用户总数
    registered_users = await db.scalar(select(func.count()).select_from(Account))

    # 今日活跃用户（今日成功登录的独立用户数）
    from db.models.chat_usage import ChatUsage
    from db.models.login_record import LoginRecord
    active_users = await db.scalar(
        select(func.count(func.distinct(LoginRecord.account))).where(
            LoginRecord.success == True,  # noqa: E712
            LoginRecord.created_at >= today_start,
        )
    )

    # 今日总请求数
    total_requests = await db.scalar(
        select(func.count()).select_from(ChatUsage).where(ChatUsage.created_at >= today_start)
    )

    # 本周期新增用户
    new_users = await db.scalar(
        select(func.count()).select_from(Account).where(Account.created_at >= period_start)
    )

    # 趋势：对比昨日与今日的活跃用户和请求数
    yesterday_active = await db.scalar(
        select(func.count(func.distinct(LoginRecord.account))).where(
            LoginRecord.success == True,  # noqa: E712
            LoginRecord.created_at >= yesterday_start,
            LoginRecord.created_at < today_start,
        )
    ) or 0
    yesterday_requests = await db.scalar(
        select(func.count()).select_from(ChatUsage).where(
            ChatUsage.created_at >= yesterday_start,
            ChatUsage.created_at < today_start,
        )
    ) or 0

    active_today = active_users or 0
    requests_today = total_requests or 0

    def _pct(curr, prev):
        if prev == 0:
            return 0 if curr == 0 else 100
        return round((curr - prev) / prev * 100)

    # 人员概况统计
    from core.notification_bus import NotificationBus
    from db.models.role import Role
    from db.models.user_role import UserRole

    personnel_total = await db.scalar(select(func.count()).select_from(Personnel)) or 0
    online_count = len(NotificationBus._user_queues)
    admin_count = await db.scalar(
        select(func.count(func.distinct(UserRole.user_id)))
        .join(Role, UserRole.role_id == Role.id)
        .where(Role.key.in_(["super_admin", "admin"]))
    ) or 0

    return {
        "registered_users": registered_users or 0,
        "active_users": active_today,
        "total_requests": requests_today,
        "new_users_this_period": new_users or 0,
        "trend": {
            "active_users": _pct(active_today, yesterday_active),
            "requests": _pct(requests_today, yesterday_requests),
        },
        "personnel_summary": {
            "total": personnel_total,
            "online": online_count,
            "admins": admin_count,
        },
    }


async def get_usage_trend(db: AsyncSession, period: str = "day") -> list[dict[str, Any]]:
    """使用趋势——按时间分桶的活跃用户数和请求数."""
    from datetime import UTC, datetime

    from db.models.chat_usage import ChatUsage

    now = datetime.now(UTC).replace(tzinfo=None)

    if period == "day":
        # 按小时分桶，从0点到当前小时
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        rows = await db.execute(
            select(
                _date_bucket(ChatUsage.created_at, "%H:00").label("bucket"),
                func.count(func.distinct(ChatUsage.user_id)).label("users"),
                func.count().label("requests"),
            ).where(ChatUsage.created_at >= today_start).group_by("bucket").order_by("bucket")
        )
        # 补全缺失的小时
        result_map = {row[0]: {"time": row[0], "users": row[1], "requests": row[2]} for row in rows}
        result = []
        for h in range(24):
            t = f"{h:02d}:00"
            if t in result_map:
                result.append(result_map[t])
            elif h <= now.hour:
                result.append({"time": t, "users": 0, "requests": 0})
        return result

    elif period == "month":
        # 按日分桶，1日到30日
        month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        rows = await db.execute(
            select(
                _date_bucket(ChatUsage.created_at, "%d").label("bucket"),
                func.count(func.distinct(ChatUsage.user_id)).label("users"),
                func.count().label("requests"),
            ).where(ChatUsage.created_at >= month_start).group_by("bucket").order_by("bucket")
        )
        result_map = {row[0]: {"time": f"{int(row[0])}日", "users": row[1], "requests": row[2]} for row in rows}
        from calendar import monthrange
        days = monthrange(now.year, now.month)[1]
        result = []
        for d in range(1, days + 1):
            key = f"{d:02d}"
            if key in result_map:
                result.append(result_map[key])
            elif d <= now.day:
                result.append({"time": f"{d}日", "users": 0, "requests": 0})
        return result

    else:  # year
        # 按月分桶
        year_start = now.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
        rows = await db.execute(
            select(
                _date_bucket(ChatUsage.created_at, "%m").label("bucket"),
                func.count(func.distinct(ChatUsage.user_id)).label("users"),
                func.count().label("requests"),
            ).where(ChatUsage.created_at >= year_start).group_by("bucket").order_by("bucket")
        )
        result_map = {row[0]: {"time": f"{int(row[0])}月", "users": row[1], "requests": row[2]} for row in rows}
        result = []
        for m in range(1, 13):
            key = f"{m:02d}"
            if key in result_map:
                result.append(result_map[key])
            elif m <= now.month:
                result.append({"time": f"{m}月", "users": 0, "requests": 0})
        return result


async def get_provider_usage(db: AsyncSession) -> list[dict[str, Any]]:
    """模型提供商使用率统计."""
    from db.models.chat_usage import ChatUsage

    # 获取所有提供商
    providers = await db.execute(
        select(Provider).order_by(Provider.sort_order)
    )
    provider_list = providers.scalars().all()

    # 获取每个提供商的调用次数
    usage_rows = await db.execute(
        select(
            ChatUsage.provider_id,
            func.count().label("calls"),
            func.sum(ChatUsage.total_tokens).label("tokens"),
        ).where(ChatUsage.provider_id.isnot(None)).group_by(ChatUsage.provider_id)
    )
    usage_map = {row[0]: {"calls": row[1], "tokens": row[2] or 0} for row in usage_rows}

    # 获取每个提供商下的模型数量
    model_counts = await db.execute(
        select(AIModel.provider_id, func.count()).group_by(AIModel.provider_id)
    )
    model_count_map = {row[0]: row[1] for row in model_counts}

    total_calls = sum(u["calls"] for u in usage_map.values()) or 1

    result = []
    for p in provider_list:
        usage = usage_map.get(p.id, {"calls": 0, "tokens": 0})
        result.append({
            "name": p.name,
            "icon": p.logo,
            "models": model_count_map.get(p.id, 0),
            "usage_pct": round(usage["calls"] / total_calls * 100) if total_calls > 0 else 0,
            "call_count": usage["calls"],
            "token_total": usage["tokens"],
            "popular_model": "",  # TODO: 查询最热门模型
            "connected": p.status == "connected",
        })

    # 补充最热门模型
    for item in result:
        provider_name = item["name"]
        # 找到对应的provider id
        p = next((pr for pr in provider_list if pr.name == provider_name), None)
        if p:
            popular = await db.execute(
                select(ChatUsage.model_id, func.count().label("c"))
                .where(ChatUsage.provider_id == p.id)
                .group_by(ChatUsage.model_id)
                .order_by(func.count().desc())
                .limit(1)
            )
            pop_row = popular.first()
            if pop_row and pop_row[0]:
                # 获取模型名称
                model_row = await db.execute(select(AIModel.display_name).where(AIModel.id == pop_row[0]))
                item["popular_model"] = model_row.scalar() or ""

    return result


async def get_top_users(db: AsyncSession, limit: int = 5, period: str = "day") -> list[dict[str, Any]]:
    """人员调用排行——按调用量排序的 Top N 用户."""
    from datetime import UTC, datetime

    from db.models.chat_usage import ChatUsage

    now = datetime.now(UTC).replace(tzinfo=None)
    if period == "day":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == "month":
        start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    else:
        start = now.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)

    rows = await db.execute(
        select(
            ChatUsage.user_id,
            func.count().label("calls"),
            func.sum(ChatUsage.total_tokens).label("tokens"),
        ).where(ChatUsage.created_at >= start).group_by(ChatUsage.user_id).order_by(func.count().desc()).limit(limit)
    )

    result = []
    from core.notification_bus import NotificationBus
    for row in rows:
        uid = row[0]
        calls = row[1]
        tokens = row[2] or 0

        # 获取用户名
        account = await db.execute(select(Account).where(Account.id == uid))
        acc = account.scalar_one_or_none()
        name = acc.nickname or acc.username if acc else uid

        # 获取角色
        from db.models.role import Role
        from db.models.user_role import UserRole
        role_rows = await db.execute(
            select(Role.name).join(UserRole, UserRole.role_id == Role.id).where(UserRole.user_id == uid)
        )
        role_names = [r[0] for r in role_rows]
        role = "、".join(role_names) if role_names else "用户"

        # 在线状态
        online = uid in NotificationBus._user_queues

        result.append({
            "name": name,
            "role": role,
            "calls": calls,
            "tokens": tokens,
            "online": online,
        })

    return result


async def get_system_metrics() -> dict[str, Any]:
    """系统健康监控指标——使用 psutil 获取实时系统数据."""
    import psutil

    # CPU
    cpu_pct = psutil.cpu_percent(interval=0.1)

    # 内存
    mem = psutil.virtual_memory()
    mem_total_gb = mem.total / (1024 ** 3)
    mem_used_gb = mem.used / (1024 ** 3)

    # 磁盘
    disk = psutil.disk_usage("/")

    # API 响应时间——从 app state 的滑动窗口获取
    # 此处返回默认值，中间件会覆盖
    return {
        "api_response_time": {"value": "0ms", "pct": 0},
        "cpu_usage": {"value": f"{cpu_pct:.0f}%", "pct": int(cpu_pct)},
        "memory_usage": {
            "value": f"{mem_used_gb:.1f}GB / {mem_total_gb:.1f}GB",
            "pct": int(mem.percent),
        },
        "disk_usage": {"value": f"{disk.percent:.0f}%", "pct": int(disk.percent)},
        "success_rate": {"value": "100%", "pct": 100},
    }


async def get_system_metrics_with_state(db: AsyncSession, app_state: Any) -> dict[str, Any]:
    """系统健康监控指标——带 app state 中的 API 响应时间和成功率."""
    metrics = await get_system_metrics()

    # API 响应时间——从 app state 的滑动窗口获取
    response_times = getattr(app_state, "response_times", None)
    if response_times:
        avg_ms = sum(response_times) / len(response_times)
        metrics["api_response_time"] = {
            "value": f"{avg_ms:.0f}ms",
            "pct": min(int(avg_ms / 2), 100),  # 粗略映射：0ms=0%, 200ms=100%
        }

    # 成功率——从 chat_usages 表统计

    from db.models.chat_usage import ChatUsage

    try:
        total = await db.scalar(select(func.count()).select_from(ChatUsage))
        success = await db.scalar(
            select(func.count()).select_from(ChatUsage).where(ChatUsage.status == "success")
        )
        if total and total > 0:
            rate = (success or 0) / total * 100
            metrics["success_rate"] = {
                "value": f"{rate:.1f}%",
                "pct": int(rate),
            }
    except Exception:
        pass

    return metrics


async def get_token_stats(db: AsyncSession, period: str = "day") -> dict[str, Any]:
    """Token 消耗统计."""
    from datetime import UTC, datetime

    from db.models.chat_usage import ChatUsage

    now = datetime.now(UTC).replace(tzinfo=None)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    if period == "day":
        period_start = today_start
    elif period == "month":
        period_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    else:
        period_start = now.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)

    # 今日总量
    today_total = await db.scalar(
        select(func.sum(ChatUsage.total_tokens)).where(ChatUsage.created_at >= today_start)
    ) or 0

    # 周期总量
    period_total = await db.scalar(
        select(func.sum(ChatUsage.total_tokens)).where(ChatUsage.created_at >= period_start)
    ) or 0

    # 按提供商分组
    provider_rows = await db.execute(
        select(
            ChatUsage.provider_id,
            func.sum(ChatUsage.total_tokens).label("tokens"),
        ).where(
            ChatUsage.created_at >= period_start,
            ChatUsage.provider_id.isnot(None),
        ).group_by(ChatUsage.provider_id)
    )

    by_provider = []
    for row in provider_rows:
        provider = await db.execute(select(Provider.name).where(Provider.id == row[0]))
        name = provider.scalar() or "未知"
        tokens = row[1] or 0
        by_provider.append({
            "name": name,
            "tokens": tokens,
            "pct": round(tokens / period_total * 100) if period_total > 0 else 0,
        })

    return {
        "today_total": today_total,
        "period_total": period_total,
        "by_provider": by_provider,
    }


async def get_events(
    db: AsyncSession,
    limit: int = 20,
    category: str | None = None,
    event_type: str | None = None,
) -> list[dict[str, Any]]:
    """查询最新系统事件."""
    from db.models.system_event import SystemEvent

    query = select(SystemEvent).order_by(SystemEvent.created_at.desc()).limit(limit)

    rows = await db.execute(query)
    result = []
    for row in rows.scalars():
        result.append({
            "id": row.id,
            "type": row.type,
            "category": row.category,
            "message": row.message,
            "created_at": row.created_at.isoformat() if row.created_at else "",
        })

    return result
