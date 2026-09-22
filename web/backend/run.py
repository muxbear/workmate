"""后端服务启动入口：从配置读取监听地址，启动 uvicorn 运行 FastAPI 应用."""

import asyncio
import ctypes
import os
import sys


def _enable_utf8_console() -> None:
    """把 Windows 控制台与标准流切到 UTF-8（幂等；失败不阻断启动）。

    背景：Windows 控制台默认代码页为 GBK（936），中文日志会显示成乱码，
    极端情况下还会抛 UnicodeEncodeError。这里在导入 uvicorn / 应用之前
    调整控制台代码页并重设 stdio 编码，其它平台直接返回。
    """
    if os.name != 'nt':
        return
    try:
        kernel32 = ctypes.windll.kernel32
        # 65001 = UTF-8：影响控制台读取（输入）与写出（输出）的解码方式
        kernel32.SetConsoleOutputCP(65001)
        kernel32.SetConsoleCP(65001)
    except Exception:
        # 非控制台环境（如 IDE 捕获输出）没有可用句柄，忽略即可
        pass
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, 'reconfigure', None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass


_enable_utf8_console()

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
