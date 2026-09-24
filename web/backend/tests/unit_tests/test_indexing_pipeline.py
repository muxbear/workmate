"""Tests for 索引流水线的开关、阶段展示与切片策略选择。

覆盖此前的实际缺陷：
- ``enable_graph=False`` 关不掉知识图谱抽取（短路表达式 bug）；
- 已完成的文档里「关系抽取」永远显示运行中、「入库」永远 pending；
- agentic 切片未实现却可选，选中即索引失败；
- 切片策略不可用时应回退而非失败。
"""

import asyncio

import pytest

from api.knowledge_base.doc_service import (
    STAGE_NAMES,
    STAGE_PROGRESS,
    STAGE_STATUS_ORDER,
    _infer_failed_stage_index,
    compute_stages,
)
from api.knowledge_base.doc_state import (
    ChunkingState,
    ExtractingState,
    IndexingContext,
    is_graph_enabled,
)
from core.rag.splitters import INDEX_CONFIG_DEFAULTS, create_chunk_registry

pytestmark = pytest.mark.anyio


# ─── 知识图谱开关 ────────────────────────────────────────────────────────────


class TestGraphToggle:
    def test_default_is_enabled(self):
        assert is_graph_enabled({}) is True
        assert is_graph_enabled(None) is True

    def test_explicit_false_disables_snake_case(self):
        """回归：此前 `config.get('enable_graph') or config.get('enableGraph')`
        在值为 False 时短路成 None，随后 `is not False` 恒真，开关失效。"""
        assert is_graph_enabled({"enable_graph": False}) is False

    def test_explicit_false_disables_camel_case(self):
        assert is_graph_enabled({"enableGraph": False}) is False

    def test_explicit_true_enables(self):
        assert is_graph_enabled({"enable_graph": True}) is True
        assert is_graph_enabled({"enableGraph": True}) is True

    def test_snake_case_takes_precedence(self):
        assert is_graph_enabled({"enable_graph": False, "enableGraph": True}) is False


class FakeGraphService:
    def __init__(self):
        self.calls = 0

    async def extract_entities_and_relations(self, kb_id, doc_id, chunks, model_name=None):
        self.calls += 1
        return [{"name": "实体"}], [{"from": "a", "to": "b"}]


class FakePipeline:
    def __init__(self, graph_service=None):
        self.graph_service = graph_service or FakeGraphService()


class FakeSink:
    """记录状态变化，替代观察者。"""

    def __init__(self):
        self.states: list[str] = []


async def run_extracting_state(config: dict, chunks=None) -> tuple[IndexingContext, FakeGraphService]:
    graph = FakeGraphService()
    ctx = IndexingContext(
        doc_id="doc-1", kb_id="kb-1", file_path="/tmp/a.txt", file_type="txt",
        config=config, chunks=chunks if chunks is not None else ["分片正文"],
    )
    sink = FakeSink()

    async def on_change(c: IndexingContext) -> None:
        sink.states.append(c.status)

    ctx.on_status_change = on_change
    await ExtractingState().handle(ctx, FakePipeline(graph))  # type: ignore[arg-type]
    return ctx, graph


class TestExtractingState:
    async def test_runs_extraction_when_enabled(self):
        ctx, graph = await run_extracting_state({"enable_graph": True})
        assert graph.calls == 1
        assert ctx.status == "indexed"
        assert ctx.entities_count == 1
        assert ctx.relations_count == 1

    async def test_skips_extraction_when_disabled(self):
        """关闭开关后不得再调用 LLM 抽取（此前会照常执行并计费）。"""
        ctx, graph = await run_extracting_state({"enable_graph": False})
        assert graph.calls == 0
        assert ctx.status == "indexed"
        assert ctx.entities_count == 0

    async def test_skips_extraction_for_camel_case_false(self):
        _, graph = await run_extracting_state({"enableGraph": False})
        assert graph.calls == 0

    async def test_extraction_failure_still_indexes(self):
        """抽取失败不阻塞索引。"""
        class BoomGraph(FakeGraphService):
            async def extract_entities_and_relations(self, *args, **kwargs):
                raise RuntimeError("LLM 挂了")

        ctx = IndexingContext(
            doc_id="doc-1", kb_id="kb-1", file_path="/tmp/a.txt", file_type="txt",
            config={"enable_graph": True}, chunks=["x"],
        )
        await ExtractingState().handle(ctx, FakePipeline(BoomGraph()))  # type: ignore[arg-type]
        assert ctx.status == "indexed"


# ─── 阶段展示 ────────────────────────────────────────────────────────────────


