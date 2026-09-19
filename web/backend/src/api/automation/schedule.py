"""自动化排期计算.

排期语义与桌面版 AutomationSchedule 保持一致：
- 周期任务支持单次、每天、每周、每月、每年；
- 间隔任务支持按星期和每隔 N 小时；
- 指定时间段任务到期后进入 expired，单次任务执行后进入 finished；
- 间隔任务按上次运行结束时间推进，避免任务堆积。
"""

from __future__ import annotations

from calendar import monthrange
from datetime import datetime

from api.automation.schemas import AutomationSchedule

HOUR_MS = 3600 * 1000
WEEKDAY_LABELS = ("一", "二", "三", "四", "五", "六", "日")


def parse_time(value: str) -> tuple[int, int]:
    """解析 HH:mm，非法时回落到 00:00."""
    parts = str(value).strip().split(":")
    if len(parts) != 2:
        return 0, 0
    try:
        hour = int(parts[0])
        minute = int(parts[1])
    except ValueError:
        return 0, 0
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        return 0, 0
    return hour, minute


def parse_date(value: str) -> tuple[int, int, int] | None:
    """解析 YYYY-MM-DD，非法时返回 None."""
    parts = str(value).strip().split("-")
    if len(parts) != 3:
        return None
    try:
        year = int(parts[0])
        month = int(parts[1])
        day = int(parts[2])
        datetime(year, month, day)
    except ValueError:
        return None
    if year < 1970 or year > 9999:
        return None
    return year, month, day


def local_ts(year: int, month: int, day: int, hour: int, minute: int) -> int:
    """构造本地时区毫秒时间戳."""
    return int(datetime(year, month, day, hour, minute).timestamp() * 1000)


def iso_weekday(value: datetime) -> int:
    """ISO 星期：1 为周一、7 为周日."""
    return value.isoweekday()


def days_in_month(year: int, month: int) -> int:
    """指定月份天数."""
    return monthrange(year, month)[1]


def normalize_week_days(days: list[int]) -> list[int]:
    """星期列表去重、排序并过滤非法值."""
    valid = [day for day in days if isinstance(day, int) and 1 <= day <= 7]
    return sorted(set(valid))


def week_days_text(days: list[int]) -> str:
    """星期文案，例如 一、三."""
    return "、".join(WEEKDAY_LABELS[day - 1] for day in normalize_week_days(days))


def next_weekly(
    from_ts: int, week_days: list[int], hour: int, minute: int
) -> int | None:
    """找出 from_ts 之后最近的命中星期."""
    days = normalize_week_days(week_days)
    if not days:
        return None
    base = datetime.fromtimestamp(from_ts / 1000)
    for offset in range(0, 8):
        candidate_date = base.fromordinal(base.date().toordinal() + offset)
        if iso_weekday(candidate_date) not in days:
            continue
        candidate = datetime(
            candidate_date.year,
            candidate_date.month,
            candidate_date.day,
            hour,
            minute,
        )
        candidate_ts = int(candidate.timestamp() * 1000)
        if candidate_ts > from_ts:
            return candidate_ts
    return None


def next_monthly(from_ts: int, day: int, hour: int, minute: int) -> int | None:
    """每月第 day 天，超出当月天数时落到当月最后一天."""
    target = min(max(int(day), 1), 31)
    base = datetime.fromtimestamp(from_ts / 1000)
    for offset in range(0, 24):
        month_index = base.month - 1 + offset
        year = base.year + month_index // 12
        month = month_index % 12 + 1
        clamped = min(target, days_in_month(year, month))
        candidate_ts = local_ts(year, month, clamped, hour, minute)
        if candidate_ts > from_ts:
            return candidate_ts
    return None


def next_yearly(
    from_ts: int, month: int, day: int, hour: int, minute: int
) -> int | None:
    """每年 month 月 day 日，闰年 2-29 在平年落到 2-28."""
    safe_month = min(max(int(month), 1), 12)
    target = max(int(day), 1)
    start_year = datetime.fromtimestamp(from_ts / 1000).year
    for offset in range(0, 8):
        year = start_year + offset
        clamped = min(target, days_in_month(year, safe_month))
        candidate_ts = local_ts(year, safe_month, clamped, hour, minute)
        if candidate_ts > from_ts:
            return candidate_ts
    return None


