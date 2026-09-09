import logging
import time

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.auth.schemas import (
    AccountLoginRequest,
    AuthResponse,
    AuthTokens,
    ChangePasswordRequest,
    EmailRegisterRequest,
    LoginFailInfo,
    MyRolesResponse,
    PhoneLoginRequest,
    RefreshRequest,
    RegisterRequest,
    RoleInfo,
    UserInfo,
)
from api.rbac.role_utils import (
    find_active_user_role,
    list_active_user_roles,
)
from core.cache import KeyValueCache
from core.security import (
    create_token_pair,
    decode_token,
    decrypt_password,
    hash_password,
    verify_password,
)
from core.security import (
    get_public_key as _get_public_key,
)
from db.models import Account, LoginRecord

logger = logging.getLogger(__name__)


async def get_public_key_svc() -> str:
    return _get_public_key()


async def _get_fail_info(account: str, store: KeyValueCache) -> LoginFailInfo:
    data = await store.get(f"login:fail:{account}")
    if not data:
        return LoginFailInfo(failCount=0, lockedUntil=None)
    try:
        count_str, until_str = data.split(":", 1)
        fail_count = int(count_str)
        locked_until = int(until_str) if until_str and until_str != "0" else None
        if locked_until and time.time() > locked_until:
            return LoginFailInfo(failCount=0, lockedUntil=None)
        return LoginFailInfo(failCount=fail_count, lockedUntil=locked_until)
    except (ValueError, IndexError):
        return LoginFailInfo(failCount=0, lockedUntil=None)


async def _check_locked(account: str, store: KeyValueCache):
    info = await _get_fail_info(account, store)
    if info.lockedUntil and time.time() < info.lockedUntil:
        remaining = int(info.lockedUntil - time.time())
        raise HTTPException(
            status_code=403,
            detail=f"Account locked. Try again in {remaining // 60 + 1} minutes.",
        )


async def _record_login(session: AsyncSession, account: str, success: bool, ip: str = ""):
    session.add(LoginRecord(account=account, success=success, ip=ip))


async def _incr_fail(account: str, store: KeyValueCache):
    from agent.config import settings

    count = await store.incr(f"login:fail:{account}")
    if count >= settings.LOGIN_MAX_FAILS:
        until = int(time.time()) + settings.LOGIN_LOCK_MINUTES * 60
        await store.set(f"login:fail:{account}", f"{count}:{until}", ttl=settings.LOGIN_LOCK_MINUTES * 60)
    else:
        await store.set(f"login:fail:{account}", f"{count}:0", ttl=settings.LOGIN_LOCK_MINUTES * 60 * 2)


async def _clear_fail(account: str, store: KeyValueCache):
    await store.delete(f"login:fail:{account}")


async def user_to_info(user: Account, db: AsyncSession) -> UserInfo:
    """构建登录/刷新响应中的用户信息，包含全部角色与默认活动角色."""
    active_roles = await list_active_user_roles(db, user.id)
    roles = [role.key for role in active_roles]

    # Get email/phone from linked personnel record
    from db.models.personnel import Personnel

    personnel_email = ""
    personnel_phone = ""
    personnel_result = await db.execute(
        select(Personnel).where(Personnel.account_id == user.id)
    )
    personnel = personnel_result.scalar_one_or_none()
    if personnel:
        personnel_email = personnel.email or ""
        personnel_phone = personnel.phone or ""

    return UserInfo(
        id=user.id,
        nickname=user.nickname or "",
        avatar=user.avatar or "",
        phone=personnel_phone,
        email=personnel_email,
        workspaceId=user.workspace_id or "default",
        roles=roles,
        roleList=[
            RoleInfo(key=role.key, name=role.name, sortOrder=role.sort_order)
            for role in active_roles
        ],
        activeRole=active_roles[0].key if active_roles else None,
    )


async def _to_auth_response(
    user: Account,
    db: AsyncSession,
    active_role: str | None = None,
) -> AuthResponse:
    """签发带活动角色的 Token 并组装登录响应."""
    user_info = await user_to_info(user, db)
    role_key = active_role or user_info.activeRole
    extra = {"role": role_key} if role_key else None
    token_pair = create_token_pair(user.id, extra)
    return AuthResponse(
        tokens=AuthTokens(
            accessToken=token_pair.accessToken,
            refreshToken=token_pair.refreshToken,
            expiresIn=token_pair.expiresIn,
        ),
        user=user_info,
    )


async def account_login(
    req: AccountLoginRequest,
    db: AsyncSession,
    store: KeyValueCache,
    ip: str = "",
) -> AuthResponse:
    await _check_locked(req.account, store)

    try:
        plain_password = decrypt_password(req.password)
    except HTTPException:
        await _incr_fail(req.account, store)
        raise

    result = await db.execute(
        select(Account).where(Account.username == req.account)
    )
    user = result.scalar_one_or_none()

    if not user or not user.password_hash or not verify_password(plain_password, user.password_hash):
        await _record_login(db, req.account, False, ip)
        await _incr_fail(req.account, store)
        raise HTTPException(status_code=401, detail="Invalid account or password")

    await _record_login(db, req.account, True, ip)
    await _clear_fail(req.account, store)
    return await _to_auth_response(user, db)


