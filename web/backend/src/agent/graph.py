import asyncio
import logging
from typing import Any

from agent.mainagents import create_main_agent
from agent.sandbox.sandbox_manager import SandboxManager

logger = logging.getLogger(__name__)


class GraphManager:
    """管理 Agent Graph 的生命周期，支持配置热重载（改进3）。

    - 首次调用 get_graph() 时懒加载构建。
    - 配置变更后调用 invalidate()，下次 get_graph() 自动重建。
    - 构建过程加锁，防止并发重复构建。
    """

    def __init__(self) -> None:
        self._graph: Any = None
        self._checkpointer: Any = None
        self._store: Any = None
        self._sandbox_manager: SandboxManager | None = None
        self._conn_pool: Any = None
        self._lock = asyncio.Lock()
        self._version: int = 0  # 递增版本号，每次 invalidate +1

    @property
    def version(self) -> int:
        return self._version

    def get_graph(self) -> Any:
        """返回当前 Graph 实例（不触发构建）。"""
        if self._graph is None:
            raise RuntimeError("图未初始化，请先调用 init_graph()")
        return self._graph

    def get_store(self) -> Any:
        """返回已初始化的 LangGraph Store。"""
        if self._store is None:
            raise RuntimeError("Store 未初始化，请先调用 init_graph()")
        return self._store

    def get_checkpointer(self) -> Any:
        if self._checkpointer is None:
            raise RuntimeError("Checkpointer 未初始化")
        return self._checkpointer

    async def init_graph(self) -> None:
        """初始化基础设施（checkpointer / store / sandbox），构建 Graph。"""
        await self._init_infrastructure()
        await self._build_graph()

    async def ensure_built(self) -> Any:
        """确保 Graph 已构建（懒加载入口）。"""
        if self._graph is None:
            async with self._lock:
                if self._graph is None:
                    await self._init_infrastructure()
                    await self._build_graph()
        return self._graph

    async def invalidate(self) -> None:
        """标记 Graph 为过期，下次 get_graph() / ensure_built() 时重建。

        仅标记过期，不立即重建——避免在 API 请求中阻塞。
        """
        self._version += 1
        self._graph = None
        logger.info("Graph 已标记为过期（version=%d），将在下次访问时重建", self._version)

    async def _init_infrastructure(self) -> None:
        """初始化 checkpointer、store、sandbox manager。"""
        from agent.config import settings

        checkpoint_backend = settings.CHECKPOINT_BACKEND

        if checkpoint_backend == "sqlite":
            import aiosqlite
            from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
            from langgraph.store.memory import InMemoryStore

            conn = await aiosqlite.connect(settings.CHECKPOINT_DB_PATH)
            self._checkpointer = AsyncSqliteSaver(conn)
            self._store = InMemoryStore()
        elif checkpoint_backend == "postgres":
            from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
            from langgraph.store.postgres.aio import AsyncPostgresStore
            from psycopg.rows import dict_row
            from psycopg_pool import AsyncConnectionPool

            self._conn_pool = AsyncConnectionPool(
                conninfo=settings.CHECKPOINT_DB_URL,
                open=False,
                kwargs={
                    "autocommit": True,
                    "prepare_threshold": 0,
                    "row_factory": dict_row,
                },
            )
            await self._conn_pool.open()

            self._checkpointer = AsyncPostgresSaver(self._conn_pool)
            await self._checkpointer.setup()

            self._store = AsyncPostgresStore(self._conn_pool)
            await self._store.setup()
        else:
            raise ValueError(
                f"未知的 CHECKPOINT_BACKEND: '{checkpoint_backend}'，支持 'sqlite' 或 'postgres'"
            )

        self._sandbox_manager = SandboxManager(
            extra_domains=settings.sandbox_allowed_domains_list,
        )
        self._sandbox_manager.start_cleanup()

    async def _build_graph(self) -> None:
        """使用 AgentBuilder 构建 Graph。"""
        self._graph = await create_main_agent(
            checkpointer=self._checkpointer,
            store=self._store,
            sandbox_manager=self._sandbox_manager,
        )

    async def shutdown(self) -> None:
        """关闭所有资源。"""
        if self._sandbox_manager is not None:
            self._sandbox_manager.shutdown()
            self._sandbox_manager = None
        if self._conn_pool is not None:
            await self._conn_pool.close()
            self._conn_pool = None

        # 清理 MCP 客户端连接（改进2）
        try:
            from agent.tools.mcp_loader import close_mcp_clients
            await close_mcp_clients()
        except ImportError:
            pass


# 全局单例
_manager = GraphManager()


# ── 兼容旧接口 ────────────────────────────────────────────────────────────

def get_graph():
    """获取已初始化的图。"""
    return _manager.get_graph()


def get_checkpointer():
    """获取已初始化的 Checkpointer。"""
    return _manager.get_checkpointer()


def get_store() -> Any:
    """获取已初始化的 LangGraph Store。"""
    return _manager.get_store()


async def init_graph():
    """初始化 Agent 图（应用启动时调用一次）。"""
    await _manager.init_graph()


async def shutdown_graph():
    """关闭图及相关资源。"""
    await _manager.shutdown()


async def invalidate_graph() -> None:
    """触发 Graph 热重载——标记为过期，下次访问时重建。"""
    await _manager.invalidate()


__all__ = [
    "get_graph",
    "get_checkpointer",
    "get_store",
    "init_graph",
    "shutdown_graph",
    "invalidate_graph",
]
