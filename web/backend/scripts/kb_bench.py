"""知识库性能基准与容量规划（迭代 4 T4.6）。

回答三个问题：

1. **索引吞吐**：向量化 + 写入实际能跑多少片/秒（迭代 4 的验收线是 ≥20 片/秒）；
2. **检索延迟与并发**：P50/P95/P99、并发下的吞吐，以及**事件循环是否被阻塞**
   （T4.1 的验收线是压测下健康检查 P99 < 50ms——这里直接测事件循环的最大停顿，
   它比健康检查更敏感）；
3. **容量规划**：每 10 万片需要多少内存/磁盘/embedding 成本。

用法（在 web/backend 下）::

    uv run python scripts/kb_bench.py --capacity                  # 只打印容量估算表
    uv run python scripts/kb_bench.py --kb 5a28d123 --search      # 检索压测（含 BM25）
    uv run python scripts/kb_bench.py --index --chunks 300        # 索引吞吐（会调 embedding API）

索引压测会**真实调用 embedding 接口并写入一个临时集合**（`bench_tmp_*`），
跑完即删；不想花配额就别加 `--index`。
"""

from __future__ import annotations

import argparse
import asyncio
import os
import statistics
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


def _percentile(values: list[float], ratio: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(len(ordered) * ratio) - 1))
    return ordered[index]


class EventLoopLagMonitor:
    """后台心跳，记录事件循环被占住的最长时间。

    这是"检索是否阻塞事件循环"的直接证据：一次 O(N) 的客户端 BM25 打分能让它
    停顿几百毫秒到几秒（实测 2967ms），而健康检查正是被这种停顿拖垮的。
    """

    def __init__(self, interval: float = 0.01):
        self._interval = interval
        self._gaps: list[float] = []
        self._stop = asyncio.Event()
        self._task: asyncio.Task | None = None

    async def _run(self) -> None:
        last = time.perf_counter()
        while not self._stop.is_set():
            await asyncio.sleep(self._interval)
            now = time.perf_counter()
            self._gaps.append(now - last)
            last = now

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> float:
        if self._task is None:
            return 0.0
        self._stop.set()
        await self._task
        return max(self._gaps) * 1000 if self._gaps else 0.0


def _rss_mb() -> float:
    """当前进程内存占用（Windows / POSIX 各取一次）。"""
    try:
        import resource  # type: ignore[import-not-found]

        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    except ImportError:
        pass
    try:
        import ctypes

        class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        counters = PROCESS_MEMORY_COUNTERS()
        counters.cb = ctypes.sizeof(counters)
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        psapi = ctypes.windll.psapi  # type: ignore[attr-defined]
        # 必须显式声明参数类型：进程句柄在 64 位下是 8 字节指针，默认按 c_int 传会被
        # 截断，调用静默失败、WorkingSetSize 保持 0（表现就是"内存读数从来不打印"）
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        psapi.GetProcessMemoryInfo.argtypes = [
            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong,
        ]
        psapi.GetProcessMemoryInfo.restype = ctypes.c_int
        handle = kernel32.GetCurrentProcess()
        ok = psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb)
        if not ok:
            return -1.0
        return counters.WorkingSetSize / (1024 * 1024)
    except Exception:  # noqa: BLE001 - 拿不到内存不是致命错误
        return -1.0


# ─── 容量规划 ─────────────────────────────────────────────────────────────────


