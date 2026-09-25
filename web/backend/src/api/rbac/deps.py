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

    返回的依赖函数带 ``__permission_key__`` 标记：路由是用装饰器声明依赖的，
    运行期无法反查"这个接口要求什么权限"，测试只能靠导入源码文本去猜。有了标记，
    就能写一条结构化断言——**所有写接口都必须挂权限依赖**，新增接口漏挂会被测出来。
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
                detail=f"缺少权限：{perm_key}（请联系管理员在「权限管理」中为当前角色授予）",
            )
        return user_id

    checker.__permission_key__ = perm_key  # type: ignore[attr-defined]
    return checker
