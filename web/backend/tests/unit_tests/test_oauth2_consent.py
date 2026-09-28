"""OAuth2 授权记忆（consent）、scope 收窄与增量授权的单元测试."""

import json
from datetime import timedelta
from pathlib import Path

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
from api.oauth2.scope_service import REQUIRED_SCOPES, SCOPE_CATALOG
from core.cache import MemoryCache
from db.base import Base
from db.models import Account, OAuth2Client, OAuth2RefreshToken

pytestmark = pytest.mark.anyio

ALLOWED_SCOPES = ["user:read", "conversation:write", "skill:read", "expert:read"]
#: 知识库 scope 单列：写权限默认关闭，混进 ALLOWED_SCOPES 会让"默认全开"的既有断言失真
KNOWLEDGE_SCOPES = ["knowledge:read", "knowledge:write"]
REDIRECT_URI = "http://127.0.0.1:54821/callback"

_SEED_PATH = (
    Path(__file__).resolve().parents[2] / "src" / "db" / "seeds" / "oauth2_clients_seed.json"
)


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


class TestScopeCatalog:
    """scope 目录与客户端白名单的一致性（含本次新增的知识库 scope）。"""

    def test_knowledge_scopes_are_registered(self) -> None:
        """知识库读写两个 scope 都已登记，且默认开关符合预期。"""
        read = SCOPE_CATALOG["knowledge:read"]
        write = SCOPE_CATALOG["knowledge:write"]

        assert read.group == write.group == "知识库"
        assert not read.required and not write.required, "两项都该允许用户逐项关闭"
        assert read.default_granted is True, "读权限默认开，否则客户端登录后立刻用不了知识库"
        assert write.default_granted is False, "写权限必须由用户显式开启"

    def test_seed_clients_only_use_registered_scopes(self) -> None:
        """种子客户端声明的每个 scope 都必须在目录里登记。

        两种错配都靠人工核对不住：漏登记会让客户端的授权请求被
        ``validate_scope_subset`` 直接 400；登记了但不在白名单里则永远申请不到。
        """
        payload = json.loads(_SEED_PATH.read_text(encoding="utf-8"))
        unknown = {
            (client["client_id"], scope)
            for client in payload["clients"]
            for scope in client["allowed_scopes"]
            if scope not in SCOPE_CATALOG
        }
        assert not unknown, f"种子里有未登记的 scope：{sorted(unknown)}"

    def test_desktop_client_may_request_knowledge_scopes(self) -> None:
        """桌面端必须在白名单里有知识库 scope——否则整个云知识库能力申请不到。"""
        payload = json.loads(_SEED_PATH.read_text(encoding="utf-8"))
        desktop = next(
            client for client in payload["clients"] if client["client_id"] == "ke-work-desktop"
        )
        assert set(KNOWLEDGE_SCOPES) <= set(desktop["allowed_scopes"])


async def test_knowledge_scopes_on_consent_page(db_session: AsyncSession) -> None:
    """知识库 scope 走到授权页：读默认开、写默认关。"""
    user = Account(username="oauth-kb-test", nickname="Tester")
    db_session.add(
        OAuth2Client(
            client_id="ke-work-desktop",
            client_name="KE-WORK 桌面版",
            client_type="public",
            redirect_uris=["http://127.0.0.1:{port}/callback"],
            allowed_scopes=[*ALLOWED_SCOPES, *KNOWLEDGE_SCOPES],
            grant_types=["authorization_code"],
            enabled=True,
        )
    )
    db_session.add(user)
    await db_session.flush()

    cache = MemoryCache()
    state = await _create_state(db_session, cache, [*ALLOWED_SCOPES, *KNOWLEDGE_SCOPES])
    context = await get_authorize_context(state, user.id, db_session, cache)

    infos = {info.key: info for info in context.scopes}
    assert infos["knowledge:read"].defaultGranted is True
    assert infos["knowledge:write"].defaultGranted is False
    assert all(info.group == "知识库" for info in (infos["knowledge:read"], infos["knowledge:write"]))
    assert all(info.description for info in (infos["knowledge:read"], infos["knowledge:write"])), (
        "授权页要说明关掉之后会怎样，否则用户没法做决定"
    )


async def test_narrowing_knowledge_write_keeps_read(db_session: AsyncSession) -> None:
    """用户显式关掉写权限：token 里只保留读，且写被记入 denied。"""
    user = Account(username="oauth-kb-narrow", nickname="Tester")
    db_session.add(
        OAuth2Client(
            client_id="ke-work-desktop",
            client_name="KE-WORK 桌面版",
            client_type="public",
            redirect_uris=["http://127.0.0.1:{port}/callback"],
            allowed_scopes=["knowledge:read", "knowledge:write"],
            grant_types=["authorization_code"],
            enabled=True,
        )
    )
    db_session.add(user)
    await db_session.flush()

    cache = MemoryCache()
    state = await _create_state(db_session, cache, ["knowledge:read", "knowledge:write"])
    result = await approve_authorization(
        state, user.id, ["knowledge:read"], db_session, cache
    )

    assert set(result.grantedScopes) == {"knowledge:read"}
    _consent, granted, denied = await get_consent_state(
        db_session, "ke-work-desktop", user.id
    )
    assert set(granted) == {"knowledge:read"}
    assert set(denied) == {"knowledge:write"}


async def test_write_scope_alone_does_not_grant_read(db_session: AsyncSession) -> None:
    """读写两项各自独立：只给写权限时，token 里没有读。"""
    user = Account(username="oauth-kb-write-only", nickname="Tester")
    db_session.add(
        OAuth2Client(
            client_id="ke-work-desktop",
            client_name="KE-WORK 桌面版",
            client_type="public",
            redirect_uris=["http://127.0.0.1:{port}/callback"],
            allowed_scopes=["knowledge:read", "knowledge:write"],
            grant_types=["authorization_code"],
            enabled=True,
        )
    )
    db_session.add(user)
    await db_session.flush()

    cache = MemoryCache()
    state = await _create_state(db_session, cache, ["knowledge:read", "knowledge:write"])
    result = await approve_authorization(
        state, user.id, ["knowledge:write"], db_session, cache
    )

    assert set(result.grantedScopes) == {"knowledge:write"}


async def test_seed_upsert_grants_knowledge_scopes_to_desktop_client(
    db_session: AsyncSession,
) -> None:
    """重启时的种子补齐：老客户端行（白名单里还没有知识库）会被补上两枚 scope。

    桌面端能申请这两枚 scope 靠的就是这一步——种子只写新行的话，升级上来的实例
    仍会在 ``validate_scope_subset`` 处 400，用户侧表现为"申请授权失败"。
    """
    from sqlalchemy import select

    from api.oauth2.client_service import seed_oauth2_clients

    db_session.add(
        OAuth2Client(
            client_id="ke-work-desktop",
            client_name="KE-WORK 桌面版（旧）",
            client_type="public",
            redirect_uris=["http://127.0.0.1:{port}/callback"],
            allowed_scopes=["skill:read"],
            grant_types=["authorization_code"],
            enabled=True,
        )
    )
    await db_session.commit()

    await seed_oauth2_clients(db_session)
    await db_session.commit()

    client = (
        await db_session.execute(
            select(OAuth2Client).where(OAuth2Client.client_id == "ke-work-desktop")
        )
    ).scalar_one()
    assert set(KNOWLEDGE_SCOPES) <= set(client.allowed_scopes)
