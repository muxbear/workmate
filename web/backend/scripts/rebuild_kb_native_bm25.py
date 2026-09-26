"""重建某个知识库到「原生 BM25 稀疏索引」结构（迭代 4 T4.2 迁移脚本）。

背景：T4.2 之后的新 collection 带 ``sparse`` 字段 + BM25 Function（服务端倒排），
检索不再需要把全量语料拉进进程。**老 collection 没有这个字段**，会继续走客户端
回退路径（慢）。本脚本用知识库自己的源文件重建一次，把它切到原生路径。

为什么需要单独一个脚本：重建会**先清空向量与图谱**，且要调用 embedding API 重新
索引全部切片——这是花时间、花配额、且不可逆的操作，不适合放进请求路径里自动做。
脚本会先做源文件预检（与 `reindex_kb` 同一套检查），缺文件直接拒绝。

用法（在 web/backend 下）::

    uv run python scripts/rebuild_kb_native_bm25.py --list
    uv run python scripts/rebuild_kb_native_bm25.py --kb "Kubernates 开发文档" --yes
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

#: Windows 控制台默认是 GBK，中文与符号混排会直接 UnicodeEncodeError 把脚本打断
#: （实测在最后一步"打印校验结果"时崩掉，前面的重建白等）。统一改成 utf-8。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


async def list_kbs() -> list[tuple[str, str, int, int]]:
    """列出知识库（id / 名称 / 文档数 / 切片数）。"""
    from sqlalchemy import select

    from db.engine import async_session
    from db.models.knowledge_base import KnowledgeBase

    async with async_session() as db:
        rows = (await db.execute(select(KnowledgeBase))).scalars().all()
    return [(kb.id, kb.name, kb.docs_count or 0, kb.chunks_count or 0) for kb in rows]


def build_vector_store(settings):
    """只连向量库——校验路径不需要 embedding 模型，也就不该被数据库迁移卡住。"""
    from core.rag.vector_store import MilvusVectorStore

    return MilvusVectorStore(
        uri=settings.MILVUS_URI,
        user=settings.MILVUS_USER,
        password=settings.MILVUS_PASSWORD,
        db_name=settings.MILVUS_DEFAULT_DB,
    )


async def build_stack(settings):
    """按 facade 的组装方式搭出一套可用的索引 + 检索栈。

    先跑一次 ``init_db``：轻量迁移（新增列）挂在应用启动流程里，独立脚本不跑它
    就会撞上"列不存在"——而且报错看起来像脚本坏了，实际是库没迁移过。
    """
    from db.engine import init_db

    await init_db()

    from api.knowledge_base.doc_service import (
        DatabaseProgressObserver,
        IndexingPipeline,
        IndexingScheduler,
        LoggingProgressObserver,
    )
    from api.knowledge_base.graph_service import GraphExtractionService
    from api.knowledge_base.model_provider import load_embedding_model
    from core.rag.loaders import create_default_loader_registry
    from core.rag.splitters import INDEX_CONFIG_DEFAULTS, create_chunk_registry
    from core.rag.vector_store import MilvusVectorStore
    from db.engine import async_session

    async with async_session() as db:
        embedding_model = await load_embedding_model(db)

    store = MilvusVectorStore(
        uri=settings.MILVUS_URI,
        user=settings.MILVUS_USER,
        password=settings.MILVUS_PASSWORD,
        db_name=settings.MILVUS_DEFAULT_DB,
    )
    pipeline = IndexingPipeline(
        loader_registry=create_default_loader_registry(),
        chunk_registry=create_chunk_registry(
            dict(INDEX_CONFIG_DEFAULTS), embedding_model=embedding_model,
        ),
        embedding_model=embedding_model,
        vector_store=store,
        graph_service=GraphExtractionService(),
    )
    pipeline.attach(DatabaseProgressObserver(async_session))
    pipeline.attach(LoggingProgressObserver())
    scheduler = IndexingScheduler(
        pipeline=pipeline,
        max_concurrent=settings.INDEXING_MAX_CONCURRENT,
        session_factory=async_session,
    )
    return store, scheduler


async def wait_for_drain(scheduler, timeout: float) -> bool:
    """等队列与执行槽清空。返回是否在超时前完成。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not scheduler._queue and not scheduler._running:
            return True
        await asyncio.sleep(2)
    return False