def print_capacity(chunks: int = 100_000, dim: int = 1024) -> None:
    """打印每 N 片所需的资源估算。

    口径说明（都是**下界**，忽略索引自身开销与副本）：
    - 向量：float32 × 维度；
    - 原文：按每片 512 字符、中文 UTF-8 约 3 字节估算；
    - Milvus 稀疏倒排：与词表规模相关，按原文的 ~30% 估；
    - embedding 成本：按每片约 350 tokens（512 汉字的较保守估计）。
    """
    vec_bytes = chunks * dim * 4
    text_bytes = chunks * 512 * 3
    sparse_bytes = int(text_bytes * 0.3)
    total_gb = (vec_bytes + text_bytes + sparse_bytes) / 1024 ** 3
    tokens = chunks * 350

    print(f"\n容量规划（{chunks:,} 片，dim={dim}）")
    print(f"  稠密向量      {vec_bytes / 1024 ** 2:8.0f} MB")
    print(f"  原文正文      {text_bytes / 1024 ** 2:8.0f} MB")
    print(f"  稀疏倒排      {sparse_bytes / 1024 ** 2:8.0f} MB")
    print(f"  合计          {total_gb:8.2f} GB（Milvus 侧，不含副本与索引开销）")
    print(f"  首建 embedding 输入约 {tokens / 1_000_000:.1f}M tokens")
    print("  检索侧内存：原生稀疏检索下与库规模**解耦**（倒排在服务端）；")
    print("              老集合（客户端 BM25 回退）会把整库语料驻留进程，随库线性增长。")
    print("\n经验值（本轮实测，供排期参考）：")
    print("  · 原生 BM25 热查询 ~30ms/次（318 片库）；客户端回退 ~700ms/次（1841 片库）")
    print("  · 索引吞吐受 embedding 接口配额主导，并发 4 路批量时约 1~3 批/秒")


# ─── 检索压测 ─────────────────────────────────────────────────────────────────


async def run_search_bench(
    kb_id: str, *, queries: int, concurrency: int, top_k: int, modes: tuple[str, ...],
) -> int:
    from agent.config import settings
    from core.rag.bm25 import SparseConfig
    from core.rag.vector_store import MilvusVectorStore

    store = MilvusVectorStore(
        uri=settings.MILVUS_URI, user=settings.MILVUS_USER,
        password=settings.MILVUS_PASSWORD, db_name=settings.MILVUS_DEFAULT_DB,
    )
    sample_queries = [
        "怎么搭建 Kubernetes 环境", "MySQL 主从复制怎么配置", "Redis 集群分片",
        "Nacos 集群部署几个节点", "Jenkins 流水线怎么配", "Seata 分布式事务怎么用",
    ]
    print(f"\n检索压测（kb={kb_id[:8]}，{queries} 次查询 × {concurrency} 并发，top_k={top_k}）")
    print(f"{'模式':10} {'P50':>8} {'P95':>8} {'P99':>8} {'吞吐':>10} {'循环停顿':>10}")
    print("-" * 60)

    for mode in modes:
        embedding = None
        if mode == "vector":
            from api.knowledge_base.model_provider import load_embedding_model
            from db.engine import async_session

            async with async_session() as db:
                embedding = await load_embedding_model(db)

        # 预热：首次检索要加载集合与（服务端）稀疏索引，不预热会把它算进 P95
        if mode == "bm25":
            await store.bm25_search(kb_id, sample_queries[0], top_k=top_k, sparse_config=SparseConfig())
        else:
            await store.similarity_search(kb_id, await embedding.aembed_query(sample_queries[0]), top_k=top_k)

        latencies: list[float] = []
        semaphore = asyncio.Semaphore(concurrency)

        async def one(index: int) -> None:
            query = sample_queries[index % len(sample_queries)]
            async with semaphore:
                started = time.perf_counter()
                if mode == "bm25":
                    await store.bm25_search(kb_id, query, top_k=top_k, sparse_config=SparseConfig())
                else:
                    vector = await embedding.aembed_query(query)
                    await store.similarity_search(kb_id, vector, top_k=top_k)
                latencies.append((time.perf_counter() - started) * 1000)

        monitor = EventLoopLagMonitor()
        monitor.start()
        wall_start = time.perf_counter()
        await asyncio.gather(*(one(i) for i in range(queries)))
        wall = time.perf_counter() - wall_start
        stall = await monitor.stop()

        print(
            f"{mode:10} {_percentile(latencies, 0.5):7.0f}ms {_percentile(latencies, 0.95):7.0f}ms "
            f"{_percentile(latencies, 0.99):7.0f}ms {queries / wall:7.1f} 次/秒 {stall:8.0f}ms",
        )
    return 0


