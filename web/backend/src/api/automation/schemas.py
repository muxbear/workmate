"""自动化任务 API Schema."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


def to_camel(value: str) -> str:
    """snake_case 转 camelCase，供前端直接使用."""
    first, *rest = value.split("_")
    return first + "".join(part[:1].upper() + part[1:] for part in rest)


class CamelModel(BaseModel):
    """统一 camelCase 序列化模型."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        from_attributes=True,
        extra="ignore",
    )


class PromptPart(CamelModel):
    """任务提示词部件."""

    type: Literal["text", "file"]
    text: str | None = None
    attachment_id: str | None = None
    filename: str | None = None


class AutomationSchedule(CamelModel):
    """执行频率与有效期配置."""

    freq_group: Literal["cycle", "interval"] = "cycle"
    cycle_kind: Literal["once", "daily", "weekly", "monthly", "yearly"] = "daily"
    interval_kind: Literal["weekly", "hourly"] = "hourly"
    once_date: str = ""
    once_time: str = "08:00"
    week_days: list[int] = Field(default_factory=list)
    month_day: int = 1
    year_month: int = 1
    year_day: int = 1
    week_interval_days: list[int] = Field(default_factory=list)
    hour_interval: int = 2
    validity_mode: Literal["forever", "range"] = "forever"
    valid_from: str = ""
    valid_from_time: str = "00:00"
    valid_to: str = ""
    valid_to_time: str = "23:59"

    @model_validator(mode="after")
    def _validate(self) -> AutomationSchedule:
        if (
            self.freq_group == "cycle"
            and self.cycle_kind == "once"
            and not self.once_date
        ):
            raise ValueError("单次任务需要选择执行日期")
        if self.validity_mode == "range" and (not self.valid_from or not self.valid_to):
            raise ValueError("指定时间段需要填写开始与结束日期")
        if (
            self.freq_group == "cycle"
            and self.cycle_kind == "weekly"
            and not self.week_days
        ):
            raise ValueError("每周任务至少选择一个星期")
        if (
            self.freq_group == "interval"
            and self.interval_kind == "weekly"
            and not self.week_interval_days
        ):
            raise ValueError("每周任务至少选择一个星期")
        return self


class AutomationTaskDraft(CamelModel):
    """新建或更新自动化任务的请求体."""

    title: str | None = Field(default=None, max_length=100)
    prompt_text: str = Field(default="", max_length=20000)
    prompt_parts: list[PromptPart] = Field(default_factory=list, max_length=50)
    icon: str = Field(default="⏰", max_length=16)
    source: Literal["custom", "template"] = "custom"
    template_id: str | None = Field(default=None, max_length=64)
    schedule: AutomationSchedule
    model: str | None = Field(default=None, max_length=128)
    custom_model_id: str | None = Field(default=None, max_length=128)
    provider_id: str | None = Field(default=None, max_length=36)
    model_id: str | None = Field(default=None, max_length=36)
    expert_id: str | None = Field(default=None, max_length=36)
    expert_name: str | None = Field(default=None, max_length=128)
    context_mode: Literal["default", "files", "knowledge"] = "default"
    skill_ids: list[str] = Field(default_factory=list, max_length=50)
    kb_ids: list[str] = Field(default_factory=list, max_length=20)
    workspace_id: str | None = Field(default=None, max_length=128)
    workspace_name: str | None = Field(default=None, max_length=128)
    allow_network: bool = False
    allow_shell: bool = False
    full_access: bool = False

    @model_validator(mode="after")
    def _validate_content(self) -> AutomationTaskDraft:
        has_text = bool((self.prompt_text or "").strip())
        has_file = any(
            part.type == "file" and part.attachment_id for part in self.prompt_parts
        )
        if not has_text and not has_file:
            raise ValueError("请先填写任务描述或提示词")
        return self


class AutomationTaskResponse(AutomationTaskDraft):
    """自动化任务响应体."""

    title: str
    id: str
    status: str
    enabled: bool
    freq_summary: str
    validity_summary: str
    valid_from_ts: int | None = None
    valid_to_ts: int | None = None
    next_run_at: int | None = None
    last_run_at: int | None = None
    last_run_status: str | None = None
    run_count: int = 0
    fail_count: int = 0
    created_at: int
    updated_at: int


class AutomationRunResponse(CamelModel):
    """运行记录响应体."""

    id: str
    task_id: str
    trigger: str
    status: str
    scheduled_at: int | None = None
    started_at: int
    finished_at: int | None = None
    duration_ms: int | None = None
    conversation_id: str | None = None
    thread_id: str | None = None
    output_preview: str | None = None
    output_text: str | None = None
    model: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    artifacts: list[dict[str, Any]] = Field(default_factory=list)
    token_usage: dict[str, Any] | None = None


class AutomationRunStats(CamelModel):
    """运行统计."""

    total: int = 0
    success: int = 0
    failed: int = 0
    skipped: int = 0
    running: int = 0
    avg_duration_ms: int | None = None


class EnabledRequest(CamelModel):
    """暂停或继续任务请求."""

    enabled: bool


class RunNowResponse(CamelModel):
    """立即运行响应."""

    run_id: str
