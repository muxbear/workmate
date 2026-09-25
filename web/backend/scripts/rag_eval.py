"""知识库检索质量评测——黄金集跑分。

用法（在 web/backend 目录下）::

    uv run python scripts/rag_eval.py                     # 用知识库自身配置跑一遍
    uv run python scripts/rag_eval.py --mode hybrid
    uv run python scripts/rag_eval.py --rerank off        # 对比关掉精排
    uv run python scripts/rag_eval.py --min-similarity 0  # 关掉绝对门槛
    uv run python scripts/rag_eval.py --rewrite on        # 对比开启查询改写
    uv run python scripts/rag_eval.py --compare baseline.json

指标（K = top_k）：

- **Hit@K**：命中至少一个期望文档/关键词的查询占比；
- **Recall@K**：期望文档被召回的平均比例（多文档期望时按比例计）；
- **MRR**：第一个命中结果的排名倒数均值；
- **NDCG@K**：二值相关性的归一化折损累计增益；
- **误召回率**：负样本（库里确实没有答案）中**返回了结果**的比例——越低越好；
- **延迟**：p50 / p95。

设计取舍：黄金集按知识库名（``kb``）引用，脚本启动时按名称解析 kb_id，
这样换环境（开发库 → 测试库）不用改数据文件。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import statistics
import sys
import time
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))
sys.path.insert(0, str(BACKEND_DIR / "src"))

import agent.config.config as _cfg  # noqa: E402,F401  触发 load_dotenv

GOLDEN_PATH = BACKEND_DIR / "tests" / "rag_eval" / "golden.jsonl"
DEFAULT_TOP_K = 10
MODES = ("hybrid", "vector", "bm25")

#: 黄金集用**别名**引用知识库，别名 → 实际库名里应包含的片段（按顺序尝试）。
#: 用别名而不是库名，是为了让黄金集不依赖具体命名（例如库里把 Kubernetes
#: 写成了 Kubernates）。
KB_ALIASES: dict[str, tuple[str, ...]] = {
    "kubernetes": ("kubernates", "kubernetes"),
    "langchain": ("langchain",),
}


def load_golden(path: Path = GOLDEN_PATH) -> list[dict[str, Any]]:
    """读取黄金集（JSONL，一行一条）。"""
    cases: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                cases.append(json.loads(line))
    return cases


async def resolve_kb_ids() -> dict[str, str]:
    """把黄金集里的知识库名解析成 kb_id。"""
    from sqlalchemy import select

    from db.engine import async_session
    from db.models.knowledge_base import KnowledgeBase

    wanted = {case["kb"] for case in load_golden()}
    async with async_session() as db:
        rows = (
            await db.execute(select(KnowledgeBase.id, KnowledgeBase.name))
        ).all()

    mapping: dict[str, str] = {}
    for key in wanted:
        fragments = KB_ALIASES.get(key, (key,))
        for fragment in fragments:
            match = next(
                (kb_id for kb_id, name in rows if fragment in (name or "").lower()),
                None,
            )
            if match:
                mapping[key] = match
                break
    return mapping


def is_relevant(case: dict[str, Any], result: Any) -> bool:
    """判定单条检索结果是否与黄金条目相关。

    两种相关性信号，满足其一即算命中：

    - ``expect_docs``：结果所属文档名匹配（章节级黄金集用）；
    - ``expect_keywords``：结果正文包含任一期望关键词（整本书一个文档时用）。
    """
    doc_names = case.get("expect_docs") or []
    keywords = case.get("expect_keywords") or []
    if doc_names:
        for name in doc_names:
            if result.doc_name == name or result.doc_name.startswith(name.split(" ")[0]):
                return True
    if keywords:
        content = (result.content or "").lower()
        return any(kw.lower() in content for kw in keywords)
    return False


def score_case(case: dict[str, Any], results: list[Any], top_k: int) -> dict[str, float]:
    """计算单条查询的指标。"""
    is_negative = case.get("category") == "negative"
    if is_negative:
        # 负样本：返回了结果就算误召回
        return {"hit": 0.0, "recall": 0.0, "mrr": 0.0, "ndcg": 0.0, "false_hit": 1.0 if results else 0.0}

    flags = [is_relevant(case, r) for r in results[:top_k]]
    expected = max(len(case.get("expect_docs") or []) or 1, 1)
    min_expected = int(case.get("min_expected") or expected)

    hit = 1.0 if sum(flags) >= min_expected else 0.0
    recall = min(sum(flags) / expected, 1.0)

    mrr = 0.0
    for index, flag in enumerate(flags, start=1):
        if flag:
            mrr = 1.0 / index
            break

    # 二值 NDCG：理想排序是"相关项全部排在前面"
    dcg = sum(flag / math.log2(i + 2) for i, flag in enumerate(flags))
    ideal_flags = sorted(flags, reverse=True)
    idcg = sum(flag / math.log2(i + 2) for i, flag in enumerate(ideal_flags))
    ndcg = dcg / idcg if idcg > 0 else 0.0

    return {"hit": hit, "recall": recall, "mrr": mrr, "ndcg": ndcg, "false_hit": 0.0}


async def run(
    *,
    modes: tuple[str, ...],
    top_k: int,
    rerank: bool | None,
    min_similarity: float | None,
    score_threshold: float | None,
    dedup_similarity: float | None,
    max_per_doc: int | None,
    rewrite: bool | None = None,
    hyde: bool | None = None,
) -> dict[str, Any]:
    """跑完整评测，返回报告字典。"""
    from agent.config import settings
    from api.knowledge_base.model_provider import load_embedding_model
    from api.knowledge_base.schemas import SearchRequest
    from api.knowledge_base.search_service import SearchOrchestrator
    from core.rag.vector_store import MilvusVectorStore
    from db.engine import async_session

    cases = load_golden()
    kb_ids = await resolve_kb_ids()
    missing = {c["kb"] for c in cases} - set(kb_ids)
    if missing:
        raise SystemExit(f"黄金集引用了不存在的知识库: {sorted(missing)}")

    async with async_session() as setup_db:
        embedding = await load_embedding_model(setup_db)
    store = MilvusVectorStore(
        uri=settings.MILVUS_URI,
        user=settings.MILVUS_USER,
        password=settings.MILVUS_PASSWORD,
        db_name=settings.MILVUS_DEFAULT_DB,
    )
    orchestrator = SearchOrchestrator(vector_store=store, embedding_model=embedding)

    #: 每个用例一个会话，而不是全程共用一个：
    #: 一次检索在两次 SQL 之间要对 embedding / 向量库 / 精排服务发多次远程调用
    #: （开精排时单条 ~1s），共用会话等于让同一条连接在整个跑分期间一直挂着——实测
    #: 跑几十条后连接被服务端关闭，之后**所有**用例都报
    #: "PendingRollbackError: Can't reconnect until invalid transaction is rolled back"，
    #: 分数被静默算成 0。评测是质量门禁，静默作废比报错更危险。
    report: dict[str, Any] = {
        "top_k": top_k,
        # 黄金集规模——基线只在本字段相同时可比：用例集合一变（新增/删除），
        # 指标的分母就变了，跨集合比大小会把"题目变难"误读成"质量下降"
        "golden_cases": len(cases),
        "overrides": {
            "rerank": rerank,
            "min_similarity": min_similarity,
            "score_threshold": score_threshold,
            "dedup_similarity": dedup_similarity,
            "max_chunks_per_doc": max_per_doc,
            "rewrite": rewrite,
            "hyde": hyde,
        },
        "modes": {},
    }

    for mode in modes:
        rows: list[dict[str, Any]] = []
        latencies: list[float] = []
        for case in cases:
            request = SearchRequest(
                query=case["query"],
                mode=mode,
                top_k=top_k,
                enable_rerank=rerank,
                min_similarity=min_similarity,
                score_threshold=score_threshold,
                dedup_similarity=dedup_similarity,
                max_chunks_per_doc=max_per_doc,
                use_rewrite=rewrite,
                use_hyde=hyde,
                # 多轮用例带 history：指代消解的输入，缺了它就无法还原"它/这个"
                history=case.get("history"),
            )
            started = time.perf_counter()
            try:
                async with async_session() as db:
                    response = await orchestrator.search(db, kb_ids[case["kb"]], request)
                error = None
            except Exception as exc:  # noqa: BLE001 - 评测要跑完全部用例
                response, error = None, f"{type(exc).__name__}: {exc}"
            latencies.append((time.perf_counter() - started) * 1000)

            if response is None:
                rows.append({
                    "id": case["id"], "category": case["category"],
                    "error": error, "metrics": {
                        "hit": 0.0, "recall": 0.0, "mrr": 0.0,
                        "ndcg": 0.0, "false_hit": 0.0,
                    },
                })
                continue

            rows.append({
                "id": case["id"],
                "category": case["category"],
                "query": case["query"],
                "total": response.total,
                "no_relevant_result": response.no_relevant_result,
                "rerank_applied": response.rerank_applied,
                "rewrite_applied": response.rewrite_applied,
                "rewrite_queries": response.rewrite_queries,
                "deduped_count": response.deduped_count,
                "top_docs": [r.doc_name for r in response.results[:3]],
                "metrics": score_case(case, response.results, top_k),
            })

        positives = [r for r in rows if r["category"] != "negative"]
        negatives = [r for r in rows if r["category"] == "negative"]

        def mean(key: str, items: list[dict[str, Any]]) -> float:
            return (
                statistics.fmean(item["metrics"][key] for item in items)
                if items else 0.0
            )

        latencies.sort()
        report["modes"][mode] = {
            "hit@k": round(mean("hit", positives), 4),
            "recall@k": round(mean("recall", positives), 4),
            "mrr": round(mean("mrr", positives), 4),
            "ndcg@k": round(mean("ndcg", positives), 4),
            "false_positive_rate": round(mean("false_hit", negatives), 4),
            "positive_cases": len(positives),
            "negative_cases": len(negatives),
            "latency_p50_ms": round(latencies[len(latencies) // 2], 1),
            "latency_p95_ms": round(latencies[int(len(latencies) * 0.95) - 1], 1),
            "deduped_total": sum(r.get("deduped_count") or 0 for r in rows),
            # 改写生效的用例数——"改写没生效"会让指标改善无从谈起，
            # 因此与延迟一样属于必须如实暴露的运行状态
            "rewrite_applied_cases": sum(
                1 for r in rows if r.get("rewrite_applied")
            ),
            "by_category": {
                category: round(
                    mean("hit", [r for r in positives if r["category"] == category]), 4,
                )
                for category in sorted({r["category"] for r in positives})
            },
            "misses": [r["id"] for r in positives if r["metrics"]["hit"] == 0.0],
            "false_positives": [r["id"] for r in negatives if r["metrics"]["false_hit"] > 0],
            "errors": [r["id"] for r in rows if r.get("error")],
            "details": rows,
        }

    return report


def print_report(report: dict[str, Any]) -> None:
    """打印可读的评测结果。"""
    print(f"\n检索质量评测（top_k={report['top_k']}，覆盖 {report['overrides']}）")
    header = f"{'mode':8} {'Hit@K':>7} {'Recall@K':>9} {'MRR':>7} {'NDCG@K':>8} {'误召回':>8} {'p50':>7} {'p95':>7}"
    print(header)
    print("-" * len(header))
    for mode, metrics in report["modes"].items():
        print(
            f"{mode:8} {metrics['hit@k']:>7.3f} {metrics['recall@k']:>9.3f} "
            f"{metrics['mrr']:>7.3f} {metrics['ndcg@k']:>8.3f} "
            f"{metrics['false_positive_rate']:>8.3f} "
            f"{metrics['latency_p50_ms']:>6.0f}ms {metrics['latency_p95_ms']:>6.0f}ms"
        )
    for mode, metrics in report["modes"].items():
        print(f"\n[{mode}] 分类命中率: {metrics['by_category']}")
        if metrics.get("deduped_total"):
            print(f"[{mode}] 去冗余丢弃条数合计: {metrics['deduped_total']}")
        if metrics.get("rewrite_applied_cases"):
            print(f"[{mode}] 改写生效用例数: {metrics['rewrite_applied_cases']}")
        if metrics.get("errors"):
            # 报错的用例会被算成"没命中"，必须明确区分：否则一次连接抖动看起来
            # 就像检索质量崩了
            print(f"[{mode}] 执行报错（分数不可信）: {metrics['errors']}")
        if metrics["misses"]:
            print(f"[{mode}] 未命中: {metrics['misses']}")
        if metrics["false_positives"]:
            print(f"[{mode}] 误召回（负样本却返回了结果）: {metrics['false_positives']}")


def compare(current: dict[str, Any], baseline_path: Path) -> None:
    """与基线报告对比，打印每个指标的增减。"""
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    print(f"\n与基线 {baseline_path.name} 对比（正数=变好）")

    # 用例集合不同则不可比：分母变了，涨跌都可能是"题目变难/变易"造成的假象
    base_cases = baseline.get("golden_cases")
    if base_cases is not None and base_cases != current.get("golden_cases"):
        print(
            f"\n⚠ 基线是 {base_cases} 条用例、本次是 {current.get('golden_cases')} 条——"
            "用例集合不同，指标不可直接比较。请先确认是否该重跑基线"
            "（make rag_baseline）。"
        )
    for mode, metrics in current["modes"].items():
        base = baseline.get("modes", {}).get(mode)
        if not base:
            continue
        print(f"\n[{mode}]")
        for key in ("hit@k", "recall@k", "mrr", "ndcg@k"):
            delta = metrics[key] - base[key]
            print(f"  {key:10} {base[key]:.3f} → {metrics[key]:.3f}  ({delta:+.3f})")
        delta_fp = metrics["false_positive_rate"] - base["false_positive_rate"]
        print(
            f"  {'误召回率':10} {base['false_positive_rate']:.3f} → "
            f"{metrics['false_positive_rate']:.3f}  ({delta_fp:+.3f}，越低越好)"
        )
        # 分类子集单独对比：整体指标会被大子集主导，掩盖"多轮/口语化"这类
        # 小样本子集的变化——而它们恰恰是改写等能力的主战场
        base_cats = base.get("by_category", {})
        current_cats = metrics.get("by_category", {})
        for category in sorted(current_cats):
            if category not in base_cats:
                continue
            delta = current_cats[category] - base_cats[category]
            print(
                f"  [{category}] {base_cats[category]:.3f} → "
                f"{current_cats[category]:.3f}  ({delta:+.3f})"
            )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="知识库检索质量评测")
    parser.add_argument("--mode", action="append", choices=MODES, help="只跑指定模式（可重复）")
    parser.add_argument("--top-k", type=int, default=DEFAULT_TOP_K)
    parser.add_argument("--rerank", choices=("on", "off"), help="覆盖精排开关")
    parser.add_argument("--min-similarity", type=float, help="覆盖最低余弦门槛（0 表示关闭）")
    parser.add_argument("--score-threshold", type=float, help="覆盖相对截断比例")
    parser.add_argument("--dedup", type=float, help="覆盖近重复阈值（0 表示关闭去重）")
    parser.add_argument("--max-per-doc", type=int, help="覆盖单文档结果上限（0 表示不限制）")
    parser.add_argument("--rewrite", choices=("on", "off"), help="覆盖查询改写开关")
    parser.add_argument("--hyde", choices=("on", "off"), help="覆盖 HyDE 开关")
    parser.add_argument("--json", type=Path, help="把完整报告写到该文件（可作为后续基线）")
    parser.add_argument("--compare", type=Path, help="与已有基线报告对比")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    modes = tuple(args.mode) if args.mode else MODES
    rerank = None if args.rerank is None else args.rerank == "on"

    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    report = asyncio.run(run(
        modes=modes,
        top_k=args.top_k,
        rerank=rerank,
        min_similarity=args.min_similarity,
        score_threshold=args.score_threshold,
        dedup_similarity=args.dedup,
        max_per_doc=args.max_per_doc,
        rewrite=None if args.rewrite is None else args.rewrite == "on",
        hyde=None if args.hyde is None else args.hyde == "on",
    ))
    print_report(report)

    if args.compare:
        compare(report, args.compare)
    if args.json:
        args.json.write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8",
        )
        print(f"\n报告已写入 {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
