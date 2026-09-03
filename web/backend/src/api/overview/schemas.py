"""概览统计响应模型."""

from __future__ import annotations

from pydantic import BaseModel


class CountPair(BaseModel):
    """总数 / 有效数 的一对统计值."""
    total: int = 0
    enabled: int = 0


class AgentCount(BaseModel):
    """按类型统计的代理数量."""
    main: int = 0
    sub: int = 0


class ResourceStats(BaseModel):
    """资源类统计聚合结果."""
    tools: CountPair = CountPair()
    skills: CountPair = CountPair()
    cron_jobs: CountPair = CountPair()
    agents: AgentCount = AgentCount()
    mcp_services: CountPair = CountPair()
    personnel: CountPair = CountPair()
    providers: CountPair = CountPair()
    models: CountPair = CountPair()
    system_status: str = "ok"


class HealthCheck(BaseModel):
    """单项健康检查结果."""
    name: str
    status: str  # ok / error


class SystemHealth(BaseModel):
    """系统健康检查结果."""
    status: str  # ok / degraded / error
    uptime_seconds: int = 0
    started_at: str = ""
    db_connected: bool = False
    checks: list[HealthCheck] = []
