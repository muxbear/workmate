"""自动化执行器单元测试（隔离内存库与假 Agent）."""

from collections.abc import AsyncGenerator

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from api.automation import runner as runner_module
from api.automation.runner import AutomationRunner
from api.automation.schemas import AutomationTaskDraft
from api.automation.service import create_task
from db.base import Base
from db.models.automation import AutomationRun, AutomationTask

pytestmark = pytest.mark.anyio


@pytest.fixture
async def session_maker() -> AsyncGenerator[async_sessionmaker[AsyncSession], None]:
    """创建与执行器共享的内存数据库会话工厂."""
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


def draft() -> AutomationTaskDraft:
    """构造一个每天执行的任务."""
    return AutomationTaskDraft.model_validate(
        {
            "title": "执行器测试",
            "promptText": "输出 done",
            "promptParts": [{"type": "text", "text": "输出 done"}],
            "schedule": {
                "freqGroup": "cycle",
                "cycleKind": "daily",
                "intervalKind": "hourly",
                "onceDate": "",
                "onceTime": "08:00",
                "weekDays": [1],
                "monthDay": 1,
                "yearMonth": 1,
                "yearDay": 1,
                "weekIntervalDays": [1],
                "hourInterval": 2,
                "validityMode": "forever",
                "validFrom": "",
                "validFromTime": "00:00",
                "validTo": "",
                "validToTime": "23:59",
            },
        }
    )


async def test_runner_writes_success_and_reschedules(
    session_maker: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = AutomationRunner()
    monkeypatch.setattr(runner_module, "async_session", session_maker)

    async def fake_invoke(_task: AutomationTask) -> tuple[str, list[dict[str, object]]]:
        return "done", [{"name": "result.txt", "path": "/result.txt"}]

    monkeypatch.setattr(runner, "_invoke_agent", fake_invoke)

    async with session_maker() as db:
        task = await create_task(db, "user-1", draft())
        task_id = task.id

    run_id = await runner._prepare_run(
        "user-1",
        task_id,
        "manual",
        None,
        require_due=False,
    )
    assert run_id is not None
    await runner._execute(run_id)

    async with session_maker() as db:
        run = await db.get(AutomationRun, run_id)
        fresh = await db.get(AutomationTask, task_id)
        assert run is not None
        assert fresh is not None
        assert run.status == "success"
        assert run.output_text == "done"
        assert run.artifacts[0]["name"] == "result.txt"
        assert fresh.run_count == 1
        assert fresh.last_run_status == "success"
        assert fresh.next_run_at is not None