async def verify(store, kb_id: str) -> int:
    """校验现状：原生稀疏结构、文档行计数与向量库实际切片数是否一致。

    只读、只连向量库 + 两张知识库表——不加载 embedding/LLM，因此不受"模型页配置"
    或待执行的迁移影响。
    """
    from sqlalchemy import text

    from db.engine import async_session

    collection = await store._get_collection(kb_id)
    fields = [f.name for f in collection.schema.fields]
    has_sparse = "sparse" in fields
    print(f"collection 字段: {fields}")
    print(f"原生稀疏检索: {'可用' if has_sparse else '不可用（会走客户端回退，性能差）'}")
    if has_sparse:
        print(f"稀疏索引参数: {store._read_sparse_index_params(collection)}")

    async with async_session() as db:
        kb_row = (await db.execute(text(
            "SELECT chunks_count FROM knowledge_bases WHERE id = :id"
        ), {"id": kb_id})).one()
        docs = (await db.execute(text(
            "SELECT d.id, d.name, d.status, d.chunks_count, d.graph_error, "
            "  (SELECT count(*) FROM knowledge_base_entities e WHERE e.doc_id = d.id), "
            "  (SELECT count(*) FROM knowledge_base_relations r WHERE r.doc_id = d.id) "
            "FROM knowledge_base_documents d WHERE d.kb_id = :id ORDER BY d.name"
        ), {"id": kb_id})).all()

    real_total = 0
    print(f"\n{'文档':34} {'状态':9} {'行内':>5} {'实际':>5}  图谱")
    for doc_id, doc_name, status, chunks_count, graph_error, ent, rel in docs:
        chunks = await store.get_chunks_by_doc_id(kb_id, doc_id)
        real_total += len(chunks)
        flag = "" if len(chunks) == (chunks_count or 0) else "  <-- 计数不一致"
        # 按**真实行数**报图谱，而不是按"有没有 graph_error 字段"：
        # 此前把"没有错误"当成"已生成"，于是 7 篇 0 实体的文档在自检里显示"已生成"，
        # 自检根本发现不了「索引成功但图谱为空」这种状态。
        graph = f"{ent} 实体/{rel} 关系"
        if graph_error:
            graph += f"  <-- {str(graph_error)[:26]}"
        elif ent == 0 and rel == 0 and status == "indexed":
            graph += "  <-- 无图谱也无错误记录（历史静默失败的形态）"
        print(
            f"{str(doc_name)[:32]:34} {status:9} {chunks_count or 0:>5} "
            f"{len(chunks):>5}  {graph}{flag}",
        )

    kb_total = kb_row[0] or 0
    print(
        f"\nKB 计数 {kb_total} / 向量库实际 {real_total}"
        + ("" if kb_total == real_total else "  <-- 不一致"),
    )

    print("\nBM25 检索抽样：")
    for query in ("MySQL 主从复制怎么配置", "怎么搭建 Kubernetes 环境", "Redis 集群分片"):
        started = time.perf_counter()
        hits = await store.bm25_search(kb_id, query, top_k=3)
        ms = (time.perf_counter() - started) * 1000
        print(f"  {ms:6.1f}ms  {query!r} -> {[(h[0][:8], round(h[1], 3)) for h in hits]}")
    return 0


