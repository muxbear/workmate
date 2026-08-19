"""OAuth2 Authorization Code + PKCE 业务逻辑."""

import base64
import hashlib
import json
import secrets
import time
from typing import Any
from urllib.parse import urlencode

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agent.config import settings
from api.oauth2.client_service import get_client_by_id, redirect_uri_matches
from api.oauth2.oauth2_schemas import (
    AuthorizationUrlRequest,
    AuthorizationUrlResponse,
    AuthorizeApproveResponse,
    AuthorizeContextResponse,
    OAuth2ClientInfo,
    OAuth2UserInfo,
    TokenRequest,
    TokenResponse,
)
from api.oauth2.scope_service import (
    join_scopes,
    parse_scopes,
    to_scope_infos,
    validate_scope_subset,
)
from core.cache import KeyValueCache
from core.security import create_token_pair
from db.models import Account

STATE_TTL = 600
CODE_TTL = 300


def _state_key(state: str) -> str:
    return f"oauth2:state:{state}"


def _code_key(code: str) -> str:
    return f"oauth2:code:{code}"


def _build_authorize_url(state: str) -> str:
    """构造 Web 前端通用授权页 URL."""
    base_url = settings.OAUTH2_FRONTEND_URL.rstrip("/")
    query = urlencode({"state": state})
    return f"{base_url}/oauth2/authorize?{query}"


async def _get_cache_json(store: KeyValueCache, key: str) -> dict[str, Any] | None:
    """读取并解析缓存 JSON."""
    raw = await store.get(key)
    if not raw:
        return None
    try:
        data: dict[str, Any] = json.loads(raw)
        return data
    except json.JSONDecodeError:
        return None


async def _get_active_account(db: AsyncSession, user_id: str) -> Account:
    """查询并校验当前账号."""
    result = await db.execute(
        select(Account).where(Account.id == user_id, Account.is_active.is_(True))
    )
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=401, detail="Account not found or disabled")
    return user


async def create_authorization_url(
    req: AuthorizationUrlRequest,
    db: AsyncSession,
    store: KeyValueCache,
) -> AuthorizationUrlResponse:
    """创建 OAuth2 授权请求."""
    client = await get_client_by_id(db, req.client_id)
    if client is None:
        raise HTTPException(status_code=400, detail="Client not found or disabled")

    if not redirect_uri_matches(client.redirect_uris, req.redirect_uri):
        raise HTTPException(status_code=400, detail="Invalid redirect_uri")

    scopes = parse_scopes(req.scope)
    validate_scope_subset(scopes, client.allowed_scopes)

    if req.code_challenge_method != "S256":
        raise HTTPException(status_code=400, detail="Unsupported code_challenge_method")
    if client.client_type == "public" and not req.code_challenge:
        raise HTTPException(status_code=400, detail="PKCE is required for public clients")

    state = secrets.token_urlsafe(32)
    now = int(time.time())
    await store.set(
        _state_key(state),
        json.dumps(
            {
                "client_id": client.client_id,
                "client_name": client.client_name,
                "redirect_uri": req.redirect_uri,
                "scopes": scopes,
                "code_challenge": req.code_challenge,
                "code_challenge_method": req.code_challenge_method,
                "created_at": now,
                "expires_at": now + STATE_TTL,
            }
        ),
        ttl=STATE_TTL,
    )
    return AuthorizationUrlResponse(
        authorizeUrl=_build_authorize_url(state),
        state=state,
    )


async def get_authorize_context(
    state: str,
    user_id: str,
    db: AsyncSession,
    store: KeyValueCache,
) -> AuthorizeContextResponse:
    """获取授权页展示所需的上下文."""
    data = await _get_cache_json(store, _state_key(state))
    if data is None:
        raise HTTPException(status_code=400, detail="Invalid or expired state")

    client = await get_client_by_id(db, str(data["client_id"]))
    if client is None:
        raise HTTPException(status_code=400, detail="Client not found or disabled")

    user = await _get_active_account(db, user_id)
    scopes = [str(scope) for scope in data.get("scopes", [])]

    return AuthorizeContextResponse(
        state=state,
        redirectUri=str(data["redirect_uri"]),
        client=OAuth2ClientInfo(
            client_id=client.client_id,
            client_name=client.client_name,
        ),
        scopes=to_scope_infos(scopes),
        user=OAuth2UserInfo(
            id=user.id,
            nickname=user.nickname or "",
            avatar=user.avatar or "",
        ),
    )


async def approve_authorization(
    state: str,
    user_id: str,
    db: AsyncSession,
    store: KeyValueCache,
) -> AuthorizeApproveResponse:
    """确认授权，生成一次性授权码."""
    data = await _get_cache_json(store, _state_key(state))
    if data is None:
        raise HTTPException(status_code=400, detail="Invalid or expired state")

    client = await get_client_by_id(db, str(data["client_id"]))
    if client is None:
        raise HTTPException(status_code=400, detail="Client not found or disabled")

    await _get_active_account(db, user_id)

    code = secrets.token_urlsafe(32)
    now = int(time.time())
    await store.set(
        _code_key(code),
        json.dumps(
            {
                "code": code,
                "state": state,
                "client_id": client.client_id,
                "redirect_uri": str(data["redirect_uri"]),
                "user_id": user_id,
                "scopes": [str(scope) for scope in data.get("scopes", [])],
                "code_challenge": str(data["code_challenge"]),
                "code_challenge_method": str(data["code_challenge_method"]),
                "created_at": now,
                "expires_at": now + CODE_TTL,
            }
        ),
        ttl=CODE_TTL,
    )
    await store.delete(_state_key(state))

    redirect_uri = str(data["redirect_uri"])
    query = urlencode({"code": code, "state": state})
    separator = "&" if "?" in redirect_uri else "?"
    return AuthorizeApproveResponse(redirectUrl=f"{redirect_uri}{separator}{query}")


def _verify_pkce(code_verifier: str, code_challenge: str) -> bool:
    """校验 PKCE S256 挑战值."""
    digest = hashlib.sha256(code_verifier.encode("utf-8")).digest()
    actual = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return secrets.compare_digest(actual, code_challenge)


async def exchange_token(
    req: TokenRequest,
    db: AsyncSession,
    store: KeyValueCache,
) -> TokenResponse:
    """使用授权码兑换 access token 和 refresh token."""
    if req.grant_type != "authorization_code":
        raise HTTPException(status_code=400, detail="Unsupported grant_type")

    client = await get_client_by_id(db, req.client_id)
    if client is None:
        raise HTTPException(status_code=400, detail="Client not found or disabled")

    if not redirect_uri_matches(client.redirect_uris, req.redirect_uri):
        raise HTTPException(status_code=400, detail="Invalid redirect_uri")

    data = await _get_cache_json(store, _code_key(req.code))
    if data is None:
        raise HTTPException(status_code=400, detail="Invalid or expired code")

    if str(data["client_id"]) != client.client_id:
        raise HTTPException(status_code=400, detail="Client mismatch")
    if str(data["redirect_uri"]) != req.redirect_uri:
        raise HTTPException(status_code=400, detail="redirect_uri mismatch")
    if not _verify_pkce(req.code_verifier, str(data["code_challenge"])):
        raise HTTPException(status_code=400, detail="PKCE verification failed")

    await store.delete(_code_key(req.code))

    user_id = str(data["user_id"])
    user = await _get_active_account(db, user_id)
    scopes = [str(scope) for scope in data.get("scopes", [])]
    scope = join_scopes(scopes)

    token_pair = create_token_pair(
        user.id,
        {"client_id": client.client_id, "scope": scope},
    )
    return TokenResponse(
        accessToken=token_pair.accessToken,
        refreshToken=token_pair.refreshToken,
        expiresIn=token_pair.expiresIn,
        scope=scope,
        user=OAuth2UserInfo(
            id=user.id,
            nickname=user.nickname or "",
            avatar=user.avatar or "",
        ),
    )
