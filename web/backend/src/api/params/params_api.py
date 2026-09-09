"""System parameter management API endpoints."""

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_db
from api.params import service
from api.params.schemas import (
    ParamCreateRequest,
    ParamReorderRequest,
    ParamResponse,
    ParamUpdateRequest,
)
from api.rbac.deps import RequirePermission
from core.decorators import handle_errors
from core.response import ApiResponse, ok

router = APIRouter(prefix="/api/params", tags=["params"])


@router.get("/parents", response_model=ApiResponse[list[ParamResponse]])
@handle_errors
async def list_parent_params(
    keyword: str | None = None,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(RequirePermission("admin:params")),
) -> Any:
    """List parent parameters (only root level)."""
    data = await service.list_parents(db, keyword)
    return ok(data)


@router.get("/{parent_code}/children", response_model=ApiResponse[list[ParamResponse]])
@handle_errors
async def list_child_params(
    parent_code: str,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(RequirePermission("admin:params")),
) -> Any:
    """List child parameters under the given parent code."""
    data = await service.list_children(db, parent_code)
    return ok(data)


@router.post("", response_model=ApiResponse[ParamResponse])
@handle_errors
async def create_param(
    payload: ParamCreateRequest,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(RequirePermission("admin:params:create")),
) -> Any:
    """Create a parent or child parameter."""
    data = await service.create_param(db, payload)
    return ok(data, message="参数创建成功")


@router.put("/reorder", response_model=ApiResponse[list[ParamResponse]])
@handle_errors
async def reorder_params(
    payload: ParamReorderRequest,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(RequirePermission("admin:params:edit")),
) -> Any:
    """Reorder parent or child parameters."""
    data = await service.reorder_params(db, payload)
    return ok(data, message="排序已保存")


@router.put("/{param_id}", response_model=ApiResponse[ParamResponse])
@handle_errors
async def update_param(
    param_id: str,
    payload: ParamUpdateRequest,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(RequirePermission("admin:params:edit")),
) -> Any:
    """Update an existing parameter."""
    data = await service.update_param(db, param_id, payload)
    return ok(data, message="参数更新成功")


@router.delete("/{param_id}", response_model=ApiResponse[dict[str, int]])
@handle_errors
async def delete_param(
    param_id: str,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(RequirePermission("admin:params:delete")),
) -> Any:
    """Delete a parameter (parent cascades children)."""
    data = await service.delete_param(db, param_id)
    return ok(data, message="参数删除成功")
