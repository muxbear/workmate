"""桌面端模型同步接口."""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_db, require_scope
from api.model_sync.schemas import ModelSyncResponse
from api.model_sync.service import build_model_sync_payload
from core.decorators import handle_errors
from core.response import ApiResponse, ok

router = APIRouter(prefix='/api/model-sync', tags=['model-sync'])


@router.get('/list', response_model=ApiResponse[ModelSyncResponse])
@handle_errors
async def model_sync_list(
    _user_id: str = Depends(require_scope('model:read')),
    db: AsyncSession = Depends(get_db),
):
    """返回模型提供商和模型，字段按桌面端格式."""
    result = await build_model_sync_payload(db)
    return ok(result)
