"""定时任务模板接口集成测试.

单独装配一个只挂载模板路由的 FastAPI 应用并注入内存数据库（与 test_automation_api.py
同法），断言使用前端真实请求体与 camelCase 响应字段。

写接口挂了 `RequirePermission`，它内部走 JWT + 角色权限查库；这里把
`api.rbac.deps` 里的两个内部函数替换掉，从而**只测本接口的行为**，
RBAC 本身的正确性由 test_rbac_permission_tree.py 与下面的结构断言负责。
"""

from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from api.automation.template_api import router as template_router
from api.automation.template_service import (
    seed_builtin_task_templates,
)
from api.deps import get_current_user_id, get_db
from api.params.service import seed_builtin_params
from db.base import Base
from db.models.automation import AutomationTemplate
from db.soft_delete import install_soft_delete_filter

pytestmark = pytest.mark.anyio

USER_ID = "user-template"
TEMPLATES_PREFIX = "/api/automation/templates"


def schedule_payload(**overrides: object) -> dict[str, object]:
    """完整的排期请求体（前端 createDefaultSchedule() 的形状）."""
    payload: dict[str, object] = {
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
    payload.update(overrides)
    return payload


def template_payload(**overrides: object) -> dict[str, object]:
    """构造与前端一致的 camelCase 模板请求体."""
    payload: dict[str, object] = {
        "name": "每日行业简报",
        "description": "汇总当天行业动态",
        "icon": "📰",
        "category": "news",
        "promptText": "请汇总今天的行业重点动态",
        "promptParts": [{"type": "text", "text": "请汇总今天的行业重点动态"}],
        "schedule": schedule_payload(),
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


@pytest_asyncio.fixture
async def session_maker() -> AsyncGenerator[async_sessionmaker[AsyncSession], None]:
    """内存库会话工厂（供需要直接读库的断言使用）."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    # 生产环境由 init_db 在启动时安装；这里手动装上，软删除的过滤行为才被测到。
    install_soft_delete_filter()
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest_asyncio.fixture
async def api_client(
    session_maker: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncGenerator[AsyncClient, None]:
    """内存数据库 + 已放行权限的模板路由测试客户端."""

    async def override_db() -> AsyncGenerator[AsyncSession, None]:
        # 与 db.engine.get_db 同口径：请求成功即提交，异常则回滚。
        # 模板 service 只 flush，不自己 commit。
        async with session_maker() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    async def override_user() -> str:
        return USER_ID

    async def fake_payload(request: object) -> dict[str, str]:
        return {"sub": USER_ID, "role": "super_admin"}

    async def allow(
        db: AsyncSession,
        user_id: str,
        perm_key: str,
        role_key: str | None = None,
    ) -> bool:
        return True

    monkeypatch.setattr(
        "api.rbac.deps.get_current_token_payload", fake_payload
    )
    monkeypatch.setattr("api.rbac.deps.check_user_permission", allow)

    app = FastAPI()
    app.include_router(template_router)
    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user_id] = override_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


async def test_template_crud_and_version_defaults(api_client: AsyncClient) -> None:
    """新建从 1.0.0 起步；更新默认递增次版本；也能手工指定版本号."""
    create = await api_client.post(TEMPLATES_PREFIX, json=template_payload())
    assert create.status_code == 200
    created = create.json()["data"]
    assert created["name"] == "每日行业简报"
    assert created["version"] == "1.0.0"
    assert created["freqSummary"] == "每天 08:00"
    assert created["validitySummary"] == "长期有效"
    assert created["createdBy"] == USER_ID
    assert created["category"] == "news"
    template_id = created["id"]

    # 不传 version：服务端兜底递增次版本
    update = await api_client.put(
        f"{TEMPLATES_PREFIX}/{template_id}",
        json=template_payload(name="每日行业简报（改）"),
    )
    assert update.status_code == 200
    updated = update.json()["data"]
    assert updated["version"] == "1.1.0"
    assert updated["name"] == "每日行业简报（改）"

    # 手工指定版本号：以传入值为准
    manual = await api_client.put(
        f"{TEMPLATES_PREFIX}/{template_id}",
        json=template_payload(name="每日行业简报（再改）", version="2.5.1"),
    )
    assert manual.status_code == 200
    assert manual.json()["data"]["version"] == "2.5.1"

    detail = await api_client.get(f"{TEMPLATES_PREFIX}/{template_id}")
    assert detail.status_code == 200
    assert detail.json()["data"]["version"] == "2.5.1"

    deleted = await api_client.delete(f"{TEMPLATES_PREFIX}/{template_id}")
    assert deleted.status_code == 200

    # service 抛的 HTTPException 会被 handle_errors 收进统一响应体，
    # 所以这里断言的是 body 里的 code（与 test_automation_api.py 同法）。
    gone = await api_client.get(f"{TEMPLATES_PREFIX}/{template_id}")
    assert gone.json()["code"] == 404
    assert (await api_client.get(TEMPLATES_PREFIX)).json()["data"]["total"] == 0


def _rejected(response: object) -> bool:
    """请求被拒：要么是 FastAPI 的 422，要么是统一响应体里的非 0 code。."""
    status_code = getattr(response, "status_code")
    if status_code == 422:
        return True
    try:
        return response.json().get("code") != 0  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001 - 非 JSON 响应
        return status_code >= 400


async def test_invalid_version_and_empty_prompt_are_rejected(
    api_client: AsyncClient,
) -> None:
    """非法版本号与空提示词都要被挡下（模板要能直接生成任务）."""
    bad_version = await api_client.post(
        TEMPLATES_PREFIX, json=template_payload(version="1.2")
    )
    assert _rejected(bad_version)

    empty_prompt = await api_client.post(
        TEMPLATES_PREFIX,
        json=template_payload(promptText="   ", promptParts=[]),
    )
    assert _rejected(empty_prompt)


async def test_pagination_and_category_filter(api_client: AsyncClient) -> None:
    """分页参数生效，类型筛选只返回该类型的模板."""
    for index in range(5):
        category = "news" if index % 2 == 0 else "work"
        response = await api_client.post(
            TEMPLATES_PREFIX,
            json=template_payload(name=f"模板 {index}", category=category),
        )
        assert response.status_code == 200

    first_page = (await api_client.get(TEMPLATES_PREFIX, params={"page": 1, "page_size": 2}))
    body = first_page.json()["data"]
    assert body["total"] == 5
    assert body["page"] == 1
    assert body["page_size"] == 2
    assert len(body["items"]) == 2

    second_page = (await api_client.get(TEMPLATES_PREFIX, params={"page": 2, "page_size": 2}))
    assert len(second_page.json()["data"]["items"]) == 2

    # 两页之间不应出现重复条目
    ids = {
        item["id"] for item in body["items"]
    } | {item["id"] for item in second_page.json()["data"]["items"]}
    assert len(ids) == 4

    news = (
        await api_client.get(TEMPLATES_PREFIX, params={"category": "news"})
    ).json()["data"]
    assert news["total"] == 3
    assert {item["category"] for item in news["items"]} == {"news"}

    searched = (
        await api_client.get(TEMPLATES_PREFIX, params={"keyword": "模板 3"})
    ).json()["data"]
    assert [item["name"] for item in searched["items"]] == ["模板 3"]


async def test_template_types_endpoint_requires_only_login(
    api_client: AsyncClient,
    session_maker: async_sessionmaker[AsyncSession],
) -> None:
    """类型下拉取值来自「参数配置」；未配置时为空列表（不回退硬编码）."""
    empty = await api_client.get("/api/automation/template-types")
    assert empty.status_code == 200
    assert empty.json()["data"] == []

    async with session_maker() as db:
        await seed_builtin_params(db)
        await db.commit()

    seeded = await api_client.get("/api/automation/template-types")
    assert seeded.status_code == 200
    assert [item["value"] for item in seeded.json()["data"]] == [
        "news",
        "learning",
        "life",
        "work",
        "fun",
    ]


async def test_seed_creates_twelve_valid_templates(
    session_maker: async_sessionmaker[AsyncSession],
) -> None:
    """内置 12 条模板入库，展示文案沿用改造前的写法."""
    async with session_maker() as db:
        await seed_builtin_task_templates(db)
        await db.commit()

        rows = (
            (
                await db.execute(
                    select(AutomationTemplate).order_by(AutomationTemplate.created_at)
                )
            )
            .scalars()
            .all()
        )
        assert len(rows) == 12

        by_name = {row.name: row for row in rows}
        # 第 10、11 条的文案是手工写的，不能改由 build_freq_summary 重算
        assert by_name["面试准备提醒"].freq_summary == "工作日 每2h"
        assert by_name["会议前准备"].freq_summary == "会前 15min"
        assert by_name["每日 AI 新闻推送"].freq_summary == "每天 08:00"

        # 每条都要有类型与版本，且提示词非空（否则生成不了任务）
        for row in rows:
            assert row.category
            assert row.version == "1.0.0"
            assert row.prompt_text.strip()
            assert row.freq_summary

        # 单次任务必须有可用的占位日期，否则草稿校验过不了
        once = by_name["体检预约提醒"]
        assert once.schedule["cycleKind"] == "once"
        assert once.schedule["onceDate"]

        # 再次种子应跳过（表非空），不会翻倍
        await seed_builtin_task_templates(db)
        await db.commit()
        total = (
            await db.execute(select(AutomationTemplate))
        ).scalars().all()
        assert len(total) == 12


def _flatten_routes(routes: list) -> list:
    """展开 FastAPI 的双层惰性路由包装（与路由遮蔽测试同法）."""
    out: list = []
    for route in routes:
        if type(route).__name__ == "_IncludedRouter":
            out.extend(_flatten_routes(route.original_router.routes))
            continue
        if getattr(route, "path", None):
            out.append(route)
    return out


def _permission_keys(route: object) -> set[str]:
    """递归取出该路由声明里的权限键."""
    def walk(dependant: object) -> set[str]:
        keys: set[str] = set()
        for sub in getattr(dependant, "dependencies", []) or []:
            key = getattr(sub.call, "__permission_key__", None)
            if key:
                keys.add(key)
            keys |= walk(sub)
        return keys

    return walk(getattr(route, "dependant", None))


def test_write_routes_are_guarded_by_template_permissions() -> None:
    """三个写接口必须各自挂上对应的模板权限键（防止漏挂或改宽松）."""
    import api.automation.template_api as template_api_module

    expected = {
        ("POST", TEMPLATES_PREFIX): "control:template:create",
        ("PUT", f"{TEMPLATES_PREFIX}/{{template_id}}"): "control:template:edit",
        ("DELETE", f"{TEMPLATES_PREFIX}/{{template_id}}"): "control:template:delete",
    }
    routes = _flatten_routes(template_api_module.router.routes)

    for key, perm_key in expected.items():
        matched = [
            route
            for route in routes
            if (route.path, tuple(sorted(route.methods))) == (key[1], (key[0],))
        ]
        assert matched, f"未找到路由 {key}"
        assert _permission_keys(matched[0]) == {perm_key}, key