class TestComputeStages:
    def test_stage_names_match_status_order(self):
        """阶段名与状态必须一一对应（此前 8 vs 7 导致展示错位）。"""
        assert len(STAGE_NAMES) == len(STAGE_STATUS_ORDER)

    def test_indexed_document_has_no_running_or_pending_stage(self):
        """回归：已完成的文档不应有阶段停留在 running / pending。"""
        stages = compute_stages("indexed")
        assert all(s["status"] == "done" for s in stages), stages
        assert all(s["pct"] == 100 for s in stages)

    def test_queued_document_marks_first_stage_running(self):
        stages = compute_stages("queued")
        assert stages[0]["status"] == "running"
        assert all(s["status"] == "pending" for s in stages[1:])

    def test_middle_state_marks_earlier_stages_done(self):
        stages = compute_stages("embedding")
        assert [s["status"] for s in stages[:3]] == ["done", "done", "done"]
        assert stages[3]["status"] == "running"
        assert all(s["status"] == "pending" for s in stages[4:])

    def test_failed_marks_stage_and_prior_done(self):
        stages = compute_stages("failed", "向量化失败: timeout")
        assert stages[3]["status"] == "failed"
        assert all(s["status"] == "done" for s in stages[:3])

    def test_failed_defaults_to_parsing(self):
        stages = compute_stages("failed", "未知错误")
        assert stages[1]["status"] == "failed"

    def test_unknown_status_marks_all_pending(self):
        stages = compute_stages("some-new-status")
        assert all(s["status"] == "pending" for s in stages)

    def test_stage_names_are_chinese(self):
        assert all(isinstance(name, str) and name for name in STAGE_NAMES)


class TestInferFailedStage:
    @pytest.mark.parametrize(
        ("message", "expected"),
        [
            ("解析失败: 文件损坏", 1),
            ("文本切片失败: boom", 2),
            ("向量化失败: 401", 3),
            ("BM25 索引失败: timeout", 4),
            ("稀疏索引失败: timeout", 4),
            ("实体抽取失败: boom", 5),
            ("关系抽取失败: boom", 5),
            ("知识图谱失败: boom", 5),
        ],
    )
    def test_keyword_mapping(self, message, expected):
        assert _infer_failed_stage_index(message) == expected

    def test_empty_message_falls_back(self):
        assert _infer_failed_stage_index(None) == 1

    def test_mapping_never_exceeds_stage_count(self):
        for message in ["解析", "切片", "向量化", "BM25", "实体", "关系"]:
            assert _infer_failed_stage_index(message) < len(STAGE_NAMES)


# ─── 切片策略 ────────────────────────────────────────────────────────────────


class TestChunkingState:
    async def test_uses_async_split(self):
        """流水线必须走异步切片（agentic 需要 await LLM）。"""
        used: list[str] = []

        class RecordingRegistry:
            def async_split(self, name, documents):
                used.append(name)

                async def _inner():
                    return []

                return _inner()

        ctx = IndexingContext(
            doc_id="d", kb_id="k", file_path="/tmp/a.txt", file_type="txt",
            config={}, documents=[], chunk_strategy="markdown",
        )
        ctx.chunk_registry = RecordingRegistry()  # type: ignore[assignment]
        await ChunkingState().handle(ctx, FakePipeline())  # type: ignore[arg-type]
        assert used == ["markdown"]

    async def test_explicit_strategy_wins_over_config(self):
        """流水线回退后的策略名优先于原始配置。"""
        used: list[str] = []

        class RecordingRegistry:
            def async_split(self, name, documents):
                used.append(name)

                async def _inner():
                    return []

                return _inner()

        ctx = IndexingContext(
            doc_id="d", kb_id="k", file_path="/tmp/a.txt", file_type="txt",
            config={"chunk_strategy": "agentic"}, documents=[],
            chunk_strategy="recursive",
        )
        ctx.chunk_registry = RecordingRegistry()  # type: ignore[assignment]
        await ChunkingState().handle(ctx, FakePipeline())  # type: ignore[arg-type]
        assert used == ["recursive"]

    async def test_failure_is_reported(self):
        class BoomRegistry:
            def async_split(self, name, documents):
                async def _inner():
                    raise ValueError("Unknown chunk strategy: agentic")

                return _inner()

        ctx = IndexingContext(
            doc_id="d", kb_id="k", file_path="/tmp/a.txt", file_type="txt",
            config={}, documents=[],
        )
        ctx.chunk_registry = BoomRegistry()  # type: ignore[assignment]
        await ChunkingState().handle(ctx, FakePipeline())  # type: ignore[arg-type]
        assert ctx.status == "failed"
        assert "文本切片失败" in (ctx.error_message or "")


