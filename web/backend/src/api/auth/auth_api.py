from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from api.auth.schemas import (
    AccountLoginRequest,
    AuthResponse,
    ChangePasswordRequest,
    EmailRegisterRequest,
    MyRolesResponse,
    PhoneLoginRequest,
    RefreshRequest,
    RegisterRequest,
    SwitchRoleRequest,
)
from api.auth.service import (
    account_login,
    change_password,
    get_fail_count_svc,
    get_my_roles_svc,
    get_public_key_svc,
    phone_login,
    refresh_token_svc,
    register_email,
    register_phone,
    switch_role_svc,
)
from api.deps import (
    get_cache,
    get_client_ip,
    get_current_token_payload,
    get_current_user_id,
    get_db,
)
from core.cache import KeyValueCache
from core.decorators import handle_errors
from core.response import ApiResponse, ok

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.get("/public-key")
async def public_key():
    pub = await get_public_key_svc()
    return ok({"publicKey": pub})


@router.post("/login/account", response_model=ApiResponse[AuthResponse])
@handle_errors
async def login_account(
    req: AccountLoginRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    cache: KeyValueCache = Depends(get_cache),
):
    result = await account_login(req, db, cache, ip=get_client_ip(request))
    return ok(result)


@router.post("/login/phone", response_model=ApiResponse[AuthResponse])
@handle_errors
async def login_phone(
    req: PhoneLoginRequest,
    db: AsyncSession = Depends(get_db),
    cache: KeyValueCache = Depends(get_cache),
):
    result = await phone_login(req, db, cache)
    return ok(result)


@router.post("/register/phone", response_model=ApiResponse[AuthResponse])
@handle_errors
async def register_phone_route(
    req: RegisterRequest,
    db: AsyncSession = Depends(get_db),
    cache: KeyValueCache = Depends(get_cache),
):
    result = await register_phone(req, db, cache)
    return ok(result)


@router.post("/register/email", response_model=ApiResponse[AuthResponse])
@handle_errors
async def register_email_route(
    req: EmailRegisterRequest,
    db: AsyncSession = Depends(get_db),
    cache: KeyValueCache = Depends(get_cache),
):
    result = await register_email(req, db, cache)
    return ok(result)


@router.post("/logout")
async def logout():
    return ok(None)


@router.post("/refresh", response_model=ApiResponse[AuthResponse])
@handle_errors
async def refresh(
    req: RefreshRequest,
    db: AsyncSession = Depends(get_db),
):
    result = await refresh_token_svc(req, db)
    return ok(result)


@router.post("/switch-role", response_model=ApiResponse[AuthResponse])
@handle_errors
async def switch_role(
    req: SwitchRoleRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """切换当前会话的活动角色，并签发新的 Token 对."""
    result = await switch_role_svc(req.roleKey, user_id, db)
    return ok(result, message="角色切换成功")


@router.get("/me/roles", response_model=ApiResponse[MyRolesResponse])
@handle_errors
async def my_roles(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """获取当前账号的角色列表与活动角色（供角色下拉实时刷新）."""
    payload = await get_current_token_payload(request)
    result = await get_my_roles_svc(str(payload["sub"]), payload.get("role"), db)
    return ok(result)


@router.get("/fail-count")
async def fail_count(
    account: str,
    cache: KeyValueCache = Depends(get_cache),
):
    info = await get_fail_count_svc(account, cache)
    return ok(info.model_dump())

@router.post("/change-password")
@handle_errors
async def change_password_route(
    req: ChangePasswordRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    await change_password(req, user_id, db)
    return ok(None)