# ─── 索引吞吐 ─────────────────────────────────────────────────────────────────


async def run_index_bench(
    chunks: int, concurrency: int | None, keep: bool = False, stream: bool = False,
) -> int:
    from agent.config import settings
    from api.knowledge_base.model_provider import (
        load_embedding_model,
        resolve_embedding_dim,
    )
    from core.rag.vector_store import MilvusVectorStore
    from db.engine import async_session
    from langchain_core.documents import Document

    kb_id = f"bench-tmp-{int(time.time())}"
    store = MilvusVectorStore(
        uri=settings.MILVUS_URI, user=settings.MILVUS_USER,
        password=settings.MILVUS_PASSWORD, db_name=settings.MILVUS_DEFAULT_DB,
    )
    async with async_session() as db:
        # 先解析"会用哪个模型、哪个维度"再打印：这个压测真花 embedding 配额，
        # 操作者有权在花钱之前知道账单落在哪个模型上
        dim = await resolve_embedding_dim(db)
        embedding = await load_embedding_model(db)
        model_name = getattr(embedding, "model", None) or "(未知)"

    if not dim:
        print("无法确定 embedding 维度（模型不可用？），已中止", file=sys.stderr)
        return 2
    print(
        f"\n索引吞吐压测（{chunks} 片，dim={dim}，embedding 并发={concurrency or '默认'}）\n"
        f"  将真实调用 embedding 接口：模型={model_name}，"
        f"约 {chunks * 350 / 1_000_000:.2f}M tokens 输入",
    )

    # 生成与真实切片同量级的正文（512 字符上下，含中英文混合）
    texts = [
        f"第{i}段：Kubernetes 集群部署需要先初始化控制平面节点，再让工作节点加入；"
        f"kubeadm init --image-repository registry.aliyuncs.com 可以指定镜像仓库。"
        f"这一段用于压测，编号 {i}。"
        for i in range(chunks)
    ]
    documents = [
        Document(page_content=t, metadata={"doc_id": "bench-doc", "chunk_index": i, "metadata_": {}})
        for i, t in enumerate(texts)
    ]

    rss_before = _rss_mb()
    # 维度取自模型真实输出，而不是写死 1024——写死会让"选到的模型不是 1024 维"
    # 这种情况在写入阶段才以维度断言的形式炸出来
    await store.create_collection(kb_id, dim=dim)

    batches: list[tuple[int, list]] = []
    embeddings: list[list[float]] = []

    #: 流式模式：写入放在回调里，与生产流水线（EmbeddingState）完全同构——
    #: 向量边生成边落库，进程只持有**单批**。非流式模式把全部向量攒下来以便
    #: 分别计量"向量化"与"写入"两段耗时，但代价是 10 万片会让进程多占约 4GB
    #: （实测 3 万片 ≈1.2GB 并造成 197ms 事件循环停顿）——那是**压测脚本**的内存
    #: 形态，不是产品的，读停顿数字时必须分清。
    async def on_batch(start: int, batch_texts: list[str], vectors: list) -> None:
        if stream:
            batch_docs = documents[start:start + len(batch_texts)]
            await store.add_documents(kb_id, batch_docs, vectors)
            return
        batches.append((start, batch_texts))
        embeddings.extend(vectors)

    monitor = EventLoopLagMonitor()
    monitor.start()
    started = time.perf_counter()
    try:
        await embedding.aembed_documents(texts, on_batch=on_batch)
        embed_seconds = time.perf_counter() - started
        write_seconds = 0.0
        if not stream:
            # 非流式：写完再落库（便于分段计时）
            write_started = time.perf_counter()
            for start, batch_texts in batches:
                batch_docs = documents[start:start + len(batch_texts)]
                await store.add_documents(
                    kb_id, batch_docs, embeddings[start:start + len(batch_texts)],
                )
            write_seconds = time.perf_counter() - write_started
    finally:
        stall = await monitor.stop()
        total = time.perf_counter() - started
        # --keep 时不删：T4.2 的验收是"10 万片规模检索 P95 ≤ 300ms"，需要保留这个
        # 集合才能接着用 --search 在同一规模上测检索（否则要重新花一遍 embedding）
        if not keep:
            await store.delete_collection(kb_id)

    rss_after = _rss_mb()
    if stream:
        print(f"  向量化+写入（流式，与生产同构）{embed_seconds:6.1f}s")
    else:
        print(f"  向量化 {embed_seconds:6.1f}s（{chunks / embed_seconds:5.1f} 片/秒）")
        print(f"  写入   {write_seconds:6.1f}s（{chunks / write_seconds:5.1f} 片/秒）")
    print(f"  合计   {total:6.1f}s（{chunks / total:5.1f} 片/秒，验收线 ≥20）")
    print(f"  事件循环最大停顿 {stall:.0f}ms")
    if rss_before > 0 and rss_after > 0:
        print(f"  进程内存 {rss_before:.0f}MB → {rss_after:.0f}MB")
    if keep:
        print(
            "  已保留压测集合（kb_id=" + kb_id + "）——接着在同一规模上测检索：",
        )
        print(
            f"    python scripts/kb_bench.py --kb {kb_id} --search "
            "--modes bm25 --queries 60 --concurrency 8",
        )
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="知识库性能基准")
    parser.add_argument("--kb", help="知识库 id 前缀（检索压测用）")
    parser.add_argument("--search", action="store_true", help="跑检索压测")
    parser.add_argument("--index", action="store_true", help="跑索引吞吐压测（会调 embedding API）")
    parser.add_argument("--capacity", action="store_true", help="只打印容量规划表")
    parser.add_argument("--queries", type=int, default=60, help="压测查询次数")
    parser.add_argument("--concurrency", type=int, default=8, help="并发数")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--chunks", type=int, default=200, help="索引压测的切片数")
    parser.add_argument(
        "--keep", action="store_true",
        help="保留压测集合（不再跑完即删），便于在同一规模上接着测检索延迟",
    )
    parser.add_argument(
        "--stream", action="store_true",
        help="流式写入（与生产流水线同构，进程只持有单批向量）——"
             "测内存与事件循环停顿时应加这个；不加则全量攒向量，数字会失真",
    )
    parser.add_argument("--modes", default="bm25,vector", help="检索模式，逗号分隔")
    return parser.parse_args()


async def main() -> int:
    args = parse_args()
    if not any([args.search, args.index, args.capacity]):
        args.capacity = True
    if args.capacity:
        print_capacity()

    if args.search:
        if not args.kb:
            print("--search 需要 --kb", file=sys.stderr)
            return 2
        from sqlalchemy import text

        from db.engine import async_session

        async with async_session() as db:
            row = (await db.execute(text(
                "SELECT id, name FROM knowledge_bases WHERE id LIKE :p LIMIT 1"
            ), {"p": f"{args.kb}%"})).one_or_none()
        if row is None:
            # 允许省略"先查库"这一步：数据库被迁移卡住时仍能按 id 直接压测
            kb_id = args.kb
        else:
            kb_id = row[0]
        modes = tuple(m.strip() for m in args.modes.split(",") if m.strip())
        await run_search_bench(
            kb_id, queries=args.queries, concurrency=args.concurrency,
            top_k=args.top_k, modes=modes,
        )

    if args.index:
        await run_index_bench(
            args.chunks, args.concurrency, keep=args.keep, stream=args.stream,
        )
    return 0


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    raise SystemExit(asyncio.run(main(), loop_factory=asyncio.SelectorEventLoop))