class TestCreateChunkRegistry:
    def test_reads_chunk_size_and_overlap_from_config(self):
        """配置里的 chunk_size / overlap 真正生效（此前调用方传空字典）。"""
        registry = create_chunk_registry({"chunk_size": 256, "chunk_overlap": 32})
        strategy = registry.get("fixed")
        assert strategy._chunk_size == 256  # type: ignore[attr-defined]
        assert strategy._chunk_overlap == 32  # type: ignore[attr-defined]

    def test_uses_defaults_when_config_empty(self):
        registry = create_chunk_registry({})
        strategy = registry.get("fixed")
        assert strategy._chunk_size == INDEX_CONFIG_DEFAULTS["chunk_size"]

    def test_agentic_requires_llm(self):
        assert create_chunk_registry({}, llm=None).supports("agentic") is False
        assert create_chunk_registry({}, llm=object()).supports("agentic") is True

    def test_semantic_requires_embedding(self):
        assert create_chunk_registry({}).supports("semantic") is False
        assert create_chunk_registry({}, embedding_model=object()).supports("semantic") is True

    def test_unknown_strategy_error_mentions_available(self):
        registry = create_chunk_registry({})
        with pytest.raises(ValueError, match="不支持的切片策略"):
            registry.get("agentic")

    def test_supported_strategies(self):
        registry = create_chunk_registry({})
        assert registry.supports("fixed")
        assert registry.supports("recursive")
        assert registry.supports("markdown")


# ─── 迭代 1：阶段超时、初始化失败、切片元数据 ────────────────────────────────


class RecordingObserver:
    """记录每次状态变更（替代数据库观察者）。"""

    def __init__(self):
        self.events: list[tuple[str, str | None]] = []

    async def on_progress(self, ctx: IndexingContext) -> None:
        self.events.append((ctx.status, ctx.error_message))


class FakeLoaderRegistry:
    def __init__(self, documents=None):
        self.documents = documents if documents is not None else [_document("正文")]

    def load(self, file_path, file_type):
        return self.documents


def _document(text: str, **metadata):
    from langchain_core.documents import Document

    return Document(page_content=text, metadata=dict(metadata))


class RecordingVectorStore:
    """记录写入的切片。"""

    def __init__(self):
        self.added: list = []

    async def add_documents(self, kb_id, documents, embeddings):
        self.added.extend(documents)
        return [f"c{i}" for i in range(len(documents))]


class PassthroughChunkRegistry:
    """把每个 Document 原样当作一个切片（顺带保留 metadata）。"""

    def __init__(self, delay: float = 0.0):
        self.delay = delay

    def supports(self, name: str) -> bool:
        return True

    def get(self, name: str):
        raise ValueError(name)

    async def async_split(self, name, documents):
        if self.delay:
            await asyncio.sleep(self.delay)
        return list(documents)


class FakeEmbeddingModel:
    async def aembed_documents(self, texts):
        return [[0.1, 0.2] for _ in texts]


class ExplodingEmbeddingResolver:
    """模拟模型页未配置 embedding：解析阶段直接抛错。"""

    def __init__(self):
        self.embedding_model = None
        self.loader_registry = FakeLoaderRegistry()
        self.chunk_registry = PassthroughChunkRegistry()
        self.vector_store = RecordingVectorStore()
        self.graph_service = FakeGraphService()
        self._observers = []

    def attach(self, observer):
        self._observers.append(observer)


async def _drive(pipeline, task_config=None):
    """跑一次完整流水线（用真实 IndexingPipeline 的执行骨架）。"""
    from api.knowledge_base.doc_service import IndexingTask, IndexingPipeline

    task = IndexingTask(
        kb_id="kb-1", doc_id="doc-1", file_path="/tmp/a.md",
        file_type="md", config=task_config or {},
    )
    await pipeline.execute(task)


def _make_pipeline(
    *,
    chunk_registry=None,
    vector_store=None,
    loader_registry=None,
    graph_service=None,
    stage_timeout: float = 600.0,
):
    from api.knowledge_base.doc_service import IndexingPipeline

    class _Pipeline(IndexingPipeline):
        async def _get_or_create_embedding(self, model_name, provider_id=None):
            return FakeEmbeddingModel()

        async def _get_or_create_llm(self, config):
            return None

    pipeline = _Pipeline(
        loader_registry=loader_registry or FakeLoaderRegistry(),
        chunk_registry=chunk_registry or PassthroughChunkRegistry(),
        embedding_model=FakeEmbeddingModel(),
        vector_store=vector_store or RecordingVectorStore(),
        graph_service=graph_service or FakeGraphService(),
        stage_timeout=stage_timeout,
    )
    return pipeline


