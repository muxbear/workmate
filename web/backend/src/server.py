import asyncio
import logging
import sys
from collections import deque
from contextlib import asynccontextmanager
from datetime import UTC, datetime

if sys.platform == "win32":
    # uvicorn 在 Windows 上硬编码了 ProactorEventLoop，绕过了事件循环策略。
    # 通过 monkeypatch 修复以兼容 psycopg。
    import uvicorn.loops.asyncio as _uvicorn_loops

    _uvicorn_loops.asyncio_loop_factory = lambda use_subprocess=False: asyncio.SelectorEventLoop
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse

from core.logging_context import install_request_id_logging

# 日志带上 request_id：一次请求涉及的十几条日志可以串起来看（排查线上问题最常用的
# 手段）。格式保持"人类可读"，不像结构化 JSON——本项目日志主要给人看。
# 注意：本函数内部负责 basicConfig，不要再单独配置日志格式（会互相覆盖）。
install_request_id_logging()

load_dotenv()

from agent.graph import init_graph, shutdown_graph
from agent.tools.mcp_loader import register_local_mcp_server
from api import router
from api.deps import set_cache
from core.cache import create_cache
from core.config import get_settings
from db.engine import init_db
from mcp_servers.image_gen_server import mcp as image_gen_mcp
from mcp_servers.video_gen_server import mcp as video_gen_mcp
from mcp_servers.web_search_server import mcp as web_search_mcp

# 自托管 MCP 服务注册：加载工具时走进程内内存传输，避免启动阶段连接自身端口被拒
register_local_mcp_server('联网搜索', web_search_mcp)
register_local_mcp_server('AI 图像生成', image_gen_mcp)
register_local_mcp_server('AI 视频生成', video_gen_mcp)

streamable_http_subapp = web_search_mcp.streamable_http_app()
image_gen_streamable_http_subapp = image_gen_mcp.streamable_http_app()
video_gen_streamable_http_subapp = video_gen_mcp.streamable_http_app()


async def _init_knowledge_base(app: FastAPI) -> None:
    """初始化知识库子系统——委托给 KnowledgeBaseFacade。"""
    from api.knowledge_base.facade import KnowledgeBaseFacade

    # 知识库的配置来自 core（T5.7 从 agent 配置迁入）
    facade = KnowledgeBaseFacade(get_settings())
    await facade.initialize(app)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 记录服务启动时间（供概览页健康检查使用）
    app.state.started_at = datetime.now(UTC).replace(tzinfo=None)

    # 初始化数据库
    await init_db()

    # 首次启动时种子化内置技能、OAuth2 客户端、内置工具与参数分组
    from api.experts.service import seed_builtin_experts
    from api.mcp.service import seed_builtin_mcp_tools
    from api.oauth2.client_service import seed_oauth2_clients
    from api.params.service import seed_builtin_params
    from api.skill.service import seed_builtin_skills
    from api.tools.service import seed_builtin_tools
    from db.engine import async_session

    async with async_session() as session:
        await seed_oauth2_clients(session)
        await seed_builtin_skills(session)
        await seed_builtin_tools(session)
        await seed_builtin_mcp_tools(session)
        await seed_builtin_experts(session)
        await seed_builtin_params(session)
        await session.commit()

    # 迁移明文 api_key 为加密存储
    from api.providers.service import migrate_plaintext_api_keys
    async with async_session() as session:
        await migrate_plaintext_api_keys(session)
        await session.commit()

    await init_graph()

    from api.automation.scheduler import automation_scheduler

    await automation_scheduler.start()

    from api.agent.artifacts_maintenance import artifact_maintenance

    await artifact_maintenance.start()
    
    cache = await create_cache()
    set_cache(cache)

    from core.security import _get_jwt_secret as init_jwt
    init_jwt()

    # Initialize notification bus
    from api.notification.service import init_notification_bus
    init_notification_bus()

    # 初始化知识库子系统
    await _init_knowledge_base(app)

    # 恢复上次进程遗留的索引任务：队列此前只在内存里，重启会让进行中的文档
    # 永久卡在中间态且不可重试（2026-09-24 前）。
    scheduler = getattr(app.state, "scheduler", None)
    if scheduler is not None:
        try:
            recovered = await scheduler.recover_pending()
            if recovered:
                logging.getLogger(__name__).info("已恢复 %d 个索引任务", recovered)
        except Exception:
            logging.getLogger(__name__).exception("索引任务恢复失败（不影响服务启动）")

    try:
        async with web_search_mcp.session_manager.run():
            async with image_gen_mcp.session_manager.run():
                async with video_gen_mcp.session_manager.run():
                    yield
    finally:
        # 收尾必须放在 finally：任一 session_manager 抛异常时，此前这些 stop()
        # 会被整体跳过，留下未收尾的任务行与后台循环。
        if scheduler is not None:
            # 先停调度器：取消运行中任务并退回 queued，等下次启动继续
            try:
                await scheduler.shutdown()
            except Exception:
                logging.getLogger(__name__).exception("索引调度器停止失败")
        await artifact_maintenance.stop()
        await automation_scheduler.stop()
        # embedding 客户端是全实例复用的长连接（见 core.rag.embedding），显式关闭；
        # 尽力而为：它没关成功也不该拦住关停流程
        _embedding = getattr(app.state, "embedding_model", None)
        _aclose = getattr(_embedding, "aclose", None)
        if _aclose is not None:
            try:
                await _aclose()
            except Exception:
                logging.getLogger(__name__).exception("embedding 客户端关闭失败")
        await shutdown_graph()


