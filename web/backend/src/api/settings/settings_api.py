"""系统设置 API：全局系统标识与按用户偏好.

读写分两个 router：``/api/settings`` 下的读接口不要求管理员权限
（系统名称与 LOGO 是公开品牌信息，登录页也要渲染），写接口放在
``/api/admin/settings`` 下并复用 ``admin:params`` 权限。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user_id, get_db
from api.rbac.deps import RequirePermission
from api.settings import service
from api.settings.schemas import (
    SystemIdentityResponse,
    SystemIdentityUpdateRequest,
    UserPreferencesResponse,
    UserPreferencesUpdateRequest,
)
from core.decorators import handle_errors
from core.response import ApiResponse, ok

router = APIRouter(prefix="/api/settings", tags=["settings"])
admin_router = APIRouter(prefix="/api/admin/settings", tags=["settings-admin"])


@router.get("/system", response_model=ApiResponse[SystemIdentityResponse])
@handle_errors
async def read_system_identity(db: AsyncSession = Depends(get_db)) -> Any:
    """读取系统标识（公开接口）.

    刻意不要求登录：登录页在 MainLayout 之外，未认证就要显示系统名称与
    LOGO；且 ``<img src>`` 无法携带 Authorization 头。这里只暴露品牌信息，
    不含任何用户数据。
    """
    return ok(await service.get_system_identity(db))


@router.get("/system/logo")
@handle_errors
async def read_system_logo(db: AsyncSession = Depends(get_db)) -> Any:
    """读取系统 LOGO 字节（公开接口）；未配置时返回 404."""
    logo = await service.read_logo(db)
    if logo is None:
        raise HTTPException(status_code=404, detail="系统 LOGO 未设置")
    content, media_type = logo
    return Response(
        content=content,
        media_type=media_type,
        headers={"X-Content-Type-Options": "nosniff"},
    )


@router.get("/preferences", response_model=ApiResponse[UserPreferencesResponse])
@handle_errors
async def read_preferences(
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> Any:
    """读取当前用户的界面偏好."""
    return ok(await service.get_preferences(db, user_id))


@router.put("/preferences", response_model=ApiResponse[UserPreferencesResponse])
@handle_errors
async def update_preferences(
    payload: UserPreferencesUpdateRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
) -> Any:
    """更新当前用户的界面偏好（部分更新，未传字段保持不变）."""
    data = await service.update_preferences(
        db, user_id, payload.model_dump(exclude_unset=True)
    )
    return ok(data, message="偏好已保存")


@admin_router.put("/system", response_model=ApiResponse[SystemIdentityResponse])
@handle_errors
async def update_system_identity(
    payload: SystemIdentityUpdateRequest,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(RequirePermission("admin:params")),
) -> Any:
    """更新系统名称（需 admin:params 权限）."""
    data = await service.update_system_name(db, payload.system_name)
    return ok(data, message="系统名称已保存")


@admin_router.post("/system/logo", response_model=ApiResponse[SystemIdentityResponse])
@handle_errors
async def upload_system_logo(
    file: UploadFile,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(RequirePermission("admin:params")),
) -> Any:
    """上传系统 LOGO（需 admin:params 权限）."""
    data = await service.save_logo(db, file)
    return ok(data, message="LOGO 已保存")


@admin_router.delete("/system/logo", response_model=ApiResponse[SystemIdentityResponse])
@handle_errors
async def reset_system_logo(
    db: AsyncSession = Depends(get_db),
    _: str = Depends(RequirePermission("admin:params")),
) -> Any:
    """恢复默认 LOGO（需 admin:params 权限）."""
    data = await service.reset_logo(db)
    return ok(data, message="已恢复默认 LOGO")
