"""文档索引状态机——状态模式。

定义文档在索引流水线中的 8 种状态及其转换规则。
"""

from __future__ import annotations

import asyncio
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Awaitable, Callable

if TYPE_CHECKING:
    from api.knowledge_base.doc_service import IndexingPipeline
    from core.rag.splitters import ChunkStrategyRegistry

logger = logging.getLogger(__name__)

#: 各阶段「进入时」的累计进度（百分比）——进度口径的**唯一事实来源**。
#: 状态机写库、``compute_stages`` 的阶段百分比、前端进度条都以此为准。
#: 此前状态机写字面量（3/15/30/55/70/100），而 doc_service.STAGE_PROGRESS 另有一套
#: 错位一档的值（extracting=85、bm25=70），同一文档在两处显示不同进度。
STAGE_PROGRESS: dict[str, int] = {
    "queued": 0,
    "parsing": 3,
    "chunking": 15,
    "embedding": 30,
    "bm25": 55,
    "extracting": 70,
    "indexed": 100,
}


#: 图谱抽取的默认预算（秒）——必须**明显小于**流水线的阶段超时，否则内层还没到点，
#: 外层 wait_for 先把整个阶段取消掉，文档又会被判失败（正是要修的问题）。
DEFAULT_GRAPH_TIMEOUT_SECONDS = 300.0

#: 内层预算与外层阶段超时之间保留的余量（秒）
_GRAPH_TIMEOUT_MARGIN = 30.0


def _graph_extract_timeout(stage_timeout: float | None) -> float:
    """图谱抽取的预算：取默认值与"阶段超时减余量"中较小者。

    保证内层一定先于外层触发——超时要走 graph_error 分支，而不是让流水线把整篇
    文档判失败。
    """
    if stage_timeout is None or stage_timeout <= 0:
        return DEFAULT_GRAPH_TIMEOUT_SECONDS
    return max(1.0, min(DEFAULT_GRAPH_TIMEOUT_SECONDS, stage_timeout - _GRAPH_TIMEOUT_MARGIN))


def is_graph_enabled(config: dict | None) -> bool:
    """判断是否启用知识图谱抽取（默认启用）。

    仅当配置里**显式**为 ``False`` 时关闭。此前的写法是
    ``config.get("enable_graph") or config.get("enableGraph")`` —— 当
    ``enable_graph=False`` 时表达式短路成 ``None``，再与 ``is not False`` 比较
    恒为真，导致前端关掉开关仍会执行 LLM 抽取。
    """
    config = config or {}
    for key in ("enable_graph", "enableGraph"):
        if key in config:
            return config[key] is not False and bool(config[key])
    return True


@dataclass
class IndexingContext:
    """索引上下文——状态模式中的 Context 角色。

    持有当前文档的索引状态、阶段产物，以及各阶段的执行回调。
    """
    doc_id: str
    kb_id: str
    file_path: str
    file_type: str
    config: dict
    #: 写入目标物理集合（重建期间为临时集合名）；None 表示写正式集合
    target_collection: str | None = None

    current_state: DocState | None = None
    status: str = "queued"
    progress: int = 0
    error_message: str | None = None

    documents: list = field(default_factory=list)
    chunks: list = field(default_factory=list)
    #: 已写入向量库的切片数（分批写入时用于核对"写全了没有"）
    written_chunks: int = 0
    entities_count: int = 0
    relations_count: int = 0
    #: 图谱抽取失败的原因——抽取失败不影响文档索引成功，但必须让用户看得见
    #: （此前异常被吞掉后文档直接标记 indexed，界面上无法区分"没抽到"与"抽取崩了"）
    graph_error: str | None = None

    embedding_model: Any | None = None
    chunk_registry: ChunkStrategyRegistry | None = None
    #: 实际使用的切片策略——流水线可能在 agentic 不可用时回退为 recursive
    chunk_strategy: str | None = None

    on_status_change: Callable[[IndexingContext], Awaitable[None]] | None = None

    async def transition_to(self, state: DocState, status: str, progress: int) -> None:
        self.current_state = state
        self.status = status
        self.progress = progress
        if self.on_status_change:
            await self.on_status_change(self)

    async def fail(self, error: str) -> None:
        """标记失败。

        进度**保留中断时点的真实值**（历史上写死 -1）：`compute_stages` 用它反查
        中断发生在哪个阶段，否则只能从错误文案里猜关键词（英文阶段名一条都猜不中，
        于是任何超时都显示"解析阶段失败"）。``-1`` 也曾在界面上被渲染成 "-1%"。
        """
        self.error_message = error
        await self.transition_to(FailedState(), "failed", max(0, self.progress))


