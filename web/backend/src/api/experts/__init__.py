"""专家管理 API 模块。."""
from fastapi import APIRouter

from api.experts.experts_api import router as experts_router
from api.experts.sync_api import router as expert_sync_router

router = APIRouter()
router.include_router(experts_router)
router.include_router(expert_sync_router)

__all__ = ["router"]
