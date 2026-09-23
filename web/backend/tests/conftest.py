import asyncio
import sys

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from dotenv import load_dotenv

load_dotenv()

import pytest
from httpx import ASGITransport, AsyncClient

from server import app


@pytest.fixture(scope="session")
def anyio_backend():
    return "asyncio"


# 作用域必须是 package（而不是 function）：
# lifespan 里的 MCP StreamableHTTPSessionManager 是**一次性**的——SDK 明确要求
# 「需要重启就新建实例」，同一实例第二次 run() 会抛
# "StreamableHTTPSessionManager .run() can only be called once per instance"。
# 而这些 manager 在 server.py 导入时就被 StreamableHTTPASGIApp 捕获并挂载到了路由上，
# 无法在不重建挂载的情况下换新实例，所以 lifespan 在一个进程里只能进一次。
#
# 也不要放大到 session：那会让整个 app（自动化调度、产物维护循环、沙箱清理线程、
# MCP manager）在跑 unit_tests 时仍然活着，实测会导致后续用例挂起。
# package 作用域让 app 只覆盖 tests/integration_tests/，离开该包即释放。
# 若将来在别的包里也要用 client，需要另行处理 manager 的一次性限制。
@pytest.fixture(scope="package")
async def client():
    transport = ASGITransport(app=app)
    async with app.router.lifespan_context(app):  # triggers init_db + init_graph
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c