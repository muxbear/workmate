"""专家管理 API 端点（Web 前端使用）。."""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user_id, get_db
from api.experts.schemas import (
    ExpertConfigUpdateRequest,
    ExpertCreateRequest,
    ExpertInfo,
    ExpertListResponse,
    ExpertProfileUpdateRequest,
    ExpertUpdateRequest,
)
from api.experts.service import (
    clone_expert,
    create_expert,
    delete_expert,
    get_expert,
    get_featured,
    list_categories,
    list_experts,
    toggle_expert_status,
    update_expert,
    update_expert_config,
    update_expert_profile,
)
from core.decorators import handle_errors
from core.response import ApiResponse, ok

router = APIRouter(prefix="/api/experts", tags=["experts"])


@router.get("", response_model=ApiResponse[ExpertListResponse])
@handle_errors
async def expert_list(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: str | None = Query(None),
    category: str | None = Query(None),
    featured: bool | None = Query(None),
    status: str | None = Query(None),
    sort: str = Query("rating"),
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """分页列出专家，支持搜索、分类筛选、排序。."""
    result = await list_experts(
        db, page=page, page_size=page_size, keyword=keyword,
        category=category, featured=featured, status=status, sort=sort,
    )
    return ok(result)


@router.get("/categories", response_model=ApiResponse[list])
@handle_errors
async def expert_categories(
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """获取所有分类及计数。."""
    result = await list_categories(db)
    return ok(result)


@router.get("/featured", response_model=ApiResponse[dict])
@handle_errors
async def expert_featured(
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """获取精选场景 + 精选专家。."""
    result = await get_featured(db)
    return ok(result)


@router.get("/{expert_id}", response_model=ApiResponse[ExpertInfo])
@handle_errors
async def expert_get(
    expert_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """获取专家详情（含完整配置）。."""
    result = await get_expert(db, expert_id)
    return ok(result)


@router.post("", response_model=ApiResponse[ExpertInfo])
@handle_errors
async def expert_create(
    req: ExpertCreateRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """创建专家。."""
    result = await create_expert(db, req)
    return ok(result)


@router.put("/{expert_id}", response_model=ApiResponse[ExpertInfo])
@handle_errors
async def expert_update(
    expert_id: str,
    req: ExpertUpdateRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """更新专家基础信息。."""
    result = await update_expert(db, expert_id, req)
    return ok(result)


@router.put("/{expert_id}/profile", response_model=ApiResponse[ExpertInfo])
@handle_errors
async def expert_update_profile(
    expert_id: str,
    req: ExpertProfileUpdateRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """更新专家展示元数据。."""
    result = await update_expert_profile(db, expert_id, req)
    return ok(result)


@router.put("/{expert_id}/config", response_model=ApiResponse[ExpertInfo])
@handle_errors
async def expert_update_config(
    expert_id: str,
    req: ExpertConfigUpdateRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """批量更新专家配置（模型 + 提示词 + 工具 + 技能 + MCP）。."""
    result = await update_expert_config(db, expert_id, req)
    return ok(result)


@router.delete("/{expert_id}", response_model=ApiResponse[None])
@handle_errors
async def expert_delete(
    expert_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """删除专家（级联删除 profile + 关联表）。."""
    await delete_expert(db, expert_id)
    return ok(None, "专家已删除")


@router.patch("/{expert_id}/status", response_model=ApiResponse[ExpertInfo])
@handle_errors
async def expert_toggle_status(
    expert_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """切换专家启用/停用状态。."""
    result = await toggle_expert_status(db, expert_id)
    return ok(result)


@router.post("/{expert_id}/clone", response_model=ApiResponse[ExpertInfo])
@handle_errors
async def expert_clone(
    expert_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """克隆专家。."""
    result = await clone_expert(db, expert_id)
    return ok(result)
