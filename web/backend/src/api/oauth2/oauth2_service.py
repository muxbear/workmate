"""OAuth2 Authorization Code + PKCE 业务逻辑."""

import base64
import hashlib
import json
import logging
import secrets
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode

from fastapi import HTTPException
from sqlalchemy import select, update
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
    RefreshTokenRequest,
    RevokeTokenRequest,
    TokenRequest,
    TokenResponse,
)
from api.oauth2.scope_service import (
    REQUIRED_SCOPES,
    join_scopes,
    parse_scopes,
    to_scope_infos,
    validate_scope_subset,
)
from core.cache import KeyValueCache
from core.security import create_token_pair
from db.models import Account, OAuth2Consent, OAuth2RefreshToken

logger = logging.getLogger(__name__)

STATE_TTL = 600
CODE_TTL = 300
# 被用户关闭的 scope 到期后恢复「默认开启」（决策 D4）
DENIED_SCOPE_TTL_DAYS = 90


class OAuth2TokenError(Exception):
    """OAuth2 token 端点错误（RFC 6749 §5.2 / RFC 7009）."""

    def __init__(self, error: str, description: str, status_code: int = 400) -> None:
        """初始化错误码、描述与 HTTP 状态码."""
        super().__init__(description)
        self.error = error
        self.description = description
        self.status_code = status_code


