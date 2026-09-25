"""数据库迁移命令行（迭代 5 T5.6）。

用法（在 web/backend 下）::

    uv run python scripts/migrate.py --status        # 看哪些已应用、哪些待应用
    uv run python scripts/migrate.py --dry-run       # 在事务里试跑，结束即回滚
    uv run python scripts/migrate.py --apply         # 真正应用
    uv run python scripts/migrate.py --rollback 1    # 回滚最后 1 个

``--dry-run`` 是这类脚本里最该有的功能：PostgreSQL 支持事务性 DDL，因此"在事务里
跑一遍再回滚"就能在**真实数据**上验证迁移能否通过（唯一约束会不会撞重名、外键会不会
撞孤儿行），而不留下任何痕迹。
"""

from __future__ import annotations

import argparse
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


async def main() -> int:
    parser = argparse.ArgumentParser(description="数据库迁移")
    parser.add_argument("--status", action="store_true", help="只显示状态")
    parser.add_argument("--dry-run", action="store_true", help="在事务里试跑后回滚")
    parser.add_argument("--apply", action="store_true", help="应用待执行的迁移")
    parser.add_argument("--rollback", type=int, metavar="N", help="回滚最后 N 个迁移")
    args = parser.parse_args()

    if not any([args.status, args.dry_run, args.apply, args.rollback]):
        args.status = True

    from db.engine import async_engine
    from db.migrate import applied_versions, apply_pending, discover, rollback_last

    migrations = discover()
    if not migrations:
        print("没有找到迁移文件（src/db/migrations/*.sql）")
        return 0

    async with async_engine.connect() as conn:
        done = set(await applied_versions(conn))

    if args.status or args.dry_run:
        print(f"{'版本':8} {'说明':32} {'状态':10} 回滚")
        for migration in migrations:
            state = "已应用" if migration.version in done else "待应用"
            print(
                f"{migration.version:8} {migration.description:32} {state:10} "
                f"{'有' if migration.has_rollback else '无'}",
            )

    if args.dry_run:
        pending = [m.version for m in migrations if m.version not in done]
        if not pending:
            print("\n没有待应用的迁移")
            return 0
        print(f"\n试跑（事务内，结束即回滚）：{pending}")
        try:
            async with async_engine.begin() as conn:
                applied = await apply_pending(conn)
                # 显式回滚：begin() 正常退出会提交，这里必须主动 raise 触发回滚
                raise _DryRunRollback()
        except _DryRunRollback:
            print(f"试跑通过（已回滚，未改动数据库）：{applied}")
            return 0
        except Exception as exc:  # noqa: BLE001 - 把失败原因如实打出来
            print(f"\n试跑失败（数据库未被改动）：{type(exc).__name__}: {exc}", file=sys.stderr)
            return 1

    if args.apply:
        async with async_engine.begin() as conn:
            applied = await apply_pending(conn)
        print(f"已应用 {len(applied)} 个迁移：{applied}" if applied else "没有待应用的迁移")

    if args.rollback:
        try:
            async with async_engine.begin() as conn:
                rolled = await rollback_last(conn, args.rollback)
            print(f"已回滚 {len(rolled)} 个迁移：{rolled}")
        except Exception as exc:  # noqa: BLE001
            print(f"回滚失败：{type(exc).__name__}: {exc}", file=sys.stderr)
            return 1

    return 0


class _DryRunRollback(Exception):
    """仅用于在 dry-run 里主动回滚事务。"""


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    raise SystemExit(asyncio.run(main(), loop_factory=asyncio.SelectorEventLoop))
