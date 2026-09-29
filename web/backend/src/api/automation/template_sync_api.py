"""定时模板同步 API 端点（桌面版使用）.

使用 require_scope("template:read") 校验 OAuth2 scope。

与 `template_api.py` 的分工：那边服务 Web 页面（登录 JWT + RBAC 按钮权限把关增删改），
这里只服务桌面端同步，是**只读**接口，用 scope 单独把口子关起来——关掉 template:read
即可让桌面端拿不到模板，而不影响 Web 页面。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from api.automation.template_schemas import AutomationTemplateListResponse
from api.automation.template_service import list_templates
from api.deps import get_db, require_scope
from core.decorators import handle_errors
from core.response import ApiResponse, ok

router = APIRouter(
    prefix="/api/automation-template-sync", tags=["automation-template-sync"]
)


@router.get("/list", response_model=ApiResponse[AutomationTemplateListResponse])
@handle_errors
async def template_sync_list(
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=100),
    keyword: str | None = Query(None),
    category: str | None = Query(None),
    user_id: str = Depends(require_scope("template:read")),
    db: AsyncSession = Depends(get_db),
):
    """分页下发定时模板（供桌面端同步）.

    信封字段与专家/技能同步列表同口径（``items`` / ``total`` / ``page`` / ``page_size``），
    桌面端按 ``total`` 翻页取全量。
    """
    result = await list_templates(
        db, page=page, page_size=page_size, keyword=keyword, category=category
    )
    return ok(result)
