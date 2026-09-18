"""OAuth2 Authorization API endpoints."""

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_cache, get_current_user_id, get_db
from api.oauth2.oauth2_schemas import (
    AuthorizationUrlRequest,
    AuthorizationUrlResponse,
    AuthorizeApproveRequest,
    AuthorizeApproveResponse,
    AuthorizeContextResponse,
    ConsentResponse,
    ConsentRevokeRequest,
    RefreshTokenRequest,
    RevokeTokenRequest,
    TokenRequest,
    TokenResponse,
)
from api.oauth2.oauth2_service import (
    OAuth2TokenError,
    approve_authorization,
    create_authorization_url,
    exchange_token,
    get_authorize_context,
    get_consent_state,
    refresh_token_exchange,
    revoke_consent,
    revoke_token,
)
from core.cache import KeyValueCache
from core.decorators import handle_errors
from core.response import ApiResponse, ok

router = APIRouter(prefix="/api/oauth2", tags=["oauth2"])


@router.post(
    "/authorization-url",
    response_model=ApiResponse[AuthorizationUrlResponse],
)
@handle_errors  # type: ignore
async def authorization_url(
    req: AuthorizationUrlRequest,
    db: AsyncSession = Depends(get_db),
    cache: KeyValueCache = Depends(get_cache),
) -> ApiResponse[AuthorizationUrlResponse]:
    """创建客户端授权请求."""
    result = await create_authorization_url(req, db, cache)
    return ok(result)


@router.get(
    "/authorize/context",
    response_model=ApiResponse[AuthorizeContextResponse],
)
@handle_errors  # type: ignore
async def authorize_context(
    state: str = Query(..., min_length=1),
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
    cache: KeyValueCache = Depends(get_cache),
) -> ApiResponse[AuthorizeContextResponse]:
    """获取通用授权页上下文（含已授权 scope 与免交互标记）."""
    result = await get_authorize_context(state, user_id, db, cache)
    return ok(result)


@router.post(
    "/authorize/approve",
    response_model=ApiResponse[AuthorizeApproveResponse],
)
@handle_errors  # type: ignore
async def authorize_approve(
    req: AuthorizeApproveRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
    cache: KeyValueCache = Depends(get_cache),
) -> ApiResponse[AuthorizeApproveResponse]:
    """用户确认授权并生成授权码（支持按用户开关收窄 scope）."""
    result = await approve_authorization(req.state, user_id, req.scopes, db, cache)
    return ok(result)


@router.get("/consents", response_model=ApiResponse[ConsentResponse])
@handle_errors  # type: ignore
async def consent_detail(
    client_id: str = Query(..., min_length=1, max_length=64),
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[ConsentResponse]:
    """查询当前用户在某客户端下的授权记忆."""
    consent, granted, denied = await get_consent_state(db, client_id, user_id)
    return ok(
        ConsentResponse(
            clientId=client_id,
            grantedScopes=granted,
            deniedScopes=denied,
            deniedExpiresAt=(
                consent.denied_expires_at.isoformat()
                if consent is not None and consent.denied_expires_at is not None
                else None
            ),
            updatedAt=(
                consent.updated_at.isoformat()
                if consent is not None and consent.updated_at is not None
                else None
            ),
        )
    )


@router.post("/consents/revoke", response_model=ApiResponse[None])
@handle_errors  # type: ignore
async def consent_revoke(
    req: ConsentRevokeRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[None]:
    """撤销指定 scope 或整份授权，并同步撤销 refresh token."""
    await revoke_consent(db, req.clientId, user_id, req.scopes)
    return ok(None)


@router.post("/token", response_model=TokenResponse)
async def token(
    req: TokenRequest,
    db: AsyncSession = Depends(get_db),
    cache: KeyValueCache = Depends(get_cache),
) -> TokenResponse | JSONResponse:
    """使用授权码换取 token（RFC 6749 §4.1.3，错误按 §5.2 标准化）."""
    try:
        return await exchange_token(req, db, cache)
    except OAuth2TokenError as e:
        return JSONResponse(
            status_code=e.status_code,
            content={"error": e.error, "error_description": e.description},
        )


@router.post("/refresh", response_model=TokenResponse)
async def refresh(
    req: RefreshTokenRequest,
    db: AsyncSession = Depends(get_db),
) -> TokenResponse | JSONResponse:
    """刷新 access token（refresh token 轮换 + 族撤销）."""
    try:
        return await refresh_token_exchange(req, db)
    except OAuth2TokenError as e:
        return JSONResponse(
            status_code=e.status_code,
            content={"error": e.error, "error_description": e.description},
        )


@router.post("/revoke", status_code=200, response_model=None)
async def revoke(
    req: RevokeTokenRequest,
    db: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """撤销 refresh token（RFC 7009：无效 token 同样返回 200）."""
    try:
        await revoke_token(req, db)
    except OAuth2TokenError as e:
        return JSONResponse(
            status_code=e.status_code,
            content={"error": e.error, "error_description": e.description},
        )
    return JSONResponse(status_code=200, content={})
