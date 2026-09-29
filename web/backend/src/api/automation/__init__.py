"""自动化模块（定时任务 + 定时任务模板）."""

from api.automation.automation_api import router
from api.automation.template_api import router as template_router
from api.automation.template_sync_api import router as template_sync_router

__all__ = ["router", "template_router", "template_sync_router"]
