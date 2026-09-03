import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from agent.config import settings

logger = logging.getLogger(__name__)

async_engine: AsyncEngine | None = None

if settings.DATABASE_BACKEND == "sqlite":
    async_engine = create_async_engine(settings.DATABASE_URL, echo=False)
elif settings.DATABASE_BACKEND == "postgres":
    async_engine = create_async_engine(
        settings.DATABASE_URL, echo=False, pool_pre_ping=True, pool_size=5, max_overflow=10
    )
else:
    raise Exception("DATABASE_BACKEND must be sqlite or postgres.")


async_session = async_sessionmaker[AsyncSession](async_engine, expire_on_commit=False)


async def get_db():
    async with async_session() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def _get_existing_columns(conn, table_name: str) -> set[str]:
    """获取表的现有列名（兼容 SQLite 和 PostgreSQL）。"""
    if settings.DATABASE_BACKEND == "sqlite":
        result = await conn.execute(text(f"PRAGMA table_info({table_name})"))
        rows = result.fetchall()
        return {row[1] for row in rows}
    else:
        result = await conn.execute(
            text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = :tbl"
            ),
            {"tbl": table_name},
        )
        rows = result.fetchall()
        return {row[0] for row in rows}


async def _table_exists(conn, table_name: str) -> bool:
    """Check if a table exists (SQLite / PostgreSQL compatible)."""
    if settings.DATABASE_BACKEND == "sqlite":
        result = await conn.execute(
            text("SELECT name FROM sqlite_master WHERE type='table' AND name=:name"),
            {"name": table_name},
        )
        return result.scalar() is not None
    else:
        result = await conn.execute(
            text(
                "SELECT EXISTS (SELECT 1 FROM information_schema.tables "
                "WHERE table_name = :name)"
            ),
            {"name": table_name},
        )
        return result.scalar()