class DocState(ABC):
    """文档索引状态抽象接口。"""

    name: str

    @abstractmethod
    async def handle(self, ctx: IndexingContext, pipeline: IndexingPipeline) -> None:
        """执行当前状态的处理逻辑。"""
        ...


class QueuedState(DocState):
    name = "queued"

    async def handle(self, ctx: IndexingContext, pipeline: IndexingPipeline) -> None:
        await ctx.transition_to(ParsingState(), "parsing", STAGE_PROGRESS["parsing"])


class ParsingState(DocState):
    name = "parsing"

    async def handle(self, ctx: IndexingContext, pipeline: IndexingPipeline) -> None:
        try:
            # 解析是**同步 CPU/IO 密集**的（PDF 抽取、DOCX 解压、unstructured
            # 本地推理），一个 500MB 的 PDF 能把事件循环按住好几秒——期间所有
            # HTTP 请求、SSE 推送、健康检查全部停摆。丢到线程池。
            ctx.documents = await asyncio.to_thread(
                pipeline.loader_registry.load, ctx.file_path, ctx.file_type,
            )
            await ctx.transition_to(ChunkingState(), "chunking", STAGE_PROGRESS["chunking"])
        except Exception as e:
            await ctx.fail(f"文档解析失败: {e}")


class ChunkingState(DocState):
    name = "chunking"

    async def handle(self, ctx: IndexingContext, pipeline: IndexingPipeline) -> None:
        try:
            strategy_name = (
                ctx.chunk_strategy
                or ctx.config.get("chunk_strategy")
                or "recursive"
            )
            chunk_reg = ctx.chunk_registry or pipeline.chunk_registry
            # 走异步路径：agentic 会调用 LLM，不能阻塞事件循环
            ctx.chunks = await chunk_reg.async_split(strategy_name, ctx.documents)
            await ctx.transition_to(EmbeddingState(), "embedding", STAGE_PROGRESS["embedding"])
        except Exception as e:
            await ctx.fail(f"文本切片失败: {e}")