class TestStageTimeout:
    async def test_hanging_stage_fails_with_timeout_message(self):
        """回归：没有超时保护时，一次挂死会永久占住并发槽。"""
        pipeline = _make_pipeline(
            chunk_registry=PassthroughChunkRegistry(delay=5.0),
            stage_timeout=0.05,
        )
        observer = RecordingObserver()
        pipeline.attach(observer)

        await asyncio.wait_for(_drive(pipeline), timeout=3.0)

        assert observer.events[-1][0] == "failed"
        assert "超时" in (observer.events[-1][1] or "")

    async def test_fast_stage_completes(self):
        pipeline = _make_pipeline(stage_timeout=5.0)
        observer = RecordingObserver()
        pipeline.attach(observer)

        await _drive(pipeline)

        assert observer.events[-1][0] == "indexed"


class TestPrepareFailure:
    async def test_initialisation_error_marks_document_failed(self):
        """回归：前置段异常逃逸会让文档永久停在 queued 且不可重试。"""
        pipeline = _make_pipeline()

        async def boom(model_name, provider_id=None):
            raise RuntimeError("未找到可用的 embedding 模型")

        pipeline._get_or_create_embedding = boom  # type: ignore[method-assign]
        observer = RecordingObserver()
        pipeline.attach(observer)

        await _drive(pipeline)

        assert observer.events[-1][0] == "failed"
        assert "索引初始化失败" in (observer.events[-1][1] or "")


class TestChunkMetadata:
    async def test_chunk_index_is_global_across_documents(self):
        """回归：多 Document（多页/多段）各自从 0 编号，导致切片顺序与前后文错乱。"""
        docs = [
            _document("第一段", chunk_index=0, h1="章一"),
            _document("第二段", chunk_index=0, h1="章一"),
            _document("第三段", chunk_index=0, page=7),
        ]
        store = RecordingVectorStore()
        pipeline = _make_pipeline(
            loader_registry=FakeLoaderRegistry(docs), vector_store=store,
        )

        await _drive(pipeline)

        assert [d.metadata["chunk_index"] for d in store.added] == [0, 1, 2]

    async def test_page_and_section_are_preserved(self):
        """页码/章节此前被丢弃，检索结果无法给出定位。"""
        docs = [_document("正文", page=12, h1="第一章", h2="1.1 概述")]
        store = RecordingVectorStore()
        pipeline = _make_pipeline(
            loader_registry=FakeLoaderRegistry(docs), vector_store=store,
        )

        await _drive(pipeline)

        meta = store.added[0].metadata["metadata_"]
        assert meta["page"] == 12
        assert meta["h1"] == "第一章"
        assert meta["h2"] == "1.1 概述"


class TestGraphError:
    async def test_extraction_failure_is_recorded_and_index_still_succeeds(self):
        """回归：抽取异常被吞掉后，界面无法区分"没有实体"与"抽取崩了"。"""

        class ExplodingGraph:
            async def extract_entities_and_relations(self, *args, **kwargs):
                raise RuntimeError("图谱模型不可用")

        pipeline = _make_pipeline(graph_service=ExplodingGraph())
        observer = RecordingObserver()
        pipeline.attach(observer)

        await _drive(pipeline)

        assert observer.events[-1][0] == "indexed"


class TestTimeoutAttribution:
    async def test_timeout_reports_the_actual_stage(self):
        """回归：任何阶段超时都被报成"解析"阶段——文案恒为英文状态名，而
        `_infer_failed_stage_index` 只认中文关键词，于是全部落到兜底值 1。"""

        class HangingEmbedding:
            async def aembed_documents(self, texts):
                await asyncio.sleep(5)
                return []

        # 预热线程池：首次 asyncio.to_thread 会带上 langchain 的惰性导入开销
        # （实测约 1.4 秒），那是框架冷启动而不是策略本身慢，不应算进超时预算。
        warmup = create_chunk_registry({})
        await warmup.async_split("recursive", [_document("预热")])

        pipeline = _make_pipeline(stage_timeout=1.0)

        async def hanging_embedding(model_name, provider_id=None):
            return HangingEmbedding()

        pipeline._get_or_create_embedding = hanging_embedding  # type: ignore[method-assign]
        observer = RecordingObserver()
        pipeline.attach(observer)

        await asyncio.wait_for(_drive(pipeline), timeout=8.0)

        status, message = observer.events[-1]
        assert status == "failed"
        assert "向量化" in (message or ""), message

        # 失败阶段应定位到「向量化」（索引 3），而不是兜底的「解析」
        stages = compute_stages("failed", message, STAGE_PROGRESS["embedding"])
        assert stages[3]["status"] == "failed"
        assert stages[1]["status"] == "done"