async def phone_login(
    req: PhoneLoginRequest,
    db: AsyncSession,
    store: KeyValueCache,
) -> AuthResponse:
    code = await store.get(f"sms:{req.phone}")
    if not code or code != req.smsCode:
        raise HTTPException(status_code=400, detail="Invalid or expired SMS code")
    await store.delete(f"sms:{req.phone}")

    result = await db.execute(select(Account).where(Account.phone == req.phone))
    user = result.scalar_one_or_none()

    if not user:
        user = Account(phone=req.phone, nickname=f"Account{req.phone[-4:]}")
        db.add(user)
        await db.flush()
        await db.refresh(user)

    return await _to_auth_response(user, db)


async def register_phone(
    req: RegisterRequest,
    db: AsyncSession,
    store: KeyValueCache,
) -> AuthResponse:
    code = await store.get(f"sms:{req.phone}")
    if not code or code != req.smsCode:
        raise HTTPException(status_code=400, detail="Invalid or expired SMS code")
    await store.delete(f"sms:{req.phone}")

    existing = await db.execute(select(Account).where(Account.phone == req.phone))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Phone already registered")

    try:
        plain_password = decrypt_password(req.password)
    except HTTPException:
        raise HTTPException(status_code=400, detail="Invalid password encryption")

    user = Account(
        phone=req.phone,
        nickname=req.nickname,
        password_hash=hash_password(plain_password),
    )
    db.add(user)
    await db.flush()
    await db.refresh(user)

    return await _to_auth_response(user, db)


async def register_email(
    req: EmailRegisterRequest,
    db: AsyncSession,
    store: KeyValueCache,
) -> AuthResponse:
    code = await store.get(f"email:{req.email}")
    if not code or code != req.emailCode:
        raise HTTPException(status_code=400, detail="Invalid or expired email code")
    await store.delete(f"email:{req.email}")

    existing = await db.execute(select(Account).where(Account.email == req.email))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Email already registered")

    try:
        plain_password = decrypt_password(req.password)
    except HTTPException:
        raise HTTPException(status_code=400, detail="Invalid password encryption")

    user = Account(
        email=req.email,
        nickname=req.nickname,
        password_hash=hash_password(plain_password),
    )
    db.add(user)
    await db.flush()
    await db.refresh(user)

    return await _to_auth_response(user, db)


async def refresh_token_svc(
    req: RefreshRequest,
    db: AsyncSession,
) -> AuthResponse:
    payload = decode_token(req.refreshToken, expected_type="refresh")
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")

    result = await db.execute(select(Account).where(Account.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="Account not found")

    claimed_role = payload.get("role")
    if claimed_role and not await find_active_user_role(db, user_id, claimed_role):
        # 角色已被移除/停用时回退到默认角色，避免会话卡死
        claimed_role = None
    return await _to_auth_response(user, db, active_role=claimed_role)


async def switch_role_svc(
    role_key: str,
    user_id: str,
    db: AsyncSession,
) -> AuthResponse:
    """切换会话活动角色：校验角色归属后签发新 Token 对."""
    result = await db.execute(select(Account).where(Account.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="账号不存在")

    role = await find_active_user_role(db, user_id, role_key)
    if not role:
        raise HTTPException(status_code=403, detail="角色未分配或已停用")

    return await _to_auth_response(user, db, active_role=role_key)


async def get_my_roles_svc(
    user_id: str,
    claimed_role: str | None,
    db: AsyncSession,
) -> MyRolesResponse:
    """返回当前账号全部启用角色；claimed_role 失效时回退默认角色."""
    roles = await list_active_user_roles(db, user_id)
    role_keys = [role.key for role in roles]
    active_role = claimed_role if claimed_role in role_keys else (
        role_keys[0] if role_keys else None
    )
    return MyRolesResponse(
        roles=[
            RoleInfo(key=role.key, name=role.name, sortOrder=role.sort_order)
            for role in roles
        ],
        activeRole=active_role,
    )


async def get_fail_count_svc(account: str, store: KeyValueCache) -> LoginFailInfo:
    return await _get_fail_info(account, store)


async def change_password(
    req: ChangePasswordRequest,
    user_id: str,
    db: AsyncSession,
) -> None:
    result = await db.execute(select(Account).where(Account.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail='用户不存在')

    if not user.password_hash:
        raise HTTPException(status_code=400, detail='当前账户未设置密码')

    try:
        plain_old = decrypt_password(req.oldPassword)
    except HTTPException:
        raise HTTPException(status_code=400, detail='密码解密失败')

    if not verify_password(plain_old, user.password_hash):
        raise HTTPException(status_code=400, detail='原始密码不正确')

    try:
        plain_new = decrypt_password(req.newPassword)
    except HTTPException:
        raise HTTPException(status_code=400, detail='密码解密失败')

    if plain_new == plain_old:
        raise HTTPException(status_code=400, detail='新密码不能与原始密码相同')

    user.password_hash = hash_password(plain_new)
    await db.flush()