async def init_db():
    from db.base import Base
    from db.models.agent_version import (
        AgentVersion,  # noqa: F401  ensure table is registered
    )
    from db.models.cron_job import CronJob  # noqa: F401  ensure table is registered
    from db.models.data_scope import DataScope  # noqa: F401
    from db.models.oauth2_client import OAuth2Client  # noqa: F401
    from db.models.oauth2_refresh_token import OAuth2RefreshToken  # noqa: F401
    from db.models.permission_resource import PermissionResource  # noqa: F401
    from db.models.role import Role  # noqa: F401
    from db.models.role_permission import RolePermission  # noqa: F401
    from db.models.user_role import UserRole  # noqa: F401

    # 断言 async_engine 不为 None，类型检查器会据此收窄类型
    assert async_engine is not None, "数据库引擎没有被初始化"

    logger.info("初始化数据库...")
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

        # 迁移：为现有 conversations 表添加 attachment_ids 列
        # Migration: add parent_id to agents table
        if await _table_exists(conn, 'agents'):
            existing = await _get_existing_columns(conn, 'agents')
            if 'parent_id' not in existing:
                logger.info('Adding parent_id column to agents table')
                await conn.execute(text('ALTER TABLE agents ADD COLUMN parent_id VARCHAR(36)'))
            await conn.execute(text('CREATE INDEX IF NOT EXISTS ix_agents_parent_id ON agents (parent_id)'))
        if await _table_exists(conn, "conversations"):
            existing = await _get_existing_columns(conn, "conversations")
            if "attachment_ids" not in existing:
                logger.info("Adding attachment_ids column to conversations table")
                col_type = "JSON" if settings.DATABASE_BACKEND == "sqlite" else "JSONB"
                await conn.execute(text(f"ALTER TABLE conversations ADD COLUMN attachment_ids {col_type}"))

        # 迁移（改进1）：为 tools 表添加 implementation / tool_type 列
        # Migration: add parent_id to agents table
        if await _table_exists(conn, 'agents'):
            existing = await _get_existing_columns(conn, 'agents')
            if 'parent_id' not in existing:
                logger.info('Adding parent_id column to agents table')
                await conn.execute(text('ALTER TABLE agents ADD COLUMN parent_id VARCHAR(36)'))
            await conn.execute(text('CREATE INDEX IF NOT EXISTS ix_agents_parent_id ON agents (parent_id)'))
        if await _table_exists(conn, "tools"):
            existing = await _get_existing_columns(conn, "tools")
            if "implementation" not in existing:
                logger.info("Adding implementation column to tools table")
                await conn.execute(text("ALTER TABLE tools ADD COLUMN implementation VARCHAR(256)"))
            if "tool_type" not in existing:
                logger.info("Adding tool_type column to tools table")
                await conn.execute(text("ALTER TABLE tools ADD COLUMN tool_type VARCHAR(32) DEFAULT 'function'"))
        if await _table_exists(conn, "providers"):
            existing = await _get_existing_columns(conn, "providers")
            if "response_url" not in existing:
                logger.info("Adding response_url column to providers table")
                await conn.execute(text("ALTER TABLE providers ADD COLUMN response_url VARCHAR(512) DEFAULT ''"))
            if "anthropic_url" not in existing:
                logger.info("Adding anthropic_url column to providers table")
                await conn.execute(text("ALTER TABLE providers ADD COLUMN anthropic_url VARCHAR(512) DEFAULT ''"))
            if "sort_order" not in existing:
                logger.info("Adding sort_order column to providers table")
                await conn.execute(text("ALTER TABLE providers ADD COLUMN sort_order INTEGER DEFAULT 0"))
                await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_providers_sort_order ON providers (sort_order)"))

        if await _table_exists(conn, 'ai_models'):
            existing = await _get_existing_columns(conn, 'ai_models')
            if "sort_order" not in existing:
                logger.info("Adding sort_order column to ai_models table")
                await conn.execute(text("ALTER TABLE ai_models ADD COLUMN sort_order INTEGER DEFAULT 0"))
                await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_ai_models_sort_order ON ai_models (sort_order)"))

        if await _table_exists(conn, 'mcp_tools'):
            existing = await _get_existing_columns(conn, 'mcp_tools')
            if 'transport' not in existing:
                logger.info('Adding transport column to mcp_tools table')
                await conn.execute(text("ALTER TABLE mcp_tools ADD COLUMN transport VARCHAR(32) DEFAULT 'stdio'"))
            if 'url' not in existing:
                logger.info('Adding url column to mcp_tools table')
                await conn.execute(text("ALTER TABLE mcp_tools ADD COLUMN url VARCHAR(512) DEFAULT ''"))
            if 'sse_url' not in existing:
                logger.info('Adding sse_url column to mcp_tools table')
                await conn.execute(text("ALTER TABLE mcp_tools ADD COLUMN sse_url VARCHAR(512) DEFAULT ''"))
            if 'streamable_http_url' not in existing:
                logger.info('Adding streamable_http_url column to mcp_tools table')
                await conn.execute(text("ALTER TABLE mcp_tools ADD COLUMN streamable_http_url VARCHAR(512) DEFAULT ''"))
            if 'command' not in existing:
                logger.info('Adding command column to mcp_tools table')
                await conn.execute(text("ALTER TABLE mcp_tools ADD COLUMN command VARCHAR(256) DEFAULT ''"))
            if 'args' not in existing:
                logger.info('Adding args column to mcp_tools table')
                if settings.DATABASE_BACKEND == 'sqlite':
                    await conn.execute(text("ALTER TABLE mcp_tools ADD COLUMN args JSON DEFAULT '[]'"))
                else:
                    await conn.execute(text("ALTER TABLE mcp_tools ADD COLUMN args JSONB DEFAULT '[]'::jsonb"))
            if 'env' not in existing:
                logger.info('Adding env column to mcp_tools table')
                if settings.DATABASE_BACKEND == 'sqlite':
                    await conn.execute(text("ALTER TABLE mcp_tools ADD COLUMN env JSON DEFAULT '{}'"))
                else:
                    await conn.execute(text("ALTER TABLE mcp_tools ADD COLUMN env JSONB DEFAULT '{}'::jsonb"))
            await conn.execute(text("UPDATE mcp_tools SET transport='sse', url='http://127.0.0.1:8001/mcp/web-search/sse', sse_url='http://127.0.0.1:8001/mcp/web-search/sse', streamable_http_url='http://127.0.0.1:8001/mcp/web-search-http/mcp' WHERE name='联网搜索' AND (sse_url IS NULL OR sse_url='')"))
            await conn.execute(text("UPDATE mcp_tools SET transport='streamable_http', url='http://127.0.0.1:8001/mcp/image-gen/sse', sse_url='http://127.0.0.1:8001/mcp/image-gen/sse', streamable_http_url='http://127.0.0.1:8001/mcp/image-gen-http/mcp' WHERE name='AI 图像生成' AND (streamable_http_url IS NULL OR streamable_http_url='')"))


    # Seed built-in RBAC data
    from api.rbac.service import RbacService

    async with async_session() as session:
        svc = RbacService(session)
        await svc.seed_builtin_data()
        await session.commit()

    logger.info("数据库表已创建")
