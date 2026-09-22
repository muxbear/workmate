"""专家同步 API 端点（桌面版/移动版使用）。.

使用 require_scope("expert:read") 校验 OAuth2 scope。
"""
from typing import Literal

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_db, require_scope
from api.experts.schemas import (
    ExpertInfo,
    ExpertSyncListResponse,
)
from api.experts.service import get_featured, sync_detail, sync_list
from core.decorators import handle_errors
from core.response import ApiResponse, ok

router = APIRouter(prefix="/api/expert-sync", tags=["expert-sync"])


@router.get("/list", response_model=ApiResponse[ExpertSyncListResponse])
@handle_errors
async def expert_sync_list(
    user_id: str = Depends(require_scope("expert:read")),
    db: AsyncSession = Depends(get_db),
    platform: Literal["desktop", "web", "mobile"] = "web",
):
    """获取所有已发布专家的精简数据（供桌面端/移动端同步）。.

    Args:
        user_id: 通过 expert:read scope 校验的用户 ID。
        db: 数据库会话。
        platform: 目标端；用于把专家提示词渲染成该平台可执行的版本。
    """
    result = await sync_list(db, platform=platform)
    return ok(result)


@router.get("/featured", response_model=ApiResponse[dict])
@handle_errors
async def expert_sync_featured(
    user_id: str = Depends(require_scope("expert:read")),
    db: AsyncSession = Depends(get_db),
):
    """获取精选场景 + 精选专家（供桌面端同步）。."""
    result = await get_featured(db)
    return ok(result)


@router.get("/{expert_id}", response_model=ApiResponse[ExpertInfo])
@handle_errors
async def expert_sync_detail(
    expert_id: str,
    user_id: str = Depends(require_scope("expert:read")),
    db: AsyncSession = Depends(get_db),
):
    """获取单个专家的完整配置（供桌面端同步详情）。."""
    result = await sync_detail(db, expert_id)
    return ok(result)
