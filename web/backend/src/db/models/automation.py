"""自动化任务与运行记录 ORM 模型.

该模块承载 Web 版「定时任务」菜单的持久化数据，语义对齐桌面版自动化：
任务定义、排期、运行记录、失败原因与产物均独立保存，不与 Agent 下的
历史 cron_jobs 表混用。
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from sqlalchemy import JSON, BigInteger, Boolean, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


def _now_ms() -> int:
    """返回当前毫秒时间戳."""
    return int(time.time() * 1000)


class AutomationTask(Base):
    """用户创建的自动化任务."""

    __tablename__ = "automation_tasks"
    __table_args__ = (
        Index("idx_auto_tasks_user", "user_id", "created_at"),
        Index("idx_auto_tasks_due", "enabled", "status", "next_run_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(100), nullable=False)
    prompt_text: Mapped[str] = mapped_column(Text, default="")
    prompt_parts: Mapped[list[Any]] = mapped_column(JSON, default=list)
    icon: Mapped[str] = mapped_column(String(16), default="⏰")
    source: Mapped[str] = mapped_column(String(16), default="custom")
    template_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    schedule: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    freq_summary: Mapped[str] = mapped_column(String(128), default="")
    validity_summary: Mapped[str] = mapped_column(String(128), default="")
    valid_from_ts: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    valid_to_ts: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    custom_model_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    provider_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    model_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    expert_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    expert_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    context_mode: Mapped[str] = mapped_column(String(16), default="default")
    skill_ids: Mapped[list[Any]] = mapped_column(JSON, default=list)
    kb_ids: Mapped[list[Any]] = mapped_column(JSON, default=list)
    workspace_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    workspace_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    allow_network: Mapped[bool] = mapped_column(Boolean, default=False)
    allow_shell: Mapped[bool] = mapped_column(Boolean, default=False)
    full_access: Mapped[bool] = mapped_column(Boolean, default=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[str] = mapped_column(String(16), default="enabled")
    next_run_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    last_run_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    last_run_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    run_count: Mapped[int] = mapped_column(Integer, default=0)
    fail_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[int] = mapped_column(BigInteger, default=_now_ms)
    updated_at: Mapped[int] = mapped_column(
        BigInteger, default=_now_ms, onupdate=_now_ms
    )
    deleted_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)


class AutomationRun(Base):
    """自动化任务的一次运行记录."""

    __tablename__ = "automation_runs"
    __table_args__ = (
        Index("idx_auto_runs_task", "task_id", "started_at"),
        Index("idx_auto_runs_user", "user_id", "started_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    task_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    trigger: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    scheduled_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    started_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    finished_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    conversation_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    thread_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    output_preview: Mapped[str | None] = mapped_column(Text, nullable=True)
    output_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(32), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    artifacts: Mapped[list[Any]] = mapped_column(JSON, default=list)
    token_usage: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
