"""自动化排期计算单元测试."""

from datetime import datetime

from api.automation.schedule import (
    build_freq_summary,
    compute_next_run,
    validity_bounds,
)
from api.automation.schemas import AutomationSchedule


def ts(year: int, month: int, day: int, hour: int, minute: int) -> int:
    """构造本地毫秒时间戳."""
    return int(datetime(year, month, day, hour, minute).timestamp() * 1000)


def make_schedule(**overrides: object) -> AutomationSchedule:
    """构造带默认值的排期配置."""
    data: dict[str, object] = {
        "freq_group": "cycle",
        "cycle_kind": "daily",
        "interval_kind": "hourly",
        "once_time": "08:00",
        "week_days": [1],
        "month_day": 1,
        "year_month": 1,
        "year_day": 1,
        "week_interval_days": [1],
        "hour_interval": 2,
        "validity_mode": "forever",
    }
    data.update(overrides)
    return AutomationSchedule.model_validate(data)


def test_daily_next_run_moves_to_tomorrow_after_time() -> None:
    schedule = make_schedule(cycle_kind="daily", once_time="08:00")
    next_run, terminal = compute_next_run(schedule, from_ts=ts(2026, 9, 19, 9, 0))
    assert terminal is None
    assert next_run == ts(2026, 9, 20, 8, 0)


def test_weekly_next_run_hits_selected_weekday() -> None:
    schedule = make_schedule(cycle_kind="weekly", week_days=[1], once_time="09:30")
    next_run, terminal = compute_next_run(schedule, from_ts=ts(2026, 9, 19, 10, 0))
    assert terminal is None
    assert next_run == ts(2026, 9, 21, 9, 30)


def test_monthly_clamps_to_last_day() -> None:
    schedule = make_schedule(cycle_kind="monthly", month_day=31, once_time="23:00")
    next_run, terminal = compute_next_run(schedule, from_ts=ts(2026, 2, 1, 0, 0))
    assert terminal is None
    assert next_run == ts(2026, 2, 28, 23, 0)


def test_interval_uses_last_run_finish_time() -> None:
    schedule = make_schedule(
        freq_group="interval", interval_kind="hourly", hour_interval=2
    )
    next_run, terminal = compute_next_run(
        schedule,
        from_ts=ts(2026, 9, 19, 10, 5),
        last_run_at=ts(2026, 9, 19, 10, 0),
    )
    assert terminal is None
    assert next_run == ts(2026, 9, 19, 12, 0)


def test_once_task_finishes_after_execution() -> None:
    schedule = make_schedule(
        cycle_kind="once", once_date="2026-09-20", once_time="08:00"
    )
    next_run, terminal = compute_next_run(
        schedule,
        from_ts=ts(2026, 9, 19, 10, 0),
        executed_once=True,
    )
    assert next_run is None
    assert terminal == "finished"


def test_validity_range_expires_after_end() -> None:
    schedule = make_schedule(
        cycle_kind="daily",
        once_time="08:00",
        validity_mode="range",
        valid_from="2026-09-01",
        valid_from_time="00:00",
        valid_to="2026-09-19",
        valid_to_time="08:00",
    )
    valid_from_ts, valid_to_ts = validity_bounds(schedule)
    assert valid_from_ts == ts(2026, 9, 1, 0, 0)
    assert valid_to_ts == ts(2026, 9, 19, 8, 0)
    next_run, terminal = compute_next_run(
        schedule,
        from_ts=ts(2026, 9, 19, 9, 0),
        valid_to_ts=valid_to_ts,
    )
    assert next_run is None
    assert terminal == "expired"


def test_frequency_summary_is_human_readable() -> None:
    schedule = make_schedule(cycle_kind="weekly", week_days=[1, 3], once_time="08:30")
    assert build_freq_summary(schedule) == "每周一、三 08:30"
