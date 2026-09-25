"""重跑某个知识库里失败/取消的文档（迭代 4 的线上修补工具）。

典型场景：一次整库重建里有文档因为**图谱抽取阶段超时**被判失败——切片其实已经
写入向量库，但文档状态是 failed，用户在界面上看不到它、检索也可能被判失败的任务
拦住。修复后（抽取超时只记 graph_error）重跑这些文档即可补齐，不必整库重建。

用法（在 web/backend 下）::

    uv run python scripts/retry_kb_failed_docs.py --kb 5a28d123            # 预览
    uv run python scripts/retry_kb_failed_docs.py --kb 5a28d123 --yes
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

#: 需要重跑的状态——终态里只有 failed/canceled 值得重试
RETRYABLE = ("failed", "canceled", "queued", "parsing", "chunking", "embedding", "bm25", "extracting")


async def main() -> int:
    parser = argparse.ArgumentParser(description="重跑知识库里失败/未完成的文档")
    parser.add_argument("--kb", required=True, help="知识库 id 前缀或名称")
    parser.add_argument("--yes", action="store_true", help="确认执行")
    parser.add_argument("--timeout", type=float, default=3600.0)
    args = parser.parse_args()

    from sqlalchemy import select

    from agent.config import settings
    from db.engine import async_session
    from db.models.knowledge_base import KnowledgeBase
    from db.models.knowledge_base_document import KnowledgeBaseDocument

    from scripts.rebuild_kb_native_bm25 import build_stack, wait_for_drain

    async with async_session() as db:
        kbs = (await db.execute(select(KnowledgeBase))).scalars().all()
        kb = next(
            (k for k in kbs if k.id.startswith(args.kb) or k.name == args.kb), None,
        )
        if kb is None:
            print(f"未找到知识库：{args.kb}", file=sys.stderr)
            return 2
        docs = list((await db.execute(
            select(KnowledgeBaseDocument).where(
                KnowledgeBaseDocument.kb_id == kb.id,
                KnowledgeBaseDocument.status.in_(RETRYABLE),
            )
        )).scalars().all())
        kb_id, owner_id, kb_name = kb.id, kb.user_id, kb.name

    if not docs:
        print(f"《{kb_name}》没有需要重跑的文档")
        return 0

    print(f"《{kb_name}》待重跑 {len(docs)} 篇：")
    for doc in docs:
        print(f"  - {doc.name}  status={doc.status}  {(doc.error_message or '')[:80]}")
    if not args.yes:
        print("确认请加 --yes", file=sys.stderr)
        return 2

    store, scheduler = await build_stack(settings)

    from api.knowledge_base.doc_service import retry_document

    started = time.monotonic()
    for doc in docs:
        async with async_session() as db:
            try:
                await retry_document(db, kb_id, doc.id, owner_id, scheduler, store)
                await db.commit()
                print(f"已入队重跑：{doc.name}")
            except Exception as exc:  # noqa: BLE001 - 逐篇处理，失败不中断其余
                print(f"重跑 {doc.name} 失败：{type(exc).__name__}: {exc}", file=sys.stderr)

    if not await wait_for_drain(scheduler, args.timeout):
        print("等待索引完成超时", file=sys.stderr)
        return 3

    async with async_session() as db:
        rows = list((await db.execute(
            select(KnowledgeBaseDocument).where(KnowledgeBaseDocument.kb_id == kb_id)
        )).scalars().all())
        kb_row = (await db.execute(
            select(KnowledgeBase).where(KnowledgeBase.id == kb_id)
        )).scalar_one()
        print(f"\n用时 {time.monotonic() - started:.0f}s，KB chunks={kb_row.chunks_count}")
        for doc in rows:
            graph = f" | graph_error={doc.graph_error[:40]}" if doc.graph_error else ""
            print(f"  {doc.name[:34]:36} {doc.status:9} chunks={doc.chunks_count}{graph}")
    return 0


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    raise SystemExit(asyncio.run(main(), loop_factory=asyncio.SelectorEventLoop))