def validity_bounds(schedule: AutomationSchedule) -> tuple[int | None, int | None]:
    """有效期毫秒边界，长期有效或单次任务返回 (None, None)."""
    if schedule.validity_mode != "range":
        return None, None
    from_date = parse_date(schedule.valid_from)
    to_date = parse_date(schedule.valid_to)
    from_time = parse_time(schedule.valid_from_time)
    to_time = parse_time(schedule.valid_to_time)
    valid_from_ts = (
        local_ts(from_date[0], from_date[1], from_date[2], from_time[0], from_time[1])
        if from_date
        else None
    )
    valid_to_ts = (
        local_ts(to_date[0], to_date[1], to_date[2], to_time[0], to_time[1])
        if to_date
        else None
    )
    return valid_from_ts, valid_to_ts


def compute_next_run(
    schedule: AutomationSchedule,
    *,
    from_ts: int,
    valid_to_ts: int | None = None,
    last_run_at: int | None = None,
    executed_once: bool = False,
) -> tuple[int | None, str | None]:
    """计算下一次触发时间，并返回 terminal 状态或 None."""

    def clamp(candidate: int | None) -> tuple[int | None, str | None]:
        if candidate is None:
            return None, "expired"
        if valid_to_ts is not None and candidate > valid_to_ts:
            return None, "expired"
        return candidate, None

    if valid_to_ts is not None and from_ts > valid_to_ts:
        return None, "expired"

    hour, minute = parse_time(schedule.once_time)

    if schedule.freq_group == "cycle":
        if schedule.cycle_kind == "once":
            if executed_once:
                return None, "finished"
            date = parse_date(schedule.once_date)
            if date is None:
                return None, "finished"
            candidate = local_ts(date[0], date[1], date[2], hour, minute)
            if candidate <= from_ts:
                return None, "finished"
            return clamp(candidate)

        if schedule.cycle_kind == "daily":
            base = datetime.fromtimestamp(from_ts / 1000)
            candidate = local_ts(base.year, base.month, base.day, hour, minute)
            if candidate <= from_ts:
                base = base.fromordinal(base.date().toordinal() + 1)
                candidate = local_ts(base.year, base.month, base.day, hour, minute)
            return clamp(candidate)

        if schedule.cycle_kind == "weekly":
            return clamp(next_weekly(from_ts, schedule.week_days, hour, minute))

        if schedule.cycle_kind == "monthly":
            return clamp(next_monthly(from_ts, schedule.month_day, hour, minute))

        return clamp(
            next_yearly(from_ts, schedule.year_month, schedule.year_day, hour, minute)
        )

    if schedule.interval_kind == "weekly":
        return clamp(next_weekly(from_ts, schedule.week_interval_days, 0, 0))

    hours = min(max(int(schedule.hour_interval), 1), 24)
    step = hours * HOUR_MS
    base_ts = last_run_at if last_run_at is not None and last_run_at > 0 else from_ts
    candidate = base_ts + step
    while candidate <= from_ts:
        candidate += step
    return clamp(candidate)


def build_freq_summary(schedule: AutomationSchedule) -> str:
    """频率摘要文案."""
    if schedule.freq_group == "cycle":
        if schedule.cycle_kind == "once":
            return "单次 " + schedule.once_date + " " + schedule.once_time
        if schedule.cycle_kind == "daily":
            return "每天 " + schedule.once_time
        if schedule.cycle_kind == "weekly":
            return (
                "每周" + week_days_text(schedule.week_days) + " " + schedule.once_time
            )
        if schedule.cycle_kind == "monthly":
            return "每月 " + str(schedule.month_day) + " 日 " + schedule.once_time
        return (
            "每年 "
            + str(schedule.year_month)
            + " 月 "
            + str(schedule.year_day)
            + " 日 "
            + schedule.once_time
        )
    if schedule.interval_kind == "weekly":
        return "每周" + week_days_text(schedule.week_interval_days) + " 执行"
    return "每隔 " + str(schedule.hour_interval) + " 小时执行 1 次"


def build_validity_summary(schedule: AutomationSchedule) -> str:
    """有效期摘要文案."""
    if schedule.freq_group == "cycle" and schedule.cycle_kind == "once":
        return "单次执行"
    if schedule.validity_mode == "forever":
        return "长期有效"
    return (
        schedule.valid_from
        + " "
        + schedule.valid_from_time
        + " 至 "
        + schedule.valid_to
        + " "
        + schedule.valid_to_time
    )
