"""登录滑块验证接口集成测试.

单独装配一个只挂载认证与验证码路由的 FastAPI 应用，避免依赖全局 lifespan，
断言使用前端真实请求体与 camelCase 响应字段。
"""
from collections.abc import AsyncGenerator

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from api.auth.auth_api import router as auth_router
from api.captcha.captcha_api import router as captcha_router
from api.deps import get_cache, get_db
from core.cache import MemoryCache
from db.base import Base
from db.models import Account, LoginRecord

pytestmark = pytest.mark.anyio

ACCOUNT = "captcha_probe_user"


@pytest.fixture
def store() -> MemoryCache:
    """每个测试独立的缓存实例."""
    return MemoryCache()


@pytest.fixture
async def api_client(store: MemoryCache) -> AsyncGenerator[AsyncClient, None]:
    """内存数据库 + 独立缓存的认证/验证码路由测试客户端."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(
            Base.metadata.create_all,
            tables=[Account.__table__, LoginRecord.__table__],
        )
    maker = async_sessionmaker(engine, expire_on_commit=False)

    async def override_db() -> AsyncGenerator[AsyncSession, None]:
        async with maker() as session:
            yield session

    app = FastAPI()
    app.include_router(auth_router)
    app.include_router(captcha_router)
    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_cache] = lambda: store

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
    await engine.dispose()


async def _make_login_required(api_client: AsyncClient) -> None:
    """累计失败到阈值，使该账号进入需要验证的状态."""
    for _ in range(3):
        res = await api_client.post(
            "/api/auth/login/account",
            json={"account": ACCOUNT, "password": "not-a-valid-cipher"},
        )
        assert res.json()["code"] != 0


async def _solve_slide(api_client: AsyncClient, store: MemoryCache) -> tuple[str, str]:
    """白盒读取缺口位置并完成一次滑块验证，返回票据."""
    res = await api_client.get("/api/captcha/slide")
    data = res.json()["data"]
    session_id = data["sessionId"]
    raw = await store.get(f"captcha:slide:{session_id}")
    assert raw is not None
    gap = int(raw.split(":")[0])
    res = await api_client.post(
        "/api/captcha/slide/verify",
        json={
            "sessionId": session_id,
            "distance": gap,
            "track": [],
            "scene": "login",
            "account": ACCOUNT,
        },
    )
    body = res.json()["data"]
    assert body["success"] is True
    return body["ticket"], body["randstr"]


async def test_login_requires_captcha_after_failures(api_client: AsyncClient) -> None:
    """失败达到阈值后，挑战接口返回 required，未带票据的登录被拦下."""
    res = await api_client.get(
        "/api/auth/login/challenge", params={"account": ACCOUNT}
    )
    assert res.json()["code"] == 0

    await _make_login_required(api_client)

    res = await api_client.get(
        "/api/auth/login/challenge", params={"account": ACCOUNT}
    )
    data = res.json()["data"]
    assert data["required"] is True
    assert data["challengeType"] == "slide"

    res = await api_client.post(
        "/api/auth/login/account",
        json={"account": ACCOUNT, "password": "not-a-valid-cipher"},
    )
    assert res.json()["code"] == 428


async def test_login_with_valid_ticket_passes_gate_once(
    api_client: AsyncClient, store: MemoryCache
) -> None:
    """携带有效票据可通过验证关卡，且同一票据不可重放."""
    await _make_login_required(api_client)
    ticket, randstr = await _solve_slide(api_client, store)

    payload = {
        "account": ACCOUNT,
        "password": "not-a-valid-cipher",
        "captchaTicket": ticket,
        "captchaRandstr": randstr,
    }
    res = await api_client.post("/api/auth/login/account", json=payload)
    # 已越过验证码关卡，进入密码校验（密文非法 -> 400）
    assert res.json()["code"] == 400

    res = await api_client.post("/api/auth/login/account", json=payload)
    assert res.json()["code"] == 428
