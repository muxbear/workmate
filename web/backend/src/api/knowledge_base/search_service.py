"""知识库检索服务——策略模式 + 注册表 + 模板方法编排器."""

import json
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession

from api.knowledge_base.schemas import ChunkMatch, SearchRequest, SearchResponse
from core.rag.bm25 import SparseConfig
from core.rag.reranker import RERANK_CANDIDATE_MULTIPLIER

logger = logging.getLogger(__name__)

RRF_K = 60
DEFAULT_HYBRID_ALPHA = 0.7
#: 精排候选上限——多数 rerank 接口对单次文档数有上限，且候选越多延迟越高
MAX_RERANK_CANDIDATES = 50

#: 分数含义常量——`ChunkMatch.score_kind` 与前端标注共用
SCORE_KIND_COSINE = "cosine"
SCORE_KIND_BM25 = "bm25"
SCORE_KIND_RRF = "rrf"
SCORE_KIND_RERANK = "rerank"

#: 默认最低余弦相似度，由黄金集校准（text-embedding-v4 + 现有两个知识库）：
#: 有真实命中的查询最高相似度落在 0.551~0.918，而"库里没有答案"的查询最高只有
#: 0.232~0.511 —— 取间隙中点 0.53，两侧各留 ~0.02 余量：
#:   * 0.35（最初凭经验取的值）只挡掉 4/11 个负样本，误召回率 0.64；
#:   * 0.60 会开始丢掉真实命中（30 条正样本损失 3 条）。
#: **换嵌入模型或语料后应重新校准**：`uv run python scripts/rag_eval.py` +
#: tests/rag_eval/golden.jsonl 即为校准工具。每个知识库可用 min_similarity 覆盖。
DEFAULT_MIN_SIMILARITY = 0.53

#: 相对截断默认关闭：绝对门槛已经处理了"根本没有相关内容"，
#: 再按比例截长尾会悄悄丢掉中等相关的结果，交给用户显式开启。
DEFAULT_SCORE_THRESHOLD = 0.0


def _coerce_float(value: object, default: float) -> float:
    """把配置里的数值安全转成 float；非法值回退默认。"""
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


# ─── 检索上下文 & 结果 ─────────────────────────────────────────────────────────


@dataclass
class SearchContext:
    """检索上下文——传递给策略的数据对象。"""
    kb_id: str
    query_text: str
    query_embedding: list[float]
    top_k: int
    alpha: float = DEFAULT_HYBRID_ALPHA
    sparse_config: SparseConfig = field(default_factory=SparseConfig)
    extra: dict = field(default_factory=dict)


@dataclass
class ScoredChunk:
    """带分维度得分的检索结果项。

    ``vec_score`` / ``bm25_score`` 一律是**原始分**（余弦相似度 / BM25 得分），
    ``score`` 的语义由 ``score_kind`` 标注。
    """
    chunk_id: str
    score: float
    vec_score: float | None = None
    bm25_score: float | None = None
    score_kind: str = ""


# ─── 分数融合工具函数 ──────────────────────────────────────────────────────────


def _citation_fields(chunk: dict) -> tuple[int | None, str]:
    """从切片元数据里取出引用定位信息（页码 / 章节）。

    元数据由索引阶段写入 ``metadata_``：``page`` 来自 loader，``section`` 用标题层级
    兜底（markdown 切片保留 h1/h2）。向量库两种后端对 JSON 字段的处理不同
    （Milvus 存对象、Chroma 存字符串），这里统一解析。
    """
    meta = chunk.get("metadata_") or {}
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except (json.JSONDecodeError, TypeError):
            meta = {}
    if not isinstance(meta, dict):
        meta = {}

    raw_page = meta.get("page", meta.get("page_ref"))
    page: int | None = None
    if isinstance(raw_page, int):
        page = raw_page
    elif isinstance(raw_page, str) and raw_page.strip().isdigit():
        page = int(raw_page.strip())

    section = meta.get("section") or meta.get("h1") or meta.get("h2") or ""
    return page, str(section)


