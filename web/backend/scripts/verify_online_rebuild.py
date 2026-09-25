"""在线重建验证：重建**全程**旧数据可检索（迭代 4 T4.5）。

这是"原子重建"唯一有说服力的验证方式：一边跑整库重建，一边持续检索，把每次
检索的命中数记下来。修复前的时间线中间会有一段 0 命中（库被清空、还没索引完），
修复后应当**任何时刻都有完整结果**——要么全是旧数据，要么全是新数据。

用法（在 web/backend 下）::

    uv run python scripts/verify_online_rebuild.py --kb 5a28d123
    uv run python scripts/verify_online_rebuild.py --kb 5a28d123 --yes   # 真跑重建

不带 ``--yes`` 时只做只读探测（当前是否已提交、检索是否正常）。
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))
sys.path.insert(0, str(BACKEND_DIR / "src"))

import agent.config.config as _cfg  # noqa: E402,F401  触发 load_dotenv

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

QUERY = "MySQL 主从复制怎么配置"


async def _count_chunks(store, kb_id: str) -> int:
    """正式集合里的切片总数（用全量语料接口数，避免依赖 doc_id）。"""
    corpus = await store._fetch_corpus(kb_id)  # type: ignore[attr-defined]
    return len(corpus)


async def main() -> int:
    parser = argparse.ArgumentParser(description="在线重建验证")
    parser.add_argument("--kb", required=True, help="知识库 id 前缀")
    parser.add_argument("--yes", action="store_true", help="执行重建（会调 embedding API）")
    parser.add_argument("--interval", type=float, default=3.0, help="探测间隔（秒）")
    parser.add_argument("--timeout", type=float, default=2400.0)
    args = parser.parse_args()

    from sqlalchemy import select, text

    from core.config import get_settings
    from db.engine import async_session
    from db.models.knowledge_base import KnowledgeBase

    # build_stack / build_vector_store 读的是向量库配置，那套配置在 core
    # （T5.7 从 agent 配置迁入）
    settings = get_settings()

    async with async_session() as db:
        kb = (await db.execute(
            select(KnowledgeBase).where(KnowledgeBase.id.startswith(args.kb))
        )).scalars().first()
        if kb is None:
            print(f"未找到知识库：{args.kb}", file=sys.stderr)
            return 2
        kb_id, owner_id, kb_name = kb.id, kb.user_id, kb.name

    if not args.yes:
        from scripts.rebuild_kb_native_bm25 import build_vector_store

        store = build_vector_store(settings)
        has_staging = await store.has_staged_collection(kb_id)
        total = await _count_chunks(store, kb_id)
        hits = len(await store.bm25_search(kb_id, QUERY, top_k=5))
        print(f"《{kb_name}》")
        print(f"  正式集合切片数: {total}")
        print(f"  检索命中数: {hits}")
        print(f"  存在待提交的临时集合: {has_staging}")
        if has_staging and total == 0:
            print("  ⚠ 正式集合为空但存在临时集合——说明上次重建中断，可重跑以完成提交")
        print("\n加 --yes 执行在线重建验证")
        return 0

    from scripts.rebuild_kb_native_bm25 import build_stack, wait_for_drain

    store, scheduler = await build_stack(settings)

    # 记录一条文档，用于重建后按文档核对
    async with async_session() as db:
        doc_id = (await db.execute(text(
            "SELECT id FROM knowledge_base_documents WHERE kb_id = :k ORDER BY name LIMIT 1"
        ), {"k": kb_id})).scalar()

    before_total = await _count_chunks(store, kb_id)
    print(f"《{kb_name}》重建前：正式集合 {before_total} 片")

    from api.knowledge_base.service import reindex_kb

    async with async_session() as db:
        await reindex_kb(
            db, kb_id, owner_id, config=None, vector_store=store, scheduler=scheduler,
        )

    print(f"\n{'时间(s)':>8} {'正式集合':>8} {'待提交集合':>10} {'检索命中':>8}")
    print("-" * 42)
    started = time.monotonic()
    timeline: list[tuple[float, int, bool, int]] = []
    while True:
        elapsed = time.monotonic() - started
        staged = await store.has_staged_collection(kb_id)
        total = await _count_chunks(store, kb_id)
        hits = len(await store.bm25_search(kb_id, QUERY, top_k=5))
        timeline.append((elapsed, total, staged, hits))
        print(f"{elapsed:8.0f} {total:8d} {str(staged):>10} {hits:8d}")

        if not staged and not scheduler._queue and not scheduler._running:  # noqa: SLF001
            break
        if elapsed > args.timeout:
            print("超时", file=sys.stderr)
            return 3
        await asyncio.sleep(args.interval)

    after_total = await _count_chunks(store, kb_id)
    empty_moments = [t for t, total, _s, hits in timeline if hits == 0]
    print(f"\n重建后：正式集合 {after_total} 片")
    print(f"探测 {len(timeline)} 次，其中检索 0 命中的时刻：{len(empty_moments)} 次")
    if empty_moments:
        print("  ✗ 重建期间出现了检索不到内容的窗口（原子重建未生效）")
        return 1
    print("  ✓ 重建全程都有完整检索结果（要么旧数据、要么新数据）")

    if doc_id:
        chunks = await store.get_chunks_by_doc_id(kb_id, doc_id)
        print(f"  抽样文档切片数: {len(chunks)}")
    return 0


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    raise SystemExit(asyncio.run(main(), loop_factory=asyncio.SelectorEventLoop))
