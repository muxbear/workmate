"""迁移往返演练：在**同一个事务**里 up → down，结束后整体回滚（T5.6）。

为什么需要它：``migrate.py --dry-run`` 只跑 up 路径，只能证明"约束加得上"；它证明不了
**回滚脚本能用**——而"迁移可回滚"正是 T5.6 的验收项之一。此前回滚脚本从未在 PostgreSQL
上执行过（唯一一次演练是在 SQLite 上，因方言差异报语法错，什么都没证明）。

做法：把 up 与 down 放进同一个事务跑完再整体回滚。PostgreSQL 支持事务性 DDL，因此
这次往返对真实 schema 是**零残留**的：演练结束后的库与你演练前完全一致（脚本会在事务
之外用独立连接复查一遍，把这句话变成断言而不是承诺）。

用法（在 web/backend 下）::

    uv run python scripts/verify_migration_roundtrip.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))
sys.path.insert(0, str(BACKEND_DIR / "src"))

import agent.config.config as _cfg  # noqa: E402,F401  触发 load_dotenv

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncConnection  # noqa: E402

#: 知识库这一族表（迁移 0001 的作用域）；两处目录用的列名不同，没法共用一个常量
_TABLE_PATTERN = "knowledge_base%"


class _Rollback(Exception):
    """仅用于强制回滚整个事务（演练不留痕）。"""


async def _snapshot(conn: AsyncConnection) -> dict[str, list[str]]:
    """当前 schema 的一张"清单"：列 / 索引 / 约束 + 几处行数。

    行数一并纳入，是为了证明演练连数据都没碰（DDL 回滚了但数据被改过，同样是失败）。
    """
    columns = (
        await conn.execute(text(
            "SELECT table_name || '.' || column_name FROM information_schema.columns "
            "WHERE table_name LIKE :p ORDER BY 1"
        ), {"p": _TABLE_PATTERN})
    ).scalars().all()
    indexes = (
        await conn.execute(text(
            "SELECT indexname FROM pg_indexes WHERE tablename LIKE :p ORDER BY 1"
        ), {"p": _TABLE_PATTERN})
    ).scalars().all()
    constraints = (
        await conn.execute(text(
            "SELECT c.conname FROM pg_constraint c "
            "JOIN pg_class t ON t.oid = c.conrelid "
            "WHERE t.relname LIKE :p ORDER BY 1"
        ), {"p": _TABLE_PATTERN})
    ).scalars().all()
    counts = (
        await conn.execute(text(
            "SELECT 'knowledge_bases', count(*) FROM knowledge_bases "
            "UNION ALL SELECT 'knowledge_base_documents', count(*) FROM knowledge_base_documents "
            "UNION ALL SELECT 'knowledge_base_entities', count(*) FROM knowledge_base_entities"
        ))
    ).all()
    return {
        "columns": list(columns),
        "indexes": list(indexes),
        "constraints": list(constraints),
        "counts": [f"{name}={n}" for name, n in counts],
    }


def _diff(before: dict[str, list[str]], after: dict[str, list[str]]) -> dict[str, tuple]:
    added, removed = {}, {}
    for key in before:
        added[key] = tuple(x for x in after[key] if x not in before[key])
        removed[key] = tuple(x for x in before[key] if x not in after[key])
    return {"added": added, "removed": removed}


async def main() -> int:
    """执行一次 up → down 往返演练；返回进程退出码（0 = 通过）。"""
    from db.engine import async_engine
    from db.migrate import applied_versions, apply_pending, discover, rollback_last

    migrations = discover()
    if not migrations:
        print("没有找到迁移文件")
        return 0

    async with async_engine.connect() as conn:
        done = set(await applied_versions(conn))
    pending = [m.version for m in migrations if m.version not in done]

    async with async_engine.connect() as conn:
        before = await _snapshot(conn)
    print(f"演练前：{len(before['columns'])} 列 / {len(before['indexes'])} 索引 / "
          f"{len(before['constraints'])} 约束 / {', '.join(before['counts'])}")
    if not pending:
        print("没有待应用的迁移，无需演练")
        return 0
    print(f"待演练迁移：{pending}\n")

    try:
        async with async_engine.begin() as conn:
            print("① 应用（事务内）")
            applied = await apply_pending(conn)
            after_up = await _snapshot(conn)
            delta = _diff(before, after_up)
            for key, items in delta["added"].items():
                for item in items:
                    print(f"     + {key}: {item}")

            print("\n② 回滚（同一事务内）")
            rolled = await rollback_last(conn, len(applied))
            after_down = await _snapshot(conn)
            back = _diff(after_down, before)

            print("\n③ 校验")
            ok = after_down == before
            print(f"  [{'OK   ' if ok else 'FAIL '}] 回滚后 schema 与本迁移前逐项一致")
            if not ok:
                for key, items in back["added"].items():
                    for item in items:
                        print(f"         多出来的 {key}: {item}")
                for key, items in back["removed"].items():
                    for item in items:
                        print(f"         少了的 {key}: {item}")

            if applied != pending or sorted(rolled) != sorted(pending):
                print(f"  [FAIL ] 版本号不符：应用 {applied} / 回滚 {rolled}")
                ok = False
            else:
                print(f"  [OK   ] 版本号一致：应用 {applied} → 回滚 {rolled}")

            raise _Rollback   # 整体回滚：演练不留任何痕迹
    except _Rollback:
        pass

    async with async_engine.connect() as conn:
        after = await _snapshot(conn)
    clean = after == before
    print(f"\n  [{'OK   ' if clean else 'FAIL '}] 事务结束后独立复查：与本演练前一致（零残留）")
    if not clean:
        print(f"        {_diff(before, after)}")

    if not (ok and clean):
        return 1
    print("\n往返演练通过：迁移可应用、可回滚，且不改变真实 schema。")
    return 0


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    raise SystemExit(asyncio.run(main(), loop_factory=asyncio.SelectorEventLoop))
