"""RBAC authorization dependencies."""

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user_id, get_db
from db.models.role import Role
from db.models.role_permission import RolePermission
from db.models.user_role import UserRole


async def check_user_permission(db: AsyncSession, user_id: str, perm_key: str) -> bool:
    """Check if user has a specific permission via their roles.

    Super admin role always has all permissions.
    """
    result = await db.execute(
        select(UserRole).where(UserRole.user_id == user_id)
    )
    user_roles = result.scalars().all()
    role_ids = [ur.role_id for ur in user_roles]

    if not role_ids:
        return False

    # Check for super_admin role key
    super_result = await db.execute(
        select(Role).where(Role.id.in_(role_ids), Role.key == "super_admin")
    )
    if super_result.scalar_one_or_none():
        return True

    # Check specific permission
    perm_result = await db.execute(
        select(RolePermission).where(
            RolePermission.role_id.in_(role_ids),
            RolePermission.perm_key == perm_key,
        )
    )
    return perm_result.scalar_one_or_none() is not None


def RequirePermission(perm_key: str):
    """FastAPI dependency factory: require a specific permission.

    Usage:
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
        user_id = await get_current_user_id(request)
        if not await check_user_permission(db, user_id, perm_key):
            raise HTTPException(
                status_code=403,
                detail=f"Missing permission: {perm_key}",
            )
        return user_id

    return checker


async def get_current_user_roles(
    user_id: str,
    db: AsyncSession,
) -> list[Role]:
    """Get all roles assigned to a user."""
    result = await db.execute(
        select(Role)
        .join(UserRole, UserRole.role_id == Role.id)
        .where(UserRole.user_id == user_id, Role.is_active)
    )
    return list(result.scalars().all())