def _normalize(pairs: list[tuple[str, float]]) -> dict[str, float]:
    """把单通道得分 min-max 归一化到 [0, 1]，仅用于展示分维度得分。"""
    if not pairs:
        return {}
    max_s = max(s for _, s in pairs)
    min_s = min(s for _, s in pairs)
    if max_s == min_s:
        return {cid: 1.0 for cid, _ in pairs}
    span = max_s - min_s
    return {cid: (s - min_s) / span for cid, s in pairs}


def _single_channel_fallback(
    vec_pairs: list[tuple[str, float]],
    bm25_pairs: list[tuple[str, float]],
    top_k: int,
) -> list[ScoredChunk]:
    """两路加权 RRF 全部归零时的兜底——返回唯一有结果的那一路。

    触发条件（两路权重之和恒为 1，因此至多一路权重为 0）：

    - ``alpha=0``（纯 BM25）但稀疏检索被关闭 → BM25 返回空，向量结果权重为 0；
    - ``alpha=1``（纯向量）但向量结果为空。

    此时若继续按 RRF 值排序，所有得分都是 0，顺序退化为 ``chunk_id``（UUID）
    字典序——结果与相关性完全无关。这里改为取有结果的那一路，**直接回传该路的
    原始得分**（向量路为余弦相似度、稀疏路为 BM25 分），与单路检索模式的展示口径
    一致；不做 min-max 归一化，否则末位结果的得分会被压成 0.0、看起来像"无关"。
    """
    if vec_pairs and not bm25_pairs:
        chosen, is_vec = vec_pairs, True
    elif bm25_pairs and not vec_pairs:
        chosen, is_vec = bm25_pairs, False
    elif vec_pairs and bm25_pairs:
        # 理论上不可达（权重之和为 1），保底取向量路
        chosen, is_vec = vec_pairs, True
    else:
        return []

    ordered = sorted(chosen, key=lambda pair: -pair[1])[:top_k]
    return [
        ScoredChunk(
            chunk_id=cid,
            score=round(score, 4),
            vec_score=round(score, 4) if is_vec else None,
            bm25_score=None if is_vec else round(score, 4),
            score_kind=SCORE_KIND_COSINE if is_vec else SCORE_KIND_BM25,
        )
        for cid, score in ordered
    ]


def _fuse_scores(
    vec_pairs: list[tuple[str, float]],
    bm25_pairs: list[tuple[str, float]],
    top_k: int,
    alpha: float,
) -> list[ScoredChunk]:
    """加权 RRF（倒数排名融合）——向量与 BM25 两路排名加权交错。

    ``alpha`` 是**向量通道权重**：``alpha=1`` 时退化为纯向量排序，``alpha=0``
    时退化为纯 BM25 排序，中间值则按比例调和两路排名。此前 RRF 使用固定权重，
    导致 ``hybrid_alpha`` / API 的 ``alpha`` 参数完全不改变结果顺序。

    综合得分取归一化后的 RRF 值本身，因此展示分数与排序**始终一致**（此前展示分
    用加权归一化和、排序用 RRF，两者可能互相矛盾）。
    """
    vec_weight = max(0.0, min(1.0, alpha))
    bm25_weight = 1.0 - vec_weight

    rrf: dict[str, float] = {}
    for rank, (cid, _) in enumerate(vec_pairs, start=1):
        rrf[cid] = rrf.get(cid, 0.0) + vec_weight / (RRF_K + rank)
    for rank, (cid, _) in enumerate(bm25_pairs, start=1):
        rrf[cid] = rrf.get(cid, 0.0) + bm25_weight / (RRF_K + rank)

    if not rrf:
        return []

    ranked = sorted(rrf.items(), key=lambda x: (-x[1], x[0]))[:top_k]
    max_rrf = ranked[0][1]

    if max_rrf <= 0:
        logger.warning(
            "RRF 权重全为零（alpha=%.2f，vec=%d 条 / bm25=%d 条），"
            "退化为单路结果以避免按 chunk_id 排序",
            alpha, len(vec_pairs), len(bm25_pairs),
        )
        return _single_channel_fallback(vec_pairs, bm25_pairs, top_k)

    # 分维度得分一律回传**原始分**（余弦 / BM25）。此前这里用候选集内 min-max
    # 相对值，导致同一字段在混合与单路模式下同名不同义，前端无法如实展示。
    raw_vec = dict(vec_pairs)
    raw_bm25 = dict(bm25_pairs)

    return [
        ScoredChunk(
            chunk_id=cid,
            score=round(value / max_rrf, 4) if max_rrf > 0 else 0.0,
            vec_score=round(v, 4) if (v := raw_vec.get(cid)) is not None else None,
            bm25_score=round(b, 4) if (b := raw_bm25.get(cid)) is not None else None,
            score_kind=SCORE_KIND_RRF,
        )
        for cid, value in ranked
    ]


