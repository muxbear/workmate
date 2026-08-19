"""OAuth2 Authorization API endpoints."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_cache, get_current_user_id, get_db
from api.oauth2.oauth2_schemas import (
    AuthorizationUrlRequest,
    AuthorizationUrlResponse,
    AuthorizeApproveRequest,
    AuthorizeApproveResponse,
    AuthorizeContextResponse,
    TokenRequest,
    TokenResponse,
)
from api.oauth2.oauth2_service import (
    approve_authorization,
    create_authorization_url,
    exchange_token,
    get_authorize_context,
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
    """获取通用授权页上下文."""
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
    """用户确认授权并生成授权码."""
    result = await approve_authorization(req.state, user_id, db, cache)
    return ok(result)


@router.post("/token", response_model=ApiResponse[TokenResponse])
@handle_errors  # type: ignore
async def token(
    req: TokenRequest,
    db: AsyncSession = Depends(get_db),
    cache: KeyValueCache = Depends(get_cache),
) -> ApiResponse[TokenResponse]:
    """使用授权码换取 token."""
    result = await exchange_token(req, db, cache)
    return ok(result)