async def main() -> int:
    parser = argparse.ArgumentParser(description="把知识库重建到原生 BM25 结构")
    parser.add_argument("--kb", help="知识库名称（精确匹配），或 id 前缀（避免中文名转义问题）")
    parser.add_argument("--list", action="store_true", help="只列出知识库")
    parser.add_argument("--yes", action="store_true", help="确认执行重建")
    parser.add_argument(
        "--verify-only", action="store_true",
        help="只校验现状（是否已是原生结构、切片数与文档行是否一致），不改数据",
    )
    parser.add_argument("--timeout", type=float, default=3600.0, help="等待索引完成的上限（秒）")
    args = parser.parse_args()

    rows = await list_kbs()
    if args.list or not args.kb:
        print(f"{'id':38} {'名称':24} {'文档':>5} {'切片':>7}")
        for kb_id, name, docs, chunks in rows:
            print(f"{kb_id:38} {name:24} {docs:>5} {chunks:>7}")
        return 0

    target = next(
        (r for r in rows if r[1] == args.kb or r[0].startswith(args.kb)), None,
    )
    if target is None:
        print(f"未找到知识库：{args.kb}", file=sys.stderr)
        return 2
    kb_id, name, docs_count, chunks_count = target

    if not args.yes and not args.verify_only:
        print(
            f"将重建《{name}》（{docs_count} 个文档 / {chunks_count} 片）：\n"
            "  1) 先做源文件预检，缺文件直接中止；\n"
            "  2) 清空向量与图谱，并用 embedding API 重新索引全部切片。\n"
            "确认请加 --yes。",
            file=sys.stderr,
        )
        return 2

    from core.config import get_settings

    settings = get_settings()   # 向量库配置在 core（T5.7 从 agent 配置迁入）

    if args.verify_only:
        # 校验只连向量库：不需要 embedding 模型，也就不该被数据库迁移/锁卡住
        return await verify(build_vector_store(settings), kb_id)

    store, scheduler = await build_stack(settings)

    from sqlalchemy import select

    from api.knowledge_base.service import reindex_kb
    from db.engine import async_session
    from db.models.knowledge_base import KnowledgeBase

    async with async_session() as db:
        kb = (
            await db.execute(select(KnowledgeBase).where(KnowledgeBase.id == kb_id))
        ).scalar_one()
        owner_id = kb.user_id
        sparse_algo = (kb.config or {}).get("sparse_algo")
        params = {
            k: (kb.config or {}).get(k) for k in ("bm25_k1", "bm25_b")
        }

    print(f"开始重建《{name}》  sparse_algo={sparse_algo}  bm25={params}")
    started = time.monotonic()
    async with async_session() as db:
        result = await reindex_kb(
            db, kb_id, owner_id, config=None, vector_store=store, scheduler=scheduler,
        )
    print(f"reindex_kb 返回: {result}")

    if not await wait_for_drain(scheduler, args.timeout):
        print("等待索引完成超时", file=sys.stderr)
        return 3

    elapsed = time.monotonic() - started

    # ── 校验 ──
    async with async_session() as db:
        kb = (
            await db.execute(select(KnowledgeBase).where(KnowledgeBase.id == kb_id))
        ).scalar_one()
        print(
            f"完成，用时 {elapsed:.0f}s：status={kb.status} "
            f"docs={kb.docs_count} chunks={kb.chunks_count}",
        )

    collection = await store._get_collection(kb_id)
    fields = [f.name for f in collection.schema.fields]
    has_sparse = "sparse" in fields
    print(f"collection 字段: {fields}")
    print(f"原生稀疏字段: {'有' if has_sparse else '无（仍是老结构，检索会走客户端回退）'}")
    if has_sparse:
        print(f"稀疏索引参数: {store._read_sparse_index_params(collection)}")

    for query in ("MySQL 主从复制怎么配置", "怎么搭建 Kubernetes 环境", "Redis 集群分片"):
        hits = await store.bm25_search(kb_id, query, top_k=3)
        print(f"  BM25 {query!r} -> {[(h[0][:8], round(h[1], 3)) for h in hits]}")
    return 0


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    raise SystemExit(asyncio.run(main(), loop_factory=asyncio.SelectorEventLoop))