# ─── 检索策略（策略模式）───────────────────────────────────────────────────────


class SearchStrategy(ABC):
    """检索策略抽象接口。"""

    name: str
    requires_embedding: bool = True

    @abstractmethod
    async def search(self, ctx: SearchContext, vector_store) -> list[ScoredChunk]:
        """执行检索，返回带分维度得分的 ScoredChunk 列表。"""
        ...

    def is_supported(self, vector_store) -> bool:
        """检查当前向量库是否支持此策略（默认返回 True）。"""
        return True


class VectorSearchStrategy(SearchStrategy):
    """向量检索——稠密语义相似度。"""

    name = "vector"

    async def search(self, ctx: SearchContext, vector_store) -> list[ScoredChunk]:
        pairs = await vector_store.similarity_search(
            ctx.kb_id, ctx.query_embedding, ctx.top_k
        )
        return [
            ScoredChunk(
                chunk_id=cid, score=round(s, 4), vec_score=round(s, 4),
                score_kind=SCORE_KIND_COSINE,
            )
            for cid, s in pairs
        ]


class BM25SearchStrategy(SearchStrategy):
    """BM25 检索——稀疏关键词。

    不需要查询向量：因此 embedding 服务不可用时纯 BM25 检索仍可用。
    """

    name = "bm25"
    requires_embedding = False

    async def search(self, ctx: SearchContext, vector_store) -> list[ScoredChunk]:
        pairs = await vector_store.bm25_search(
            ctx.kb_id, ctx.query_text, ctx.top_k, ctx.sparse_config,
        )
        return [
            ScoredChunk(
                chunk_id=cid, score=round(s, 4), bm25_score=round(s, 4),
                score_kind=SCORE_KIND_BM25,
            )
            for cid, s in pairs
        ]


class HybridSearchStrategy(SearchStrategy):
    """混合检索——向量 + BM25 加权 RRF 融合，保留各维度得分。"""

    name = "hybrid"

    async def search(self, ctx: SearchContext, vector_store) -> list[ScoredChunk]:
        vec_pairs = await vector_store.similarity_search(
            ctx.kb_id, ctx.query_embedding, ctx.top_k * 2,
        )
        bm25_pairs = await vector_store.bm25_search(
            ctx.kb_id, ctx.query_text, ctx.top_k * 2, ctx.sparse_config,
        )
        return _fuse_scores(vec_pairs, bm25_pairs, ctx.top_k, ctx.alpha)


# ─── 策略注册表（注册表模式）───────────────────────────────────────────────────


class SearchStrategyRegistry:
    """检索策略注册表——按 mode 名称查找策略。"""

    def __init__(self) -> None:
        self._strategies: dict[str, SearchStrategy] = {}

    def register(self, strategy: SearchStrategy) -> None:
        self._strategies[strategy.name] = strategy

    def get(self, name: str) -> SearchStrategy | None:
        return self._strategies.get(name)

    @property
    def supported_modes(self) -> list[str]:
        return list(self._strategies.keys())


def create_search_registry() -> SearchStrategyRegistry:
    """创建预注册三种策略的注册表。"""
    registry = SearchStrategyRegistry()
    registry.register(VectorSearchStrategy())
    registry.register(BM25SearchStrategy())
    registry.register(HybridSearchStrategy())
    return registry


# ─── 检索编排器（模板方法模式 + 外观模式）──────────────────────────────────────