app = FastAPI(
    title="ke-hermes",
    description="通用智能体服务",
    lifespan=lifespan,
)

# API 响应时间滑动窗口（供概览页系统健康监控使用）
app.state.response_times = deque(maxlen=100)


@app.middleware("http")
async def request_context_middleware(request: Request, call_next):
    """给每个请求分配 request_id，记录耗时，并在响应头回带 id。

    request_id 进 ContextVar 后，本次请求打出的所有日志都会带上它——出问题时
    ``grep <id>`` 就能捞出完整链路。客户端已带 ``X-Request-Id`` 时沿用它，
    便于与网关/前端串联。
    """
    import time as _time

    from core.logging_context import (
        REQUEST_ID_HEADER,
        new_request_id,
        request_id_var,
    )

    incoming = request.headers.get(REQUEST_ID_HEADER, "").strip()
    request_id = incoming[:64] or new_request_id()
    token = request_id_var.set(request_id)
    start = _time.time()
    try:
        response = await call_next(request)
    finally:
        # 必须在 finally 里复位：异常请求也要把上下文还原，否则 id 会"泄漏"到
        # 复用该协程的后续请求上，日志就串了
        request_id_var.reset(token)

    response.headers[REQUEST_ID_HEADER] = request_id
    if request.url.path.startswith("/api/"):
        app.state.response_times.append((_time.time() - start) * 1000)
    return response


@app.get("/metrics", include_in_schema=False)
async def metrics_endpoint() -> PlainTextResponse:
    """Prometheus 文本格式指标（见 ``core/metrics.py``）。"""
    from core.metrics import render_prometheus

    return PlainTextResponse(
        render_prometheus(),
        media_type="text/plain; version=0.0.4; charset=utf-8",
    )


# CORS：来源白名单来自 CORS_ORIGINS（逗号分隔）。未配置时退化为通配 + 关闭凭据——
# 浏览器规范不允许 `Access-Control-Allow-Origin: *` 与 credentials 同时生效，
# 此前的 `["*"] + allow_credentials=True` 是个不会报错、但带凭据的跨域请求必然
# 失败的组合；而 `CORS_ORIGINS` 配置项此前从未被读取。
_cors_origins = get_settings().cors_origins_list
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins or ["*"],
    allow_credentials=bool(_cors_origins),
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)
app.mount('/mcp/web-search', web_search_mcp.sse_app())
app.mount('/mcp/web-search-http', streamable_http_subapp)
app.mount('/mcp/image-gen', image_gen_mcp.sse_app())
app.mount('/mcp/image-gen-http', image_gen_streamable_http_subapp)
app.mount('/mcp/video-gen', video_gen_mcp.sse_app())
app.mount('/mcp/video-gen-http', video_gen_streamable_http_subapp)
