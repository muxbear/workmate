"""RBAC management API endpoints."""

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user_id, get_db
from api.rbac.deps import RequirePermission
from api.rbac.schemas import (
    MyPermissionsResponse,
    PermResourceResponse,
    ResourceCreateRequest,
    ResourceReorderRequest,
    ResourceUpdateRequest,
    RoleCreateRequest,
    RolePermissionsResponse,
    RolePermissionsUpdateRequest,
    RoleResponse,
    RoleUpdateRequest,
    UserRolesResponse,
    UserRolesUpdateRequest,
)
from api.rbac.service import RbacService
from core.decorators import handle_errors
from core.response import ApiResponse, ok

router = APIRouter(prefix="/api/rbac", tags=["rbac"])


# ── Permission Resources ─────────────────────────────────────────


@router.get("/resources", response_model=ApiResponse[list[PermResourceResponse]])
@handle_errors
async def list_resources(db: AsyncSession = Depends(get_db)):
    """List all permission resources (catalog/menu/button tree)."""
    svc = RbacService(db)
    data = await svc.list_resources()
    return ok(data)


@router.post("/resources", response_model=ApiResponse[PermResourceResponse])
@handle_errors
async def create_resource(
    req: ResourceCreateRequest,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(RequirePermission("admin:resources")),
):
    """Create a new permission resource."""
    svc = RbacService(db)
    data = await svc.create_resource(req)
    return ok(data, message="资源创建成功")


@router.put("/resources/{resource_id}", response_model=ApiResponse[PermResourceResponse])
@handle_errors
async def update_resource(
    resource_id: str,
    req: ResourceUpdateRequest,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(RequirePermission("admin:resources")),
):
    """Update a permission resource."""
    svc = RbacService(db)
    data = await svc.update_resource(resource_id, req)
    return ok(data, message="资源更新成功")


@router.post("/resources/reorder", response_model=ApiResponse[list[PermResourceResponse]])
@handle_errors
async def reorder_resource(
    req: ResourceReorderRequest,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(RequirePermission("admin:resources")),
):
    """Reorder a permission resource within the tree."""
    svc = RbacService(db)
    data = await svc.reorder_resource(req)
    return ok(data, message="资源顺序已更新")


@router.delete("/resources/{resource_id}", response_model=ApiResponse[dict])
@handle_errors
async def delete_resource(
    resource_id: str,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(RequirePermission("admin:resources")),
):
    """Delete a permission resource and all its descendants."""
    svc = RbacService(db)
    data = await svc.delete_resource(resource_id)
    return ok(data, message=f"已删除 {data['deleted']} 个资源")


# ── Roles ────────────────────────────────────────────────────────


@router.get("/roles", response_model=ApiResponse[list[RoleResponse]])
@handle_errors
async def list_roles(db: AsyncSession = Depends(get_db)):
    """List all roles."""
    svc = RbacService(db)
    data = await svc.list_roles()
    return ok(data)


@router.post("/roles", response_model=ApiResponse[RoleResponse])
@handle_errors
async def create_role(
    req: RoleCreateRequest,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(RequirePermission("admin:rbac")),
):
    """Create a new role, optionally copying permissions from an existing role."""
    svc = RbacService(db)
    data = await svc.create_role(req)
    return ok(data, message="角色创建成功")


@router.put("/roles/{role_id}", response_model=ApiResponse[RoleResponse])
@handle_errors
async def update_role(
    role_id: str,
    req: RoleUpdateRequest,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(RequirePermission("admin:rbac")),
):
    """Update a role."""
    svc = RbacService(db)
    data = await svc.update_role(role_id, req)
    return ok(data, message="角色更新成功")


@router.delete("/roles/{role_id}", response_model=ApiResponse[dict])
@handle_errors
async def delete_role(
    role_id: str,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(RequirePermission("admin:rbac")),
):
    """Delete a role (custom roles only)."""
    svc = RbacService(db)
    data = await svc.delete_role(role_id)
    return ok(data, message="角色已删除")


# ── Role-Permission Assignment ───────────────────────────────────


@router.get("/roles/{role_id}/permissions", response_model=ApiResponse[RolePermissionsResponse])
@handle_errors
async def get_role_permissions(
    role_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Get a role's permission grants and data scopes."""
    svc = RbacService(db)
    data = await svc.get_role_permissions(role_id)
    return ok(data)


@router.put("/roles/{role_id}/permissions", response_model=ApiResponse[RolePermissionsResponse])
@handle_errors
async def save_role_permissions(
    role_id: str,
    req: RolePermissionsUpdateRequest,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(RequirePermission("admin:role:save")),
):
    """Set a role's permission grants and data scopes (full replacement)."""
    svc = RbacService(db)
    data = await svc.save_role_permissions(role_id, req)
    return ok(data, message="权限保存成功")


# ── User-Role Assignment ─────────────────────────────────────────


@router.get("/users/{user_id}/roles", response_model=ApiResponse[UserRolesResponse])
@handle_errors
async def get_user_roles(
    user_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Get a user's assigned roles."""
    svc = RbacService(db)
    data = await svc.get_user_roles(user_id)
    return ok(data)


@router.put("/users/{user_id}/roles", response_model=ApiResponse[UserRolesResponse])
@handle_errors
async def set_user_roles(
    user_id: str,
    req: UserRolesUpdateRequest,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(RequirePermission("admin:rbac")),
):
    """Set a user's assigned roles (full replacement)."""
    svc = RbacService(db)
    data = await svc.set_user_roles(user_id, req)
    return ok(data, message="用户角色更新成功")


# ── Current User Permissions ─────────────────────────────────────


@router.get("/my-permissions", response_model=ApiResponse[MyPermissionsResponse])
@handle_errors
async def my_permissions(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Get the current user's effective permissions, menus, and data scopes."""
    user_id = await get_current_user_id(request)
    svc = RbacService(db)
    data = await svc.get_my_permissions(user_id)
    return ok(data)
