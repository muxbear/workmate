"""自动化任务服务 CRUD 单元测试."""

from collections.abc import AsyncGenerator

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from api.automation.schemas import AutomationTaskDraft
from api.automation.service import (
    create_task,
    delete_task,
    get_task,
    list_tasks,
    run_stats,
    set_task_enabled,
    update_task,
)
from db.base import Base

pytestmark = pytest.mark.anyio


@pytest.fixture
async def session() -> AsyncGenerator[AsyncSession, None]:
    """创建隔离的内存数据库会话."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        yield db
    await engine.dispose()


def draft(**overrides: object) -> AutomationTaskDraft:
    """构造任务草稿."""
    data: dict[str, object] = {
        "title": "每日摘要",
        "promptText": "请汇总今天的重点内容",
        "promptParts": [{"type": "text", "text": "请汇总今天的重点内容"}],
        "icon": "⏰",
        "source": "custom",
        "templateId": None,
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
        "model": None,
        "customModelId": None,
        "providerId": None,
        "modelId": None,
        "expertId": None,
        "expertName": None,
        "contextMode": "default",
        "skillIds": [],
        "kbIds": [],
        "workspaceId": None,
        "workspaceName": None,
        "allowNetwork": False,
        "allowShell": False,
        "fullAccess": False,
    }
    data.update(overrides)
    return AutomationTaskDraft.model_validate(data)


async def test_create_list_update_delete(session: AsyncSession) -> None:
    created = await create_task(session, "user-1", draft())
    assert created.title == "每日摘要"
    assert created.freq_summary == "每天 08:00"
    assert created.next_run_at is not None

    tasks = await list_tasks(session, "user-1")
    assert len(tasks) == 1
    assert tasks[0].id == created.id

    updated = await update_task(
        session,
        "user-1",
        created.id,
        draft(
            title="每周摘要",
            schedule={
                **draft().schedule.model_dump(by_alias=True),
                "cycleKind": "weekly",
                "weekDays": [5],
                "onceTime": "18:00",
            },
        ),
    )
    assert updated.title == "每周摘要"
    assert updated.freq_summary.startswith("每周")

    paused = await set_task_enabled(session, "user-1", created.id, False)
    assert paused.enabled is False
    assert paused.next_run_at is None

    await delete_task(session, "user-1", created.id)
    with pytest.raises(Exception):
        await get_task(session, "user-1", created.id)


async def test_user_isolation_and_stats(session: AsyncSession) -> None:
    created = await create_task(session, "user-1", draft())
    assert await list_tasks(session, "user-2") == []
    stats = await run_stats(session, "user-1")
    assert stats.total == 0
    assert created.id
