"""自动化任务接口集成测试.

单独装配一个只挂载自动化路由的 FastAPI 应用并注入内存数据库，
避免依赖全局 lifespan（其 MCP 会话管理器是单例，无法在测试中重复启动）。
断言使用前端真实请求体与 camelCase 响应字段，覆盖前后端接口契约。
"""

from collections.abc import AsyncGenerator

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from api.automation.automation_api import router as automation_router
from api.deps import get_current_user_id, get_db
from db.base import Base

pytestmark = pytest.mark.anyio

USER_ID = "user-automation"


def draft_payload(**overrides: object) -> dict[str, object]:
    """构造与前端一致的 camelCase 请求体."""
    payload: dict[str, object] = {
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
    payload.update(overrides)
    return payload


@pytest.fixture
async def api_client() -> AsyncGenerator[AsyncClient, None]:
    """内存数据库 + 固定用户身份的路由测试客户端."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)

    async def override_db() -> AsyncGenerator[AsyncSession, None]:
        async with maker() as session:
            yield session

    async def override_user() -> str:
        return USER_ID

    app = FastAPI()
    app.include_router(automation_router)
    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user_id] = override_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
    await engine.dispose()


async def test_task_crud_schedule_and_stats(api_client: AsyncClient) -> None:
    """任务增删改查、暂停继续与排期重算."""
    create = await api_client.post("/api/automation/tasks", json=draft_payload())
    assert create.status_code == 200
    created = create.json()["data"]
    assert created["title"] == "每日摘要"
    assert created["freqSummary"] == "每天 08:00"
    assert created["validitySummary"] == "长期有效"
    assert created["status"] == "enabled"
    assert created["enabled"] is True
    assert created["nextRunAt"] is not None
    assert created["runCount"] == 0
    task_id = created["id"]

    listed = await api_client.get("/api/automation/tasks")
    assert [item["id"] for item in listed.json()["data"]] == [task_id]

    weekly = {
        **draft_payload()["schedule"],
        "cycleKind": "weekly",
        "weekDays": [5],
        "onceTime": "18:00",
    }
    updated = await api_client.put(
        f"/api/automation/tasks/{task_id}",
        json=draft_payload(title="每周摘要", schedule=weekly),
    )
    assert updated.json()["data"]["freqSummary"].startswith("每周五")

    paused = await api_client.patch(
        f"/api/automation/tasks/{task_id}/enabled", json={"enabled": False}
    )
    assert paused.json()["data"]["enabled"] is False
    assert paused.json()["data"]["nextRunAt"] is None
    assert paused.json()["data"]["status"] == "paused"

    resumed = await api_client.patch(
        f"/api/automation/tasks/{task_id}/enabled", json={"enabled": True}
    )
    assert resumed.json()["data"]["nextRunAt"] is not None

    runs = await api_client.get("/api/automation/runs", params={"limit": 50})
    assert runs.json()["data"] == []

    stats = await api_client.get("/api/automation/runs/stats")
    assert stats.json()["data"] == {
        "total": 0,
        "success": 0,
        "failed": 0,
        "skipped": 0,
        "running": 0,
        "avgDurationMs": None,
    }

    removed = await api_client.delete(f"/api/automation/tasks/{task_id}")
    assert removed.json()["code"] == 0
    after = await api_client.get("/api/automation/tasks")
    assert after.json()["data"] == []

    missing = await api_client.get(f"/api/automation/tasks/{task_id}")
    assert missing.json()["code"] == 404


async def test_prompt_parts_and_validation(api_client: AsyncClient) -> None:
    """提示词部件（文本 + 附件）、上下文配置与入参校验."""
    payload = draft_payload(
        promptText="读取附件后总结",
        promptParts=[
            {"type": "text", "text": "读取附件后总结"},
            {"type": "file", "attachmentId": "att-1", "filename": "报告.pdf"},
        ],
        contextMode="files",
        kbIds=["kb-1"],
        workspaceId="my-files",
        allowNetwork=True,
        model="deepseek-v4-pro",
        providerId="provider-1",
        modelId="model-1",
    )
    response = await api_client.post("/api/automation/tasks", json=payload)
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["promptParts"][1]["attachmentId"] == "att-1"
    assert data["promptParts"][1]["filename"] == "报告.pdf"
    assert data["contextMode"] == "files"
    assert data["kbIds"] == ["kb-1"]
    assert data["allowNetwork"] is True
    assert data["model"] == "deepseek-v4-pro"

    empty = await api_client.post(
        "/api/automation/tasks", json=draft_payload(promptText="", promptParts=[])
    )
    assert empty.status_code == 422

    bad_schedule = await api_client.post(
        "/api/automation/tasks",
        json=draft_payload(
            schedule={
                **draft_payload()["schedule"],
                "cycleKind": "once",
                "onceDate": "",
            }
        ),
    )
    assert bad_schedule.status_code == 422
