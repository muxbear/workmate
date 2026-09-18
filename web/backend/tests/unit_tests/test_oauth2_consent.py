"""OAuth2 授权记忆（consent）、scope 收窄与增量授权的单元测试."""

from datetime import timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

import db.models  # noqa: F401  确保模型注册
from api.oauth2.oauth2_schemas import (
    AuthorizationUrlRequest,
    RefreshTokenRequest,
)
from api.oauth2.oauth2_service import (
    OAuth2TokenError,
    _issue_refresh_token,
    _utcnow,
    approve_authorization,
    create_authorization_url,
    get_authorize_context,
    get_consent_state,
    refresh_token_exchange,
    revoke_consent,
)
from api.oauth2.scope_service import REQUIRED_SCOPES
from core.cache import MemoryCache
from db.base import Base
from db.models import Account, OAuth2Client, OAuth2RefreshToken

pytestmark = pytest.mark.anyio

ALLOWED_SCOPES = ["user:read", "conversation:write", "skill:read", "expert:read"]
REDIRECT_URI = "http://127.0.0.1:54821/callback"


@pytest.fixture
async def db_session():
    """提供共享内存 SQLite 的 async session（每次测试独立建库）。"""
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


async def _seed_client_user(db: AsyncSession) -> tuple[OAuth2Client, Account]:
    """写入测试客户端与账号。"""
    client = OAuth2Client(
        client_id="ke-work-desktop",
        client_name="KE-WORK 桌面版",
        client_type="public",
        redirect_uris=["http://127.0.0.1:{port}/callback"],
        allowed_scopes=ALLOWED_SCOPES,
        grant_types=["authorization_code"],
        enabled=True,
    )
    user = Account(username="oauth-consent-test", nickname="Tester")
    db.add_all([client, user])
    await db.flush()
    return client, user


async def _create_state(
    db: AsyncSession, cache: MemoryCache, scopes: list[str]
) -> str:
    """创建授权请求并返回 state。"""
    response = await create_authorization_url(
        AuthorizationUrlRequest(
            client_id="ke-work-desktop",
            redirect_uri=REDIRECT_URI,
            scope=" ".join(scopes),
            code_challenge="a" * 43,
            code_challenge_method="S256",
        ),
        db,
        cache,
    )
    return response.state


async def test_approve_default_grants_all_scopes(db_session: AsyncSession) -> None:
    """默认授权（scopes 缺省）应授予全部请求 scope，并写入授权记忆。"""
    client, user = await _seed_client_user(db_session)
    cache = MemoryCache()

    state = await _create_state(db_session, cache, ALLOWED_SCOPES)
    context = await get_authorize_context(state, user.id, db_session, cache)

    assert context.autoApprove is False
    assert [info.key for info in context.scopes] == ALLOWED_SCOPES
    assert all(info.defaultGranted for info in context.scopes)
    assert {scope for scope in REQUIRED_SCOPES} <= {info.key for info in context.scopes}
    assert all(info.granted is False for info in context.scopes)

    result = await approve_authorization(state, user.id, None, db_session, cache)
    assert result.grantedScopes == ALLOWED_SCOPES

    _consent, granted, denied = await get_consent_state(
        db_session, client.client_id, user.id
    )
    assert granted == ALLOWED_SCOPES
    assert denied == []


async def test_approve_can_narrow_scopes(db_session: AsyncSession) -> None:
    """用户关闭某项权限后，该项不进入 token，并记入 denied。"""
    client, user = await _seed_client_user(db_session)
    cache = MemoryCache()

    state = await _create_state(db_session, cache, ALLOWED_SCOPES)
    result = await approve_authorization(
        state, user.id, ["expert:read"], db_session, cache
    )

    expected = {"expert:read", *REQUIRED_SCOPES}
    assert set(result.grantedScopes) == expected

    _consent, granted, denied = await get_consent_state(
        db_session, client.client_id, user.id
    )
    assert set(granted) == expected
    assert set(denied) == {"skill:read"}


async def test_approve_rejects_scope_escalation(db_session: AsyncSession) -> None:
    """提交未在本次请求范围内的 scope 应被拒绝（禁止提权）。"""
    _client, user = await _seed_client_user(db_session)
    cache = MemoryCache()

    state = await _create_state(db_session, cache, ["skill:read"])

    with pytest.raises(HTTPException) as exc:
        await approve_authorization(
            state, user.id, ["skill:read", "expert:read"], db_session, cache
        )
    assert exc.value.status_code == 400