def _prepare_chunks_for_write(chunks: list, ctx: IndexingContext, start_index: int) -> None:
    """写入向量库前，把文档级与定位类元数据补进每个切片。

    抽成独立函数是为了"embed 一批、写一批"：写哪批就准备哪批，不必等全部切片都
    准备完（元数据的注入是逐切片幂等的，分批调用结果与一次性调用一致）。

    ``start_index`` 是本批在整篇文档里的起始切片号。分批是**并发**的，回调完成顺序
    与批次顺序不一定一致，因此索引号必须由批次的**位置**推导，不能用"已写入计数"
    递增——那样并发乱序时会把编号写串（切片顺序与 prev/next 都会错）。
    """
    doc_name = ctx.file_path.replace("\\", "/").rsplit("/", 1)[-1]
    header_keys = {"h1", "h2", "h3", "h4", "h5", "h6"}
    #: 位置类元数据——写入向量库的 metadata_，供引用定位（页码/章节）使用。
    #: 此前只保留标题层级，loader 提供的 page 被丢弃，检索结果无法给出页码。
    position_keys = ("page", "page_ref", "section", "source")
    #: 父子块（Small-to-Big）的父块信息——必须一起落库，否则检索侧拿不到
    #: 父块正文，"命中子块返回父块"就退化成返回子块。
    parent_keys = ("parent_id", "parent_index", "parent_text")

    for offset, chunk in enumerate(chunks):
        if not chunk.metadata.get("doc_id"):
            chunk.metadata["doc_id"] = ctx.doc_id
        # 索引号一律以最终切片顺序为准（全局递增）：
        # 此前用 `if not chunk.metadata.get("chunk_index")` 判断，既把 0 当成
        # "缺失"，又保留了 splitter 按"单个 Document 内部"编号的结果——多页
        # PDF / 多段 Markdown 会各自从 0 开始，编号互相碰撞，导致切片排序与
        # 前后文（prev/next）取错。
        chunk.metadata["chunk_index"] = start_index + offset
        chunk.metadata["doc_name"] = doc_name
        chunk.metadata["doc_type"] = ctx.file_type
        extra_meta = chunk.metadata.get("metadata_", {})
        for k in header_keys:
            if k in chunk.metadata:
                extra_meta[k] = chunk.metadata[k]
        for k in position_keys:
            if k in chunk.metadata:
                extra_meta[k] = chunk.metadata[k]
        for k in parent_keys:
            if k in chunk.metadata:
                extra_meta[k] = chunk.metadata[k]
        chunk.metadata["metadata_"] = extra_meta


class EmbeddingState(DocState):
    """向量化**并写入**——embed 一批就写一批。

    为什么合并成一步：全量向量（1024 维 float，约 8KB/片）一次性算完再写，峰值内存
    与文档规模成正比（10 万片 ≈ 800MB，只这一项就够 OOM）。分批后峰值内存只与
    **单批**（10 条）相关，与文档大小无关。

    写完后才推进 "bm25" 阶段：原生稀疏索引由 Milvus 在写入时通过 BM25 Function
    生成（见 T4.2），因此"稀疏索引"这一步的时机就是写入完成。
    """

    name = "embedding"

    async def handle(self, ctx: IndexingContext, pipeline: IndexingPipeline) -> None:
        try:
            emb_model = ctx.embedding_model or pipeline.embedding_model
            texts = [chunk.page_content for chunk in ctx.chunks]

            async def write_batch(start: int, batch_texts: list[str], vectors: list) -> None:
                batch_chunks = ctx.chunks[start:start + len(batch_texts)]
                _prepare_chunks_for_write(batch_chunks, ctx, start)
                await pipeline.vector_store.add_documents(
                    ctx.kb_id, batch_chunks, vectors,
                    target=ctx.target_collection,
                )
                ctx.written_chunks += len(batch_chunks)

            await emb_model.aembed_documents(texts, on_batch=write_batch)
            await ctx.transition_to(BM25State(), "bm25", STAGE_PROGRESS["bm25"])
        except Exception as e:
            await ctx.fail(f"向量化失败: {e}")


class BM25State(DocState):
    """稀疏索引阶段——原生索引在写入时已由 Milvus 的 BM25 Function 生成，这里收口。

    分批写入把"向量化"与"落库"合并成了一步（见 :class:`EmbeddingState`），因此本阶段
    只剩两件事：

    1. 确认**该写的切片都写进去了**——写入中途失败会让文档只入库一部分，这属于必须
       暴露的失败，而不是"记个日志继续走"；
    2. **按最终切片数裁掉尾部残留**——幂等键是 (doc_id, chunk_index)，文档变短时上次
       多出来的高编号切片不会被覆盖，会以旧内容继续被检索到。裁剪必须等全部分批写完
       再做（分批并发、完成顺序不定，按单批编号裁会误删别的批次）。
    """

    name = "bm25"

    async def handle(self, ctx: IndexingContext, pipeline: IndexingPipeline) -> None:
        import logging
        _logger = logging.getLogger(__name__)
        try:
            if ctx.written_chunks != len(ctx.chunks):
                raise RuntimeError(
                    f"切片写入不完整：应写 {len(ctx.chunks)} 片，实际写入 {ctx.written_chunks} 片",
                )
            await pipeline.vector_store.prune_document_tail(
                ctx.kb_id, ctx.doc_id, ctx.written_chunks, target=ctx.target_collection,
            )
            # 整篇文档写完 flush 一次，且**不因它失败**：flush 只是可见性优化
            # （数据早已在库里），被限流或服务端繁忙时不该拖垮一篇文档。
            await pipeline.vector_store.flush_collection(
                ctx.kb_id, target=ctx.target_collection, timeout=30.0,
            )
            await ctx.transition_to(ExtractingState(), "extracting", STAGE_PROGRESS["extracting"])
        except Exception as e:
            _logger.exception("BM25 add_documents failed for doc=%s kb=%s", ctx.doc_id, ctx.kb_id)
            await ctx.fail(f"BM25 索引失败: {e}")


