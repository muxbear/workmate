import asyncio
import logging
import sys
from contextlib import asynccontextmanager

if sys.platform == "win32":
    # uvicorn 在 Windows 上硬编码了 ProactorEventLoop，绕过了事件循环策略。
    # 通过 monkeypatch 修复以兼容 psycopg。
    import uvicorn.loops.asyncio as _uvicorn_loops

    _uvicorn_loops.asyncio_loop_factory = lambda use_subprocess=False: asyncio.SelectorEventLoop
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(level=logging.INFO, format="%(name)s: %(message)s")

load_dotenv()

from agent.graph import init_graph, shutdown_graph
from agent.tools.mcp_loader import register_local_mcp_server
from api import router
from api.deps import set_cache
from core.cache import create_cache
from db.engine import init_db
from mcp_servers.image_gen_server import mcp as image_gen_mcp
from mcp_servers.web_search_server import mcp as web_search_mcp

# 自托管 MCP 服务注册：加载工具时走进程内内存传输，避免启动阶段连接自身端口被拒
register_local_mcp_server('联网搜索', web_search_mcp)
register_local_mcp_server('AI 图像生成', image_gen_mcp)

streamable_http_subapp = web_search_mcp.streamable_http_app()
image_gen_streamable_http_subapp = image_gen_mcp.streamable_http_app()


async def _init_knowledge_base(app: FastAPI) -> None:
    """初始化知识库子系统——委托给 KnowledgeBaseFacade。"""
    from agent.config import settings
    from api.knowledge_base.facade import KnowledgeBaseFacade

    facade = KnowledgeBaseFacade(settings)
    await facade.initialize(app)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 初始化数据库
    await init_db()

    # 首次启动时种子化内置技能、OAuth2 客户端和内置工具
    from api.experts.service import seed_builtin_experts
    from api.mcp.service import seed_builtin_mcp_tools
    from api.oauth2.client_service import seed_oauth2_clients
    from api.skill.service import seed_builtin_skills
    from api.tools.service import seed_builtin_tools
    from db.engine import async_session

    async with async_session() as session:
        await seed_oauth2_clients(session)
        await seed_builtin_skills(session)
        await seed_builtin_tools(session)
        await seed_builtin_mcp_tools(session)
        await seed_builtin_experts(session)
        await session.commit()

    # 迁移明文 api_key 为加密存储
    from api.providers.service import migrate_plaintext_api_keys
    async with async_session() as session:
        await migrate_plaintext_api_keys(session)
        await session.commit()

    await init_graph()
    
    cache = await create_cache()
    set_cache(cache)

    from core.security import _get_jwt_secret as init_jwt
    init_jwt()

    # 初始化知识库子系统
    await _init_knowledge_base(app)

    async with web_search_mcp.session_manager.run():
        async with image_gen_mcp.session_manager.run():
            yield
    await shutdown_graph()


app = FastAPI(
    title="ke-hermes",
    description="通用智能体服务",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)
app.mount('/mcp/web-search', web_search_mcp.sse_app())
app.mount('/mcp/web-search-http', streamable_http_subapp)
app.mount('/mcp/image-gen', image_gen_mcp.sse_app())
app.mount('/mcp/image-gen-http', image_gen_streamable_http_subapp)