def _hash_refresh_token(token: str) -> str:
    """计算 refresh token 的 SHA-256 摘要（库中不存明文）."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _utcnow() -> datetime:
    """返回无时区的 UTC 时间（与 DateTime 列存储保持一致）."""
    return datetime.now(UTC).replace(tzinfo=None)


def _state_key(state: str) -> str:
    return f"oauth2:state:{state}"


def _code_key(code: str) -> str:
    return f"oauth2:code:{code}"


def _build_authorize_url(
    state: str,
    client_id: str,
    redirect_uri: str,
    scopes: list[str],
    code_challenge: str,
    code_challenge_method: str,
) -> str:
    """构造 Web 前端通用授权页 URL（携带 RFC 6749 §4.1.1 + RFC 7636 §4.3 标准参数）."""
    base_url = settings.OAUTH2_FRONTEND_URL.rstrip("/")
    query = urlencode(
        {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "scope": join_scopes(scopes),
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": code_challenge_method,
        }
    )
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


# ── 授权记忆（consent） ──


async def _get_consent(
    db: AsyncSession, client_id: str, user_id: str
) -> OAuth2Consent | None:
    """查询用户在指定客户端下的授权记忆."""
    result = await db.execute(
        select(OAuth2Consent).where(
            OAuth2Consent.client_id == client_id,
            OAuth2Consent.user_id == user_id,
        )
    )
    return result.scalar_one_or_none()


def _expire_denied(consent: OAuth2Consent, now: datetime) -> bool:
    """关闭项到期后恢复默认开启，返回是否发生变更."""
    if consent.denied_expires_at is None or consent.denied_expires_at >= now:
        return False
    consent.denied_scope = ""
    consent.denied_expires_at = None
    consent.updated_at = now
    return True


async def get_consent_state(
    db: AsyncSession, client_id: str, user_id: str
) -> tuple[OAuth2Consent | None, list[str], list[str]]:
    """读取授权记忆，返回 (记录, 已授权 scope, 已关闭 scope)，含过期重置."""
    consent = await _get_consent(db, client_id, user_id)
    if consent is None:
        return None, [], []
    if _expire_denied(consent, _utcnow()):
        await db.flush()
    return consent, parse_scopes(consent.scope), parse_scopes(consent.denied_scope)


async def _save_consent(
    db: AsyncSession,
    client_id: str,
    user_id: str,
    granted: list[str],
    denied: list[str],
    now: datetime,
) -> OAuth2Consent:
    """写入/更新授权记忆（granted 并集 + denied 集合）."""
    consent = await _get_consent(db, client_id, user_id)
    if consent is None:
        consent = OAuth2Consent(
            client_id=client_id,
            user_id=user_id,
            scope="",
            denied_scope="",
            granted_at=now,
            updated_at=now,
        )
        db.add(consent)
    consent.scope = join_scopes(granted)
    consent.denied_scope = join_scopes(denied)
    consent.denied_expires_at = (
        now + timedelta(days=DENIED_SCOPE_TTL_DAYS) if denied else None
    )
    consent.updated_at = now
    await db.flush()
    return consent


async def _revoke_consent_refresh_tokens(
    db: AsyncSession, client_id: str, user_id: str, now: datetime
) -> int:
    """撤销该客户端 + 用户下全部未撤销的 refresh token，返回撤销条数."""
    result = await db.execute(
        update(OAuth2RefreshToken)
        .where(
            OAuth2RefreshToken.client_id == client_id,
            OAuth2RefreshToken.user_id == user_id,
            OAuth2RefreshToken.revoked_at.is_(None),
        )
        .values(revoked_at=now)
    )
    return int(getattr(result, "rowcount", 0) or 0)


async def revoke_consent(
    db: AsyncSession,
    client_id: str,
    user_id: str,
    scopes: list[str] | None,
) -> None:
    """撤销指定 scope 或整份授权，并同步撤销 refresh token（决策 D1）."""
    now = _utcnow()
    consent = await _get_consent(db, client_id, user_id)
    if consent is not None:
        if scopes is None:
            await db.delete(consent)
        else:
            _expire_denied(consent, now)
            granted = parse_scopes(consent.scope)
            denied = parse_scopes(consent.denied_scope)
            removed = [scope for scope in dict.fromkeys(scopes) if scope]
            consent.scope = join_scopes([s for s in granted if s not in removed])
            consent.denied_scope = join_scopes([*denied, *removed])
            consent.denied_expires_at = now + timedelta(days=DENIED_SCOPE_TTL_DAYS)
            consent.updated_at = now
    await _revoke_consent_refresh_tokens(db, client_id, user_id, now)
    await db.flush()


# ── 授权端点 ──


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
        authorizeUrl=_build_authorize_url(
            state,
            client.client_id,
            req.redirect_uri,
            scopes,
            req.code_challenge,
            req.code_challenge_method,
        ),
        state=state,
    )


async def get_authorize_context(
    state: str,
    user_id: str,
    db: AsyncSession,
    store: KeyValueCache,
) -> AuthorizeContextResponse:
    """获取授权页展示所需的上下文（含已授权 scope 与免交互标记）."""
    data = await _get_cache_json(store, _state_key(state))
    if data is None:
        raise HTTPException(status_code=400, detail="Invalid or expired state")

    client = await get_client_by_id(db, str(data["client_id"]))
    if client is None:
        raise HTTPException(status_code=400, detail="Client not found or disabled")

    user = await _get_active_account(db, user_id)
    scopes = [str(scope) for scope in data.get("scopes", [])]

    _, granted, _denied = await get_consent_state(db, client.client_id, user_id)
    granted_set = set(granted)
    granted_requested = [scope for scope in scopes if scope in granted_set]
    auto_approve = bool(scopes) and set(scopes).issubset(granted_set)

    return AuthorizeContextResponse(
        state=state,
        redirectUri=str(data["redirect_uri"]),
        client=OAuth2ClientInfo(
            client_id=client.client_id,
            client_name=client.client_name,
        ),
        scopes=to_scope_infos(scopes, granted=granted_requested),
        user=OAuth2UserInfo(
            id=user.id,
            nickname=user.nickname or "",
            avatar=user.avatar or "",
        ),
        grantedScopes=granted_requested,
        autoApprove=auto_approve,
    )


async def approve_authorization(
    state: str,
    user_id: str,
    scopes: list[str] | None,
    db: AsyncSession,
    store: KeyValueCache,
) -> AuthorizeApproveResponse:
    """确认授权，生成一次性授权码（支持按用户开关收窄 scope）."""
    data = await _get_cache_json(store, _state_key(state))
    if data is None:
        raise HTTPException(status_code=400, detail="Invalid or expired state")

    client = await get_client_by_id(db, str(data["client_id"]))
    if client is None:
        raise HTTPException(status_code=400, detail="Client not found or disabled")

    await _get_active_account(db, user_id)

    requested = [str(scope) for scope in data.get("scopes", [])]
    if scopes is None:
        approved = list(requested)
    else:
        selected = parse_scopes(join_scopes([str(scope) for scope in scopes if scope]))
        if not set(selected).issubset(set(requested)):
            raise HTTPException(
                status_code=400,
                detail="invalid_scope: 提交的权限超出本次请求范围",
            )
        # 必选 scope 不可关闭：按请求顺序保留「用户勾选 + 必选」
        approved = [
            scope for scope in requested if scope in selected or scope in REQUIRED_SCOPES
        ]
        if not approved:
            raise HTTPException(
                status_code=400,
                detail="invalid_scope: 至少保留一项权限",
            )

    now = _utcnow()
    _consent, granted, denied = await get_consent_state(db, client.client_id, user_id)
    final_scopes = list(dict.fromkeys([*granted, *approved]))
    new_denied = [scope for scope in denied if scope not in approved]
    for scope in requested:
        if scope not in final_scopes and scope not in new_denied:
            new_denied.append(scope)
    await _save_consent(db, client.client_id, user_id, final_scopes, new_denied, now)

    code = secrets.token_urlsafe(32)
    now_ts = int(time.time())
    await store.set(
        _code_key(code),
        json.dumps(
            {
                "code": code,
                "state": state,
                "client_id": client.client_id,
                "redirect_uri": str(data["redirect_uri"]),
                "user_id": user_id,
                "scopes": final_scopes,
                "code_challenge": str(data["code_challenge"]),
                "code_challenge_method": str(data["code_challenge_method"]),
                "created_at": now_ts,
                "expires_at": now_ts + CODE_TTL,
            }
        ),
        ttl=CODE_TTL,
    )
    await store.delete(_state_key(state))

    redirect_uri = str(data["redirect_uri"])
    query = urlencode({"code": code, "state": state})
    separator = "&" if "?" in redirect_uri else "?"
    return AuthorizeApproveResponse(
        redirectUrl=f"{redirect_uri}{separator}{query}",
        grantedScopes=final_scopes,
    )


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
        raise OAuth2TokenError("unsupported_grant_type", "Unsupported grant_type")

    client = await get_client_by_id(db, req.client_id)
    if client is None:
        raise OAuth2TokenError("invalid_client", "Client not found or disabled")

    if not redirect_uri_matches(client.redirect_uris, req.redirect_uri):
        raise OAuth2TokenError("invalid_grant", "Invalid redirect_uri")

    data = await _get_cache_json(store, _code_key(req.code))
    if data is None:
        raise OAuth2TokenError("invalid_grant", "Invalid or expired code")

    if str(data["client_id"]) != client.client_id:
        raise OAuth2TokenError("invalid_grant", "Client mismatch")
    if str(data["redirect_uri"]) != req.redirect_uri:
        raise OAuth2TokenError("invalid_grant", "redirect_uri mismatch")
    if not _verify_pkce(req.code_verifier, str(data["code_challenge"])):
        raise OAuth2TokenError("invalid_grant", "PKCE verification failed")

    await store.delete(_code_key(req.code))

    user_id = str(data["user_id"])
    user = await _get_active_account(db, user_id)
    scopes = [str(scope) for scope in data.get("scopes", [])]
    scope = join_scopes(scopes)

    token_pair = create_token_pair(
        user.id,
        {"client_id": client.client_id, "scope": scope},
    )
    refresh_token, _family = await _issue_refresh_token(
        db, client.client_id, user.id, scopes
    )
    return TokenResponse(
        access_token=token_pair.accessToken,
        token_type="Bearer",
        expires_in=token_pair.expiresIn,
        refresh_token=refresh_token,
        scope=scope,
        user=OAuth2UserInfo(
            id=user.id,
            nickname=user.nickname or "",
            avatar=user.avatar or "",
        ),
    )


async def _issue_refresh_token(
    db: AsyncSession,
    client_id: str,
    user_id: str,
    scopes: list[str],
    family_id: str | None = None,
) -> tuple[str, str]:
    """签发 opaque refresh token 并落库（仅存摘要），返回 (token, family_id）."""
    token = secrets.token_urlsafe(48)
    family = family_id or str(uuid.uuid4())
    now = _utcnow()
    db.add(
        OAuth2RefreshToken(
            client_id=client_id,
            user_id=user_id,
            token_hash=_hash_refresh_token(token),
            family_id=family,
            scope=join_scopes(scopes),
            expires_at=now + timedelta(seconds=settings.JWT_REFRESH_EXPIRE),
            created_at=now,
        )
    )
    return token, family


async def _revoke_family(db: AsyncSession, family_id: str, now: datetime) -> int:
    """撤销同一授权族内全部未撤销的 refresh token，返回撤销条数."""
    result = await db.execute(
        update(OAuth2RefreshToken)
        .where(
            OAuth2RefreshToken.family_id == family_id,
            OAuth2RefreshToken.revoked_at.is_(None),
        )
        .values(revoked_at=now)
    )
    return int(getattr(result, "rowcount", 0) or 0)


async def refresh_token_exchange(
    req: RefreshTokenRequest,
    db: AsyncSession,
) -> TokenResponse:
    """使用 refresh token 轮换签发新 token（RFC 6749 §6 + RFC 9700 §4.14.2）."""
    if req.grant_type != "refresh_token":
        raise OAuth2TokenError("unsupported_grant_type", "Unsupported grant_type")

    client = await get_client_by_id(db, req.client_id)
    if client is None:
        raise OAuth2TokenError("invalid_client", "Client not found or disabled")

    result = await db.execute(
        select(OAuth2RefreshToken).where(
            OAuth2RefreshToken.token_hash == _hash_refresh_token(req.refresh_token)
        )
    )
    record = result.scalar_one_or_none()
    now = _utcnow()

    if record is None:
        raise OAuth2TokenError("invalid_grant", "Invalid refresh token")

    if record.revoked_at is not None:
        # 重用检测：已撤销 token 再次出现视为盗用，撤销整族（RFC 9700 §4.14.2）
        revoked = await _revoke_family(db, record.family_id, now)
        logger.warning(
            "OAuth2 refresh token reuse detected: client=%s user=%s family=%s revoked=%d",
            record.client_id,
            record.user_id,
            record.family_id,
            revoked,
        )
        raise OAuth2TokenError("invalid_grant", "Refresh token has been revoked")

    if record.expires_at < now:
        raise OAuth2TokenError("invalid_grant", "Refresh token expired")

    if record.client_id != client.client_id:
        raise OAuth2TokenError("invalid_grant", "Client mismatch")

    user = await _get_active_account(db, record.user_id)
    original_scopes = parse_scopes(record.scope)

    if req.scope:
        requested = parse_scopes(req.scope)
        # 只允许收窄，禁止扩大（RFC 6749 §6）
        if not set(requested).issubset(set(original_scopes)):
            raise OAuth2TokenError(
                "invalid_scope", "Requested scope exceeds original scope"
            )
        validate_scope_subset(requested, client.allowed_scopes)
        scopes = requested
    else:
        scopes = original_scopes

    # 轮换：撤销旧记录，签发同族新 token
    record.revoked_at = now
    refresh_token, _family = await _issue_refresh_token(
        db, client.client_id, user.id, scopes, family_id=record.family_id
    )

    scope = join_scopes(scopes)
    token_pair = create_token_pair(
        user.id,
        {"client_id": client.client_id, "scope": scope},
    )
    return TokenResponse(
        access_token=token_pair.accessToken,
        token_type="Bearer",
        expires_in=token_pair.expiresIn,
        refresh_token=refresh_token,
        scope=scope,
        user=OAuth2UserInfo(
            id=user.id,
            nickname=user.nickname or "",
            avatar=user.avatar or "",
        ),
    )


async def revoke_token(
    req: RevokeTokenRequest,
    db: AsyncSession,
) -> None:
    """撤销 refresh token（RFC 7009：无效 token 同样返回成功，防有效性探测）."""
    result = await db.execute(
        select(OAuth2RefreshToken).where(
            OAuth2RefreshToken.token_hash == _hash_refresh_token(req.token)
        )
    )
    record = result.scalar_one_or_none()
    if record is not None and record.revoked_at is None:
        record.revoked_at = _utcnow()