class SearchOrchestrator:
    """检索编排器——模板方法骨架，将具体检索委托给策略。

    流程：解析知识库配置 → 按需向量化 → 策略检索（+候选扩充）→ 查询切片详情
    → 可选精排 → 组装响应。依赖通过构造函数注入，由 facade 在启动时组装。
    """

    def __init__(self, vector_store, embedding_model) -> None:
        self._vector_store = vector_store
        self._embedding_model = embedding_model
        self._embedding_cache: dict[tuple[str, str | None], object] = {}
        self._reranker_cache: dict[tuple[str | None, str | None], object] = {}
        self._registry = create_search_registry()

    async def search(
        self,
        db: AsyncSession,
        kb_id: str,
        request: SearchRequest,
    ) -> SearchResponse:
        """执行检索——模板方法。

        流程：校验 mode → 获取策略 → 向量化查询 → 执行检索 → 查询 chunk 详情 → 组装响应。
        """
        strategy = self._registry.get(request.mode)
        if strategy is None:
            valid = ", ".join(self._registry.supported_modes)
            raise ValueError(f"不支持的检索模式: {request.mode}，可选: {valid}")

        top_k = request.top_k
        kb_config = await self._load_kb_config(db, kb_id)

        # alpha：请求显式传入优先，否则用知识库配置的 hybrid_alpha
        alpha = request.alpha
        if alpha is None:
            alpha = _coerce_float(kb_config.get("hybrid_alpha"), DEFAULT_HYBRID_ALPHA)

        # 稀疏检索参数（sparse_algo / bm25_k1 / bm25_b）——此前从未被读取
        sparse_config = SparseConfig.from_config(kb_config)

        # 门槛：请求显式传入 > 知识库配置 > 系统默认
        min_similarity = request.min_similarity
        if min_similarity is None:
            min_similarity = _coerce_float(
                kb_config.get("min_similarity"), DEFAULT_MIN_SIMILARITY,
            )
        score_threshold = request.score_threshold
        if score_threshold is None:
            score_threshold = _coerce_float(
                kb_config.get("score_threshold"), DEFAULT_SCORE_THRESHOLD,
            )

        # 精排：启用则多召回候选再重排
        # rerank_requested 反映"配置要求精排"，rerank_applied 反映"是否真的生效"——
        # 两者分开返回，避免模型不可用/接口报错时用户以为精排已经起作用。
        # 请求级开关优先（高级检索面板 / 评测脚本用它做单次覆盖）
        enable_rerank = request.enable_rerank
        if enable_rerank is None:
            enable_rerank = kb_config.get("enable_reranker", True)
        rerank_requested = bool(enable_rerank)
        reranker = None
        if rerank_requested:
            # 只覆盖"是否启用"，reranker_model / provider 仍取知识库配置，
            # 否则请求级开关会顺带把用户选的模型换成默认模型。
            rerank_config = {**kb_config, "enable_reranker": True}
            reranker = await self._resolve_reranker(db, rerank_config)
        fetch_k = (
            min(max(top_k * RERANK_CANDIDATE_MULTIPLIER, top_k), MAX_RERANK_CANDIDATES)
            if reranker is not None
            else top_k
        )

        # 纯 BM25 不需要查询向量——embedding 服务不可用时仍可检索
        query_embedding: list[float] = []
        if strategy.requires_embedding:
            embedding_model = await self._resolve_embedding_model(db, kb_config)
            try:
                query_embedding = await embedding_model.aembed_query(request.query)
            except Exception:
                logger.exception("Query embedding failed")
                raise RuntimeError("查询向量化失败，请检查 Embedding 模型配置")

        # 构建上下文并执行策略
        ctx = SearchContext(
            kb_id=kb_id,
            query_text=request.query,
            query_embedding=query_embedding,
            top_k=fetch_k,
            alpha=alpha,
            sparse_config=sparse_config,
        )

        try:
            scored_chunks = await strategy.search(ctx, self._vector_store)
        except Exception:
            logger.exception("Search strategy '%s' failed for kb=%s", request.mode, kb_id)
            raise RuntimeError(f"检索执行失败: {request.mode}")

        if not scored_chunks:
            return SearchResponse(
                query=request.query, mode=request.mode, total=0, results=[],
                rerank_requested=rerank_requested, rerank_applied=False,
            )

        # 绝对门槛：最高余弦相似度低于门槛 → 判定「该库没有相关内容」并返回空。
        # 纯 BM25 模式没有余弦可比（BM25 分无上界，任何绝对值都没有意义），
        # 因此这类模式下不做绝对门槛，只用相对截断（见下）。
        max_cosine = max(
            (sc.vec_score for sc in scored_chunks if sc.vec_score is not None),
            default=None,
        )
        if (
            max_cosine is not None
            and min_similarity > 0
            and max_cosine < min_similarity
        ):
            logger.info(
                "判定无相关内容 kb=%s max_cosine=%.3f < %.3f，返回空结果",
                kb_id, max_cosine, min_similarity,
            )
            return SearchResponse(
                query=request.query, mode=request.mode, total=0, results=[],
                rerank_requested=rerank_requested, rerank_applied=False,
                score_kind=scored_chunks[0].score_kind,
                no_relevant_result=True,
                min_similarity=round(min_similarity, 4),
                filtered_count=len(scored_chunks),
            )

        # 查询 chunk 详情
        chunk_ids = [sc.chunk_id for sc in scored_chunks]
        sc_map = {sc.chunk_id: sc for sc in scored_chunks}

        try:
            chunk_dicts = await self._vector_store.get_chunks_by_ids(kb_id, chunk_ids)
        except Exception:
            logger.exception("Failed to fetch chunk details for kb=%s", kb_id)
            raise RuntimeError("查询分片详情失败")

        # 保留检索返回的顺序
        chunk_by_id = {c["id"]: c for c in chunk_dicts}
        ordered: list[tuple[ScoredChunk, dict]] = []
        for cid in chunk_ids:
            chunk = chunk_by_id.get(cid)
            sc = sc_map.get(cid)
            if chunk is None or sc is None:
                continue
            ordered.append((sc, chunk))

        # 精排（启用时）：对候选重排并截断到 top_k
        rerank_applied = False
        if reranker is not None and len(ordered) > 1:
            ordered, rerank_applied = await self._apply_rerank(
                reranker, request.query, ordered, top_k,
            )
        else:
            ordered = ordered[:top_k]

        results: list[ChunkMatch] = []
        for sc, chunk in ordered:
            page, section = _citation_fields(chunk)
            results.append(ChunkMatch(
                id=sc.chunk_id,
                doc_id=chunk.get("doc_id", ""),
                doc_name=chunk.get("doc_name", ""),
                chunk_index=chunk.get("chunk_index", 0),
                content=chunk.get("chunk_text", ""),
                score=sc.score,
                score_kind=sc.score_kind,
                vec_score=sc.vec_score,
                bm25_score=sc.bm25_score,
                page=page,
                section=section,
            ))

        # 相对截断（默认关闭）：丢掉与榜首差距过大的尾部结果。
        # 语义是"相对榜首"，因此对任何量纲都成立，不会像绝对阈值那样误伤。
        filtered = 0
        if score_threshold > 0 and results:
            top_score = max(r.score for r in results)
            floor = top_score * score_threshold
            kept = [r for r in results if r.score >= floor]
            filtered = len(results) - len(kept)
            results = kept

        return SearchResponse(
            query=request.query,
            mode=request.mode,
            total=len(results),
            results=results,
            rerank_requested=rerank_requested,
            rerank_applied=rerank_applied,
            score_kind=results[0].score_kind if results else "",
            min_similarity=round(min_similarity, 4) if max_cosine is not None else None,
            filtered_count=filtered,
        )

    async def _load_kb_config(self, db: AsyncSession, kb_id: str) -> dict:
        """读取知识库配置（检索参数与模型选择的来源）。"""
        from sqlalchemy import select

        from db.models.knowledge_base import KnowledgeBase

        kb = (
            await db.execute(select(KnowledgeBase).where(KnowledgeBase.id == kb_id))
        ).scalar_one_or_none()
        return dict(kb.config) if kb and isinstance(kb.config, dict) else {}

    async def _resolve_embedding_model(self, db: AsyncSession, kb_config: dict):
        """解析知识库配置的 embedding 模型（带缓存）；配置缺失时用默认实例。"""
        emb_model_name = kb_config.get("embedding_model")
        if not emb_model_name:
            return self._embedding_model

        cache_key = (emb_model_name, kb_config.get("embedding_provider_id"))
        cached = self._embedding_cache.get(cache_key)
        if cached is not None:
            return cached

        from api.knowledge_base.model_provider import load_embedding_model

        try:
            model = await load_embedding_model(
                db,
                model_name=emb_model_name,
                provider_id=kb_config.get("embedding_provider_id"),
            )
        except RuntimeError:
            logger.warning("知识库配置的 embedding 模型不可用，回退默认实例: %s", emb_model_name)
            model = self._embedding_model
        self._embedding_cache[cache_key] = model
        return model

    async def _resolve_reranker(self, db: AsyncSession, kb_config: dict):
        """解析知识库配置的 reranker；未启用或模型不可用时返回 ``None``。

        配置里**没有**该键时（旧库的配置 JSON 早于该字段）按"开启"处理——
        新建库的 schema 默认就是开启，否则同一份配置在新旧库上行为不一致。
        """
        enabled = kb_config.get("enable_reranker")
        if enabled is None:
            enabled = True
        if not enabled:
            return None

        model_name = kb_config.get("reranker_model")
        provider_id = kb_config.get("reranker_provider_id")
        cache_key = (model_name, provider_id)
        cached = self._reranker_cache.get(cache_key)
        if cached is not None:
            return cached

        from api.knowledge_base.model_provider import load_reranker_model

        try:
            reranker = await load_reranker_model(
                db, model_name=model_name, provider_id=provider_id,
            )
        except RuntimeError as exc:
            logger.warning("知识库启用了重排序但模型不可用，本次跳过精排: %s", exc)
            return None
        self._reranker_cache[cache_key] = reranker
        return reranker

    async def _apply_rerank(
        self,
        reranker,
        query: str,
        ordered: list[tuple[ScoredChunk, dict]],
        top_k: int,
    ) -> tuple[list[tuple[ScoredChunk, dict]], bool]:
        """用 reranker 重排候选；调用失败时保留原顺序。

        精排只是"锦上添花"，任何异常都不应让整次检索失败——但必须如实告诉调用方
        有没有生效（返回 ``applied``），否则用户会以为结果是精排后的。

        Returns:
            ``(重排后的候选, 是否实际生效)``。
        """
        documents = [chunk.get("chunk_text", "") for _, chunk in ordered]
        ranked = await reranker.rerank(query, documents, top_n=top_k)
        if not ranked:
            logger.info("重排序未返回结果，沿用召回顺序")
            return ordered[:top_k], False

        reranked: list[tuple[ScoredChunk, dict]] = []
        for index, score in ranked:
            if not (0 <= index < len(ordered)):
                continue
            original, chunk = ordered[index]
            reranked.append((
                ScoredChunk(
                    chunk_id=original.chunk_id,
                    score=round(float(score), 4),
                    vec_score=original.vec_score,
                    bm25_score=original.bm25_score,
                    score_kind=SCORE_KIND_RERANK,
                ),
                chunk,
            ))
        if not reranked:
            return ordered[:top_k], False

        # 精排服务可能只返回部分候选：补回未返回的项，保证结果条数不少于召回
        # 顺序下应有的条数（此前只在"完全为空"时兜底，条数会莫名变少）。
        seen = {sc.chunk_id for sc, _ in reranked}
        for original, chunk in ordered:
            if len(reranked) >= top_k:
                break
            if original.chunk_id not in seen:
                reranked.append((original, chunk))
        return reranked[:top_k], True

    def is_search_supported(self) -> bool:
        """快速检测当前向量库是否支持搜索功能。

        通过尝试用空查询调用 bm25_search 检测。Milvus 后端返回空且无异常。
        更准确的检测需在实际检索中判断，此处做轻量检查。
        """
        return True


# ─── 模块级单例 ──────────────────────────────────────────────────────────────

_orchestrator: SearchOrchestrator | None = None


def set_search_orchestrator(orch: SearchOrchestrator) -> None:
    """注入检索编排器单例，由 server.py 在启动时调用。"""
    global _orchestrator
    _orchestrator = orch


def get_search_orchestrator() -> SearchOrchestrator | None:
    """获取检索编排器单例，供 Tool 函数等非请求上下文使用。"""
    return _orchestrator
