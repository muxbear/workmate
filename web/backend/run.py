"""后端服务启动入口：从配置读取监听地址，启动 uvicorn 运行 FastAPI 应用."""

import asyncio
import sys

if sys.platform == "win32":
    import uvicorn.loops.asyncio as _uvicorn_loops

    _uvicorn_loops.asyncio_loop_factory = lambda use_subprocess=False: (
        asyncio.SelectorEventLoop
    )
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

import uvicorn

from core.config import get_settings

if __name__ == "__main__":
    settings = get_settings()
    # 仅开发环境且非 Windows 时开启热重载（Windows 下 uvicorn reload 与事件循环不兼容）
    uvicorn.run(
        "src.server:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=settings.APP_ENV == "dev" and sys.platform != "win32",
    )
