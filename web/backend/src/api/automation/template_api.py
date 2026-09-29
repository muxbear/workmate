"""定时任务模板 API 端点.

挂在 `/api/automation/templates` 下，与任务接口同属自动化模块（共用排期类型与摘要逻辑）。
读接口只要求登录，写接口由 RBAC 按钮权限把关——模板是全局共享资源，
「管理员维护、普通用户使用」。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from api.automation.template_schemas import (
    AutomationTemplateDraft,
    AutomationTemplateListResponse,
    AutomationTemplateResponse,
)
from api.automation.template_service import (
    create_template,
    delete_template,
    get_template,
    list_template_types,
    list_templates,
    update_template,
)
from api.deps import get_current_user_id, get_db
from api.rbac.deps import RequirePermission
from core.decorators import handle_errors
from core.response import ApiResponse, ok

router = APIRouter(prefix="/api/automation", tags=["automation"])


@router.get(
    "/template-types", response_model=ApiResponse[list[dict[str, str]]]
)
@handle_errors
async def template_type_options(
    db: AsyncSession = Depends(get_db),
    _: str = Depends(get_current_user_id),
):
    """获取可选的模板类型（供「定时模板」页面的筛选与表单下拉使用）。

    取值来自「参数配置」页面的 `schedule_template_type` 分组。这里只要求登录，
    不要求 `admin:params`——模板页面本身对所有登录用户开放，若沿用参数配置的
    权限，非管理员会拿到空下拉。管理员改配置、普通用户读结果。
    """
    return ok(await list_template_types(db))


@router.get(
    "/templates", response_model=ApiResponse[AutomationTemplateListResponse]
)
@handle_errors
async def template_list(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: str | None = Query(None),
    category: str | None = Query(None),
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """分页列出定时任务模板，支持搜索与类型筛选。."""
    result = await list_templates(
        db, page=page, page_size=page_size, keyword=keyword, category=category
    )
    return ok(result)


@router.get(
    "/templates/{template_id}", response_model=ApiResponse[AutomationTemplateResponse]
)
@handle_errors
async def template_detail(
    template_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """获取单个定时任务模板。."""
    return ok(await get_template(db, template_id))


@router.post(
    "/templates", response_model=ApiResponse[AutomationTemplateResponse]
)
@handle_errors
async def template_create(
    payload: AutomationTemplateDraft,
    user_id: str = Depends(RequirePermission("control:template:create")),
    db: AsyncSession = Depends(get_db),
):
    """新建定时任务模板（未指定版本号时从 1.0.0 起步）。."""
    return ok(await create_template(db, payload, user_id))


@router.put(
    "/templates/{template_id}", response_model=ApiResponse[AutomationTemplateResponse]
)
@handle_errors
async def template_update(
    template_id: str,
    payload: AutomationTemplateDraft,
    _: str = Depends(RequirePermission("control:template:edit")),
    db: AsyncSession = Depends(get_db),
):
    """更新定时任务模板（未指定版本号时默认递增次版本）。."""
    return ok(await update_template(db, template_id, payload))


@router.delete("/templates/{template_id}", response_model=ApiResponse[dict[str, str]])
@handle_errors
async def template_delete(
    template_id: str,
    _: str = Depends(RequirePermission("control:template:delete")),
    db: AsyncSession = Depends(get_db),
):
    """删除定时任务模板（软删除）。."""
    await delete_template(db, template_id)
    return ok({"id": template_id})
