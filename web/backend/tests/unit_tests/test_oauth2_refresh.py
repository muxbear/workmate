"""OAuth2 refresh / revoke 服务单元测试."""

from urllib.parse import parse_qs, urlparse

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

import db.models  # noqa: F401  确保模型注册
from api.oauth2.oauth2_schemas import RefreshTokenRequest, RevokeTokenRequest
from api.oauth2.oauth2_service import (
    OAuth2TokenError,
    _build_authorize_url,
    _issue_refresh_token,
    refresh_token_exchange,
    revoke_token,
)
from db.base import Base
from db.models import Account, OAuth2Client

pytestmark = pytest.mark.anyio


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


async def _seed_client_user(db) -> tuple[OAuth2Client, Account]:
    """写入测试客户端与账号。"""
    client = OAuth2Client(
        client_id="ke-work-desktop",
        client_name="KE-WORK 桌面版",
        client_type="public",
        redirect_uris=["http://127.0.0.1:{port}/callback"],
        allowed_scopes=["skill:read", "conversation:read"],
        grant_types=["authorization_code"],
        enabled=True,
    )
    user = Account(username="oauth-test", nickname="Tester")
    db.add_all([client, user])
    await db.flush()
    return client, user


def test_build_authorize_url_standard_params() -> None:
    """授权 URL 必须携带 RFC 6749 §4.1.1 + RFC 7636 §4.3 标准参数。"""
    url = _build_authorize_url(
        state="s1",
        client_id="ke-work-desktop",
        redirect_uri="http://127.0.0.1:54821/callback",
        scopes=["skill:read", "conversation:read"],
        code_challenge="challenge-value",
        code_challenge_method="S256",
    )
    parsed = urlparse(url)
    assert parsed.path == "/oauth2/authorize"
    query = parse_qs(parsed.query)
    assert query["response_type"] == ["code"]
    assert query["client_id"] == ["ke-work-desktop"]
    assert query["redirect_uri"] == ["http://127.0.0.1:54821/callback"]
    assert query["scope"] == ["skill:read conversation:read"]
    assert query["state"] == ["s1"]
    assert query["code_challenge"] == ["challenge-value"]
    assert query["code_challenge_method"] == ["S256"]


async def test_refresh_rotation_and_reuse_detection(db_session) -> None:
    """轮换后旧 token 再次使用触发族撤销。"""
    client, user = await _seed_client_user(db_session)
    old_token, family = await _issue_refresh_token(
        db_session, client.client_id, user.id, ["skill:read"]
    )

    result = await refresh_token_exchange(
        RefreshTokenRequest(
            grant_type="refresh_token",
            client_id=client.client_id,
            refresh_token=old_token,
        ),
        db_session,
    )
    assert result.access_token
    assert result.token_type == "Bearer"
    assert result.refresh_token != old_token
    assert result.scope == "skill:read"

    # 旧 token 重用：应抛 invalid_grant 并撤销整族
    with pytest.raises(OAuth2TokenError) as exc:
        await refresh_token_exchange(
            RefreshTokenRequest(
                grant_type="refresh_token",
                client_id=client.client_id,
                refresh_token=old_token,
            ),
            db_session,
        )
    assert exc.value.error == "invalid_grant"

    # 族内新 token 也已被撤销
    with pytest.raises(OAuth2TokenError) as exc2:
        await refresh_token_exchange(
            RefreshTokenRequest(
                grant_type="refresh_token",
                client_id=client.client_id,
                refresh_token=result.refresh_token,
            ),
            db_session,
        )
    assert exc2.value.error == "invalid_grant"


async def test_refresh_scope_boundary(db_session) -> None:
    """刷新时 scope 只能收窄不能扩大。"""
    client, user = await _seed_client_user(db_session)
    token, _family = await _issue_refresh_token(
        db_session, client.client_id, user.id, ["skill:read"]
    )

    # 收窄成功
    narrowed = await refresh_token_exchange(
        RefreshTokenRequest(
            grant_type="refresh_token",
            client_id=client.client_id,
            refresh_token=token,
            scope="skill:read",
        ),
        db_session,
    )
    assert narrowed.scope == "skill:read"

    # 扩大被拒
    with pytest.raises(OAuth2TokenError) as exc:
        await refresh_token_exchange(
            RefreshTokenRequest(
                grant_type="refresh_token",
                client_id=client.client_id,
                refresh_token=narrowed.refresh_token,
                scope="skill:read conversation:read",
            ),
            db_session,
        )
    assert exc.value.error == "invalid_scope"


async def test_revoke_token(db_session) -> None:
    """revoke 后 token 不可再刷新；无效 token 不抛错（RFC 7009）。"""
    client, user = await _seed_client_user(db_session)
    token, _family = await _issue_refresh_token(
        db_session, client.client_id, user.id, ["skill:read"]
    )

    # 无效 token：不抛错
    await revoke_token(
        RevokeTokenRequest(token="unknown-token", token_type_hint="refresh_token"),
        db_session,
    )

    await revoke_token(
        RevokeTokenRequest(token=token, token_type_hint="refresh_token"),
        db_session,
    )
    with pytest.raises(OAuth2TokenError) as exc:
        await refresh_token_exchange(
            RefreshTokenRequest(
                grant_type="refresh_token",
                client_id=client.client_id,
                refresh_token=token,
            ),
            db_session,
        )
    assert exc.value.error == "invalid_grant"
