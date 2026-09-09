"""共享的角色查询与默认角色工具."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.models.role import Role
from db.models.user_role import UserRole


def role_sort_key(role: Role) -> tuple[int, int, str]:
    """角色排序：超级管理员优先，其次 sort_order 升序，最后按 key 稳定排序."""
    return (0 if role.key == "super_admin" else 1, role.sort_order, role.key)


async def list_active_user_roles(db: AsyncSession, user_id: str) -> list[Role]:
    """查询用户所有启用中的角色，并按权限优先级从高到低排序."""
    result = await db.execute(
        select(Role)
        .join(UserRole, UserRole.role_id == Role.id)
        .where(UserRole.user_id == user_id, Role.is_active.is_(True))
    )
    roles = list(result.scalars().all())
    return sorted(roles, key=role_sort_key)


async def find_active_user_role(
    db: AsyncSession, user_id: str, role_key: str
) -> Role | None:
    """查询用户某个启用中的角色，未分配或已停用返回 None."""
    result = await db.execute(
        select(Role)
        .join(UserRole, UserRole.role_id == Role.id)
        .where(
            UserRole.user_id == user_id,
            Role.key == role_key,
            Role.is_active.is_(True),
        )
    )
    return result.scalar_one_or_none()


async def pick_default_role(db: AsyncSession, user_id: str) -> Role | None:
    """选取用户默认（权限最大）角色；无启用角色时返回 None."""
    roles = await list_active_user_roles(db, user_id)
    return roles[0] if roles else None
