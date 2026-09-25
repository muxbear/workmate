"""轻量版本化迁移——SQL 文件 + 版本表（迭代 5 T5.6）。

**为什么不是 Alembic**：本项目此前没有迁移机制（``init_db`` 里是"启动时逐条 ALTER、
列已存在就跳过"），schema 全部由 ``create_all`` + 幂等 ALTER 维护。引入 Alembic 需要
为**现有库**补一份完整的基线 revision 并接管全部历史——那本身就是一个独立项目，且
中途出错会影响所有环境的启动。这里用"编号 SQL 文件 + ``schema_migrations`` 版本表"
承接**从今天起的结构性变更**（索引、约束、软删除列），轻、可回滚、可读。

与既有 ``init_db`` 的分工（避免两套机制漂移）：

- **结构性变更**（索引、约束、外键、软删除列…）→ 写进 ``migrations/*.sql``；
- ``init_db`` 里那些"加列就跳过"的增量迁移保留为**历史兼容**（各环境早已执行过），
  新列不要再往那里加。

命名与执行规则：

- 文件名形如 ``0003_add_indexes.py`` / ``0003_add_indexes.down.sql``，**按编号升序**执行；
- 每个迁移**在独立事务里**执行（PostgreSQL 支持事务性 DDL，失败即整体回滚）；
- 已执行的版本记入 ``schema_migrations``，重复执行不重复应用；
- 回滚按编号**降序**，只回滚最后 N 个（避免跳着回滚留下中间态）。
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

logger = logging.getLogger(__name__)

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"

#: 版本文件名：NNNN_description.down.sql 是回滚脚本，不算独立版本
_UP_PATTERN = re.compile(r"^(\d{4})_([a-z0-9_]+)\.sql$")

_SCHEMA_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     VARCHAR(16) PRIMARY KEY,
    description VARCHAR(128) NOT NULL,
    applied_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
)
"""


@dataclass(frozen=True)
class Migration:
    """一个迁移版本（含可选的回滚脚本）。"""

    version: str
    description: str
    up_path: Path
    down_path: Path | None

    @property
    def has_rollback(self) -> bool:
        return self.down_path is not None


def discover(directory: Path | None = None) -> list[Migration]:
    """扫描迁移目录，按版本号升序返回（每个版本带上它的回滚脚本，如果有）。

    **两遍扫描**：``.down.sql`` 按字典序排在主文件**之前**（``down`` < ``sql``），
    一遍扫描时先遇到回滚脚本、主版本还没登记，回滚脚本就被丢掉了——"有回滚脚本
    却报没有"这种错会让人以为文件没写对。
    """
    base = directory or MIGRATIONS_DIR
    if not base.exists():
        return []

    ups: dict[str, Migration] = {}
    downs: dict[str, Path] = {}
    for path in sorted(base.glob("*.sql")):
        match = _UP_PATTERN.match(path.name)
        if match:
            ups[match.group(1)] = Migration(
                version=match.group(1), description=match.group(2),
                up_path=path, down_path=None,
            )
            continue
        down = re.match(r"^(\d{4})_[a-z0-9_]+\.down\.sql$", path.name)
        if down:
            downs[down.group(1)] = path

    return [
        Migration(
            version=version,
            description=migration.description,
            up_path=migration.up_path,
            down_path=downs.get(version),
        )
        for version, migration in sorted(ups.items())
    ]


async def ensure_schema_table(conn: AsyncConnection) -> None:
    """创建版本表（不存在时）。"""
    await conn.execute(text(_SCHEMA_TABLE_DDL))


async def applied_versions(conn: AsyncConnection) -> list[str]:
    """已应用的版本号（升序）。"""
    await ensure_schema_table(conn)
    rows = await conn.execute(
        text("SELECT version FROM schema_migrations ORDER BY version")
    )
    return [row[0] for row in rows]


async def apply_pending(conn: AsyncConnection, directory: Path | None = None) -> list[str]:
    """应用所有未执行的迁移，返回本次应用的版本号列表。

    每个迁移在**独立事务**里执行：PostgreSQL 支持事务性 DDL，因此迁移失败不会留下
    半应用状态（索引建了一半、约束没加上）。调用方负责提供连接。
    """
    await ensure_schema_table(conn)
    done = set(await applied_versions(conn))
    applied: list[str] = []

    for migration in discover(directory):
        if migration.version in done:
            continue
        sql = migration.up_path.read_text(encoding="utf-8")
        # 单条语句逐条执行：多语句一次性发给驱动时，失败后难以定位到具体哪一条
        for statement in _split_statements(sql):
            await conn.execute(text(statement))
        await conn.execute(
            text(
                "INSERT INTO schema_migrations (version, description) "
                "VALUES (:v, :d)"
            ),
            {"v": migration.version, "d": migration.description},
        )
        applied.append(migration.version)
        logger.info("迁移已应用: %s_%s", migration.version, migration.description)

    return applied


async def rollback_last(
    conn: AsyncConnection, steps: int = 1, directory: Path | None = None,
) -> list[str]:
    """回滚最后 N 个迁移（按编号降序），返回被回滚的版本号列表。

    只允许"从末尾往回滚"：跳着回滚会留下中间态（例如先滚了建索引的、没滚加列的），
    后续迁移的假设就不再成立。

    ``directory`` 必须与 :func:`apply_pending` 用同一个：版本号是**在哪个目录里
    找到的定义**决定执行哪份回滚 SQL。此前这里写死默认目录，于是"回滚临时目录里
    应用的 0001"会去取仓库里真实 0001 的 down 脚本——回滚错迁移比不回滚更危险。

    Raises:
        RuntimeError: 目标版本没有回滚脚本。
    """
    await ensure_schema_table(conn)
    done = await applied_versions(conn)
    by_version = {m.version: m for m in discover(directory)}
    rolled: list[str] = []

    for version in reversed(done[-steps:] if steps > 0 else []):
        migration = by_version.get(version)
        if migration is None:
            raise RuntimeError(f"找不到迁移 {version} 的定义（文件被删了？）")
        if not migration.has_rollback:
            raise RuntimeError(
                f"迁移 {version} 没有回滚脚本（缺少 {version}_*.down.sql）",
            )
        sql = migration.down_path.read_text(encoding="utf-8")  # type: ignore[union-attr]
        for statement in _split_statements(sql):
            await conn.execute(text(statement))
        await conn.execute(
            text("DELETE FROM schema_migrations WHERE version = :v"), {"v": version},
        )
        rolled.append(version)
        logger.info("迁移已回滚: %s", version)

    return rolled


def _split_statements(sql: str) -> list[str]:
    """按分号切分 SQL，忽略空语句与纯注释行。

    迁移文件由我们维护（不含存储过程/字符串里的分号），因此简单的切分足够；
    这里不做通用 SQL 解析。
    """
    cleaned_lines = [
        line for line in sql.splitlines()
        if line.strip() and not line.strip().startswith("--")
    ]
    raw = "\n".join(cleaned_lines)
    return [chunk.strip() for chunk in raw.split(";") if chunk.strip()]


__all__ = [
    "MIGRATIONS_DIR",
    "Migration",
    "applied_versions",
    "apply_pending",
    "discover",
    "ensure_schema_table",
    "rollback_last",
]
