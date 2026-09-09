"""RBAC 鉴权依赖：按会话活动角色进行权限判断."""

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_token_payload, get_db
from api.rbac.role_utils import find_active_user_role, list_active_user_roles
from db.models.role_permission import RolePermission


async def check_user_permission(
    db: AsyncSession,
    user_id: str,
    perm_key: str,
    role_key: str | None = None,
) -> bool:
    """判断用户活动角色是否拥有指定权限.

    超级管理员默认拥有全部权限；未提供 role_key 时回退到用户默认角色。
    """
    role = None
    if role_key:
        role = await find_active_user_role(db, user_id, role_key)
    if role is None:
        # 旧 Token 无 role claim 或所持角色已失效时，回退默认角色
        roles = await list_active_user_roles(db, user_id)
        role = roles[0] if roles else None

    if role is None:
        return False

    if role.key == "super_admin":
        return True

    result = await db.execute(
        select(RolePermission).where(
            RolePermission.role_id == role.id,
            RolePermission.perm_key == perm_key,
        )
    )
    return result.scalar_one_or_none() is not None


def RequirePermission(perm_key: str):
    """FastAPI 依赖工厂：要求当前会话的活动角色拥有指定权限.

    用法示例:
        @router.delete("/users/{id}")
        async def delete_user(
            user_id: str,
            _: str = Depends(RequirePermission("admin:user:delete")),
        ): ...
    """
    async def checker(
        request: Request,
        db: AsyncSession = Depends(get_db),
    ) -> str:
        payload = await get_current_token_payload(request)
        user_id = str(payload["sub"])
        role_key = payload.get("role")
        if not await check_user_permission(db, user_id, perm_key, role_key):
            raise HTTPException(
                status_code=403,
                detail=f"Missing permission: {perm_key}",
            )
        return user_id

    return checker
