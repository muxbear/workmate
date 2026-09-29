"""定时模板同步接口（桌面端）集成测试.

单独装配一个只挂载同步路由的 FastAPI 应用并注入内存数据库（与
``test_automation_templates_api.py`` 同法）。

与模板 CRUD 接口不同，这里**不替换** scope 依赖——本文件要测的正是 scope 门禁本身：
客户端 token（带 ``client_id`` claim）缺 ``template:read`` 必须 403，第一方 Web token
（无 ``client_id``）按自身登录态放行（判定口径见 ``api/deps.py:scope_missing``）。
"""

from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from api.automation.template_sync_api import router as template_sync_router
from api.deps import get_db
from core.security import create_token_pair
from db.base import Base
from db.models.automation import AutomationTemplate
from db.soft_delete import install_soft_delete_filter

pytestmark = pytest.mark.anyio

USER_ID = "user-template-sync"
SYNC_PREFIX = "/api/automation-template-sync"
SCOPE = "template:read"

SCHEDULE = {
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
}


def make_template(
    template_id: str, name: str, deleted: bool = False
) -> AutomationTemplate:
    """构造一条模板行（同步接口只读，这里直接落库免去绕权限）."""
    return AutomationTemplate(
        id=template_id,
        created_by=USER_ID,
        name=name,
        description="描述",
        icon="⏰",
        category="work",
        version="1.0.0",
        prompt_text="提示词",
        prompt_parts=[{"type": "text", "text": "提示词"}],
        schedule=SCHEDULE,
        freq_summary="每天 08:00",
        validity_summary="长期有效",
        context_mode="default",
        skill_ids=[],
        kb_ids=[],
        allow_network=False,
        allow_shell=False,
        full_access=False,
        deleted_at=1 if deleted else None,
    )


@pytest_asyncio.fixture
async def session_maker() -> AsyncGenerator[async_sessionmaker[AsyncSession], None]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    install_soft_delete_filter()
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as session:
        session.add_all(
            [
                make_template("t-1", "每日行业简报"),
                make_template("t-2", "周报汇总"),
                make_template("t-deleted", "已下架模板", deleted=True),
            ]
        )
        await session.commit()
    yield maker
    await engine.dispose()


@pytest_asyncio.fixture
async def api_client(
    session_maker: async_sessionmaker[AsyncSession],
) -> AsyncGenerator[AsyncClient, None]:
    async def override_db() -> AsyncGenerator[AsyncSession, None]:
        async with session_maker() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app = FastAPI()
    app.include_router(template_sync_router)
    app.dependency_overrides[get_db] = override_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


def client_token(scope: str) -> str:
    """桌面端 OAuth2 客户端 token（带 client_id claim，受 scope 约束）."""
    return create_token_pair(
        USER_ID, extra={"client_id": "ke-work-desktop", "scope": scope}
    ).accessToken


def web_token() -> str:
    """第一方 Web token（无 client_id claim，不受 scope 约束）."""
    return create_token_pair(USER_ID).accessToken


async def test_sync_list_returns_all_templates_for_scope_holder(
    api_client: AsyncClient,
) -> None:
    """带 template:read 的客户端可拿到全量模板，字段为 camelCase、信封含 total."""
    response = await api_client.get(
        f"{SYNC_PREFIX}/list",
        headers={"Authorization": f"Bearer {client_token(SCOPE)}"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["code"] == 0
    data = body["data"]
    assert data["total"] == 2
    assert data["page"] == 1
    assert data["page_size"] == 100
    assert {item["id"] for item in data["items"]} == {"t-1", "t-2"}

    item = next(it for it in data["items"] if it["id"] == "t-1")
    # camelCase 契约（桌面端按这些名字映射）
    assert item["name"] == "每日行业简报"
    assert item["freqSummary"] == "每天 08:00"
    assert item["validitySummary"] == "长期有效"
    assert item["createdBy"] == USER_ID
    assert item["schedule"]["cycleKind"] == "daily"
    assert "freq_summary" not in item  # 不能漏出 snake_case


async def test_sync_list_excludes_soft_deleted_templates(
    api_client: AsyncClient,
) -> None:
    """已软删除（下架）的模板不再下发。"""
    response = await api_client.get(
        f"{SYNC_PREFIX}/list",
        headers={"Authorization": f"Bearer {client_token(SCOPE)}"},
    )

    ids = {item["id"] for item in response.json()["data"]["items"]}
    assert "t-deleted" not in ids


async def test_sync_list_rejects_client_token_without_scope(
    api_client: AsyncClient,
) -> None:
    """客户端 token 缺 template:read → 403（授权页关掉该能力后必须真的关得住）."""
    response = await api_client.get(
        f"{SYNC_PREFIX}/list",
        headers={"Authorization": f"Bearer {client_token('user:read')}"},
    )

    assert response.status_code == 403
    assert SCOPE in response.json()["detail"]


async def test_sync_list_allows_first_party_web_token(api_client: AsyncClient) -> None:
    """第一方 Web token 不受 scope 约束（Web 登录本来就不走授权页）."""
    response = await api_client.get(
        f"{SYNC_PREFIX}/list",
        headers={"Authorization": f"Bearer {web_token()}"},
    )

    assert response.status_code == 200
    assert response.json()["data"]["total"] == 2


async def test_sync_list_requires_authentication(api_client: AsyncClient) -> None:
    """无凭据 → 401，不泄漏任何模板数据."""
    response = await api_client.get(f"{SYNC_PREFIX}/list")

    assert response.status_code == 401


async def test_sync_list_paginates(api_client: AsyncClient) -> None:
    """分页参数生效：桌面端靠 total 翻页取全量."""
    response = await api_client.get(
        f"{SYNC_PREFIX}/list",
        params={"page": 2, "page_size": 1},
        headers={"Authorization": f"Bearer {client_token(SCOPE)}"},
    )

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["total"] == 2
    assert data["page"] == 2
    assert len(data["items"]) == 1