class ExtractingState(DocState):
    """实体关系抽取——**失败与超时都不影响文档索引成功**。

    这一步跑在切片**已经写入向量库之后**，因此无论它怎么结束，文档都是可检索的。
    此前只有"抛异常"被当作非致命，而"跑太久"会撞上流水线的阶段超时，把整篇文档
    标记为 failed——实测一次重建里 7 篇文档有 3 篇因此失败（图谱抽取 600s 没跑完），
    用户的库里凭空少了 3 篇文档的检索结果，且重试要从头再向量化一遍。

    现在给抽取单独设预算：**超时与失败一律记入 `graph_error`**，文档照常 indexed。
    图谱是增强项，索引才是产品；用丢失检索能力去换图谱完整性是明显不划算的。
    """

    name = "extracting"

    async def handle(self, ctx: IndexingContext, pipeline: IndexingPipeline) -> None:
        import logging
        _logger = logging.getLogger(__name__)
        try:
            if is_graph_enabled(ctx.config):
                _logger.info("Running graph extraction for doc=%s", ctx.doc_id)
                entity_model = (
                    ctx.config.get("entity_model") or ctx.config.get("entityModel")
                )
                budget = _graph_extract_timeout(getattr(pipeline, "stage_timeout", None))
                entities, relations = await asyncio.wait_for(
                    pipeline.graph_service.extract_entities_and_relations(
                        ctx.kb_id,
                        ctx.doc_id,
                        ctx.chunks,
                        model_name=entity_model,
                    ),
                    timeout=budget,
                )
                ctx.entities_count = len(entities)
                ctx.relations_count = len(relations)
            else:
                _logger.info("Graph extraction disabled for doc=%s", ctx.doc_id)
            await ctx.transition_to(IndexedState(), "indexed", STAGE_PROGRESS["indexed"])
        except (TimeoutError, asyncio.CancelledError) as exc:
            budget = _graph_extract_timeout(getattr(pipeline, "stage_timeout", None))
            _logger.warning("Graph extraction timed out for doc=%s", ctx.doc_id)
            ctx.graph_error = (
                f"图谱抽取超时（超过 {budget:g} 秒）——文档已完成索引与检索，"
                "仅图谱未生成；可稍后重试该文档补抽"
            )
            await ctx.transition_to(IndexedState(), "indexed", STAGE_PROGRESS["indexed"])
        except Exception as exc:
            _logger.exception("Entity extraction failed for doc=%s", ctx.doc_id)
            # 抽取失败不阻塞索引——文档仍然标记为已索引，但把原因记下来，
            # 由观察者写入文档的 graph_error 字段，避免"静默无图谱"。
            ctx.graph_error = f"图谱抽取失败: {exc}"
            await ctx.transition_to(IndexedState(), "indexed", STAGE_PROGRESS["indexed"])


class IndexedState(DocState):
    name = "indexed"

    async def handle(self, ctx: IndexingContext, pipeline: IndexingPipeline) -> None:
        pass


class FailedState(DocState):
    name = "failed"

    async def handle(self, ctx: IndexingContext, pipeline: IndexingPipeline) -> None:
        pass