async def test_auto_approve_when_scopes_already_granted(
    db_session: AsyncSession,
) -> None:
    """已授权范围内再次请求时免二次确认。"""
    _client, user = await _seed_client_user(db_session)
    cache = MemoryCache()

    first_state = await _create_state(db_session, cache, ALLOWED_SCOPES)
    await approve_authorization(first_state, user.id, None, db_session, cache)

    second_state = await _create_state(db_session, cache, ALLOWED_SCOPES)
    context = await get_authorize_context(second_state, user.id, db_session, cache)

    assert context.autoApprove is True
    assert set(context.grantedScopes) == set(ALLOWED_SCOPES)
    assert all(info.granted for info in context.scopes)


async def test_incremental_authorization_merges_granted_scopes(
    db_session: AsyncSession,
) -> None:
    """增量授权后 token 的 scope 为并集，且从 denied 中移除。"""
    client, user = await _seed_client_user(db_session)
    cache = MemoryCache()

    first_state = await _create_state(db_session, cache, ALLOWED_SCOPES)
    await approve_authorization(
        first_state, user.id, [*REQUIRED_SCOPES, "skill:read"], db_session, cache
    )
    _consent, granted, denied = await get_consent_state(
        db_session, client.client_id, user.id
    )
    assert "expert:read" in denied

    incremental_state = await _create_state(db_session, cache, ["expert:read"])
    context = await get_authorize_context(
        incremental_state, user.id, db_session, cache
    )
    assert context.autoApprove is False
    assert [info.key for info in context.scopes] == ["expert:read"]

    result = await approve_authorization(
        incremental_state, user.id, None, db_session, cache
    )
    assert set(result.grantedScopes) == set(ALLOWED_SCOPES)

    _consent, granted, denied = await get_consent_state(
        db_session, client.client_id, user.id
    )
    assert set(granted) == set(ALLOWED_SCOPES)
    assert denied == []


async def test_denied_scope_expires_and_resets(db_session: AsyncSession) -> None:
    """denied 到期后恢复默认开启（决策 D4）。"""
    client, user = await _seed_client_user(db_session)
    cache = MemoryCache()

    state = await _create_state(db_session, cache, ALLOWED_SCOPES)
    await approve_authorization(state, user.id, ["skill:read"], db_session, cache)

    consent, _granted, denied = await get_consent_state(
        db_session, client.client_id, user.id
    )
    assert consent is not None
    assert "expert:read" in denied
    assert consent.denied_expires_at is not None

    consent.denied_expires_at = _utcnow() - timedelta(days=1)
    await db_session.flush()

    _consent, _granted, denied = await get_consent_state(
        db_session, client.client_id, user.id
    )
    assert denied == []


async def test_revoke_scope_removes_grant_and_tokens(
    db_session: AsyncSession,
) -> None:
    """撤销指定 scope 后，该 scope 不可用且 refresh token 同步失效。"""
    client, user = await _seed_client_user(db_session)
    cache = MemoryCache()

    state = await _create_state(db_session, cache, ALLOWED_SCOPES)
    await approve_authorization(state, user.id, None, db_session, cache)
    refresh_token, _family = await _issue_refresh_token(
        db_session, client.client_id, user.id, ALLOWED_SCOPES
    )
    await db_session.flush()

    await revoke_consent(db_session, client.client_id, user.id, ["skill:read"])

    _consent, granted, denied = await get_consent_state(
        db_session, client.client_id, user.id
    )
    assert "skill:read" not in granted
    assert "skill:read" in denied

    with pytest.raises(OAuth2TokenError) as exc:
        await refresh_token_exchange(
            RefreshTokenRequest(
                grant_type="refresh_token",
                client_id=client.client_id,
                refresh_token=refresh_token,
            ),
            db_session,
        )
    assert exc.value.error == "invalid_grant"

    rows = (await db_session.execute(OAuth2RefreshToken.__table__.select())).fetchall()
    assert len(rows) == 1


async def test_revoke_all_removes_consent(db_session: AsyncSession) -> None:
    """整份撤销后授权记忆被删除，重新请求需要再次确认。"""
    client, user = await _seed_client_user(db_session)
    cache = MemoryCache()

    state = await _create_state(db_session, cache, ALLOWED_SCOPES)
    await approve_authorization(state, user.id, None, db_session, cache)

    await revoke_consent(db_session, client.client_id, user.id, None)

    consent, granted, denied = await get_consent_state(
        db_session, client.client_id, user.id
    )
    assert consent is None
    assert granted == []
    assert denied == []

    next_state = await _create_state(db_session, cache, ALLOWED_SCOPES)
    context = await get_authorize_context(next_state, user.id, db_session, cache)
    assert context.autoApprove is False
