"""T5.6 迁移前置检查：找出会**阻止约束加上**的既有数据（只读）。

迁移 `0001_knowledge_base_hardening.sql` 声称"无重名库、无孤儿行"，本脚本
用**当前**数据把它验一遍。全部是 SELECT，不改任何数据。

检查项与对应的迁移语句一一对应：
  A. 外键：5 张表的 kb_id 是否有孤儿（指向不存在的 knowledge_bases.id）
  B. 唯一索引 uq_kb_user_name：同一 user_id 下是否有重名（deleted_at 全空，
     故"WHERE deleted_at IS NULL"不影响判定）
  C. 待建索引/约束重名：同名对象已存在但定义不同时，IF NOT EXISTS 会**静默跳过**
  D. 列类型：kb_id 与 knowledge_bases.id 是否同类型（类型不同 FK 建不上）

用法：cd web/backend && uv run python scripts/check_hardening_conflicts.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import psycopg

BACKEND_DIR = Path(__file__).resolve().parent.parent

FK_TABLES = [
    "knowledge_base_documents",
    "knowledge_base_entities",
    "knowledge_base_relations",
    "knowledge_base_shares",
    "knowledge_base_index_tasks",
]

EXPECTED_INDEXES = [
    "ix_knowledge_bases_user_id",
    "ix_knowledge_bases_updated_at",
    "ix_kb_documents_kb_id",
    "ix_kb_documents_status",
    "ix_kb_entities_kb_id",
    "ix_kb_relations_kb_id",
    "ix_knowledge_bases_deleted_at",
    "uq_kb_user_name",
]

EXPECTED_CONSTRAINTS = [
    "fk_kb_documents_kb",
    "fk_kb_entities_kb",
    "fk_kb_relations_kb",
    "fk_kb_shares_kb",
    "fk_kb_tasks_kb",
]


def database_url() -> str:
    """从 .env 读取 DATABASE_URL，转成 psycopg 能用的 DSN。"""
    env_path = BACKEND_DIR / ".env"
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("DATABASE_URL="):
            url = line.split("=", 1)[1].strip().strip('"').strip("'")
            return url.replace("postgresql+psycopg://", "postgresql://")
    raise SystemExit("未找到 DATABASE_URL")


def main() -> int:
    """逐项检查并打印结论；返回进程退出码（非 0 = 有会阻止约束加上的冲突）。"""
    failures: list[str] = []

    def report(title: str, ok: bool, detail: str = "") -> None:
        print(f"  [{'OK   ' if ok else 'BLOCK'}] {title}{(' — ' + detail) if detail else ''}")
        if not ok:
            failures.append(title)

    with psycopg.connect(database_url()) as conn:
        cur = conn.cursor()
        cur.execute("SELECT current_database(), version()")
        db_name, version = cur.fetchone()
        print(f"数据库: {db_name} / {version.split(',')[0]}")
        print("（只读检查，不修改任何数据）\n")

        # ── A. 外键孤儿行 ────────────────────────────────────────────────
        print("A. 外键 kb_id -> knowledge_bases.id 的孤儿行")
        for table in FK_TABLES:
            cur.execute(f"SELECT count(*) FROM {table}")  # noqa: S608
            total = cur.fetchone()[0]
            cur.execute(
                f"""
                SELECT count(*) FROM {table} t
                LEFT JOIN knowledge_bases kb ON kb.id = t.kb_id
                WHERE kb.id IS NULL
                """  # noqa: S608
            )
            orphans = cur.fetchone()[0]
            report(f"{table}: 孤儿 {orphans} 行", orphans == 0, f"总行数 {total}")
            if orphans:
                cur.execute(
                    f"""
                    SELECT t.kb_id, count(*) FROM {table} t
                    LEFT JOIN knowledge_bases kb ON kb.id = t.kb_id
                    WHERE kb.id IS NULL GROUP BY t.kb_id LIMIT 10
                    """  # noqa: S608
                )
                for kb_id, n in cur.fetchall():
                    print(f"        孤儿 kb_id={kb_id} 行数={n}")

        # ── B. 重名库 ────────────────────────────────────────────────────
        print("\nB. 唯一索引 uq_kb_user_name (user_id, name)")
        cur.execute(
            """
            SELECT user_id, name, count(*) AS n, string_agg(id, ', ') AS ids
            FROM knowledge_bases GROUP BY user_id, name HAVING count(*) > 1
            """
        )
        dupes = cur.fetchall()
        report(f"重名库 {len(dupes)} 组", not dupes)
        for user_id, name, n, ids in dupes:
            print(f"        user_id={user_id} name={name!r} x{n}: {ids}")

        cur.execute("SELECT count(*) FROM knowledge_bases WHERE user_id IS NULL")
        null_user = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM knowledge_bases WHERE name IS NULL")
        null_name = cur.fetchone()[0]
        report(
            f"NULL user_id={null_user} / NULL name={null_name}",
            null_user == 0 and null_name == 0,
        )
        cur.execute("SELECT count(*) FROM knowledge_bases")
        print(f"        知识库总数: {cur.fetchone()[0]}")

        # ── C. 同名对象是否已存在（IF NOT EXISTS 会静默跳过） ────────────
        print("\nC. 待建索引/约束是否已存在（同名不同定义会被静默跳过）")
        for name in EXPECTED_INDEXES:
            cur.execute("SELECT indexdef FROM pg_indexes WHERE indexname = %s", (name,))
            row = cur.fetchone()
            if row:
                print(f"        [已存在] {name}: {row[0]}")
        cur.execute(
            """
            SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
            WHERE conname = ANY(%s)
            """,
            (EXPECTED_CONSTRAINTS,),
        )
        for name, definition in cur.fetchall():
            print(f"        [已存在] {name}: {definition}")

        # ── D. 列类型 ────────────────────────────────────────────────────
        print("\nD. kb_id 与 knowledge_bases.id 的列类型")
        cur.execute(
            """
            SELECT table_name, column_name, data_type, character_maximum_length
            FROM information_schema.columns
            WHERE (table_name = ANY(%s) AND column_name = 'kb_id')
               OR (table_name = 'knowledge_bases' AND column_name = 'id')
            ORDER BY table_name
            """,
            (FK_TABLES,),
        )
        types = cur.fetchall()
        for table, column, data_type, length in types:
            print(f"        {table}.{column}: {data_type}({length})")
        kb_id_types = {t[2:] for t in types if t[1] == "kb_id"}
        report(
            "所有 kb_id 与 knowledge_bases.id 同类型",
            len(kb_id_types) == 1,
            str(kb_id_types),
        )

        # ── E. 迁移机制自身 ──────────────────────────────────────────────
        print("\nE. 迁移版本表")
        cur.execute("SELECT to_regclass('public.schema_migrations') IS NOT NULL")
        has_table = cur.fetchone()[0]
        if has_table:
            cur.execute(
                "SELECT version, description, applied_at FROM schema_migrations ORDER BY version"
            )
            for row in cur.fetchall():
                print(f"        {row[0]} {row[1]} @ {row[2]}")
        else:
            print("        schema_migrations 尚不存在（首次执行迁移时创建）")

    print("\n" + "=" * 60)
    if failures:
        print(f"结论：{len(failures)} 项会阻止约束加上，迁移前必须先处理：")
        for item in failures:
            print(f"  - {item}")
        return 1
    print("结论：未发现阻止约束加上的冲突，迁移可在该库执行。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
