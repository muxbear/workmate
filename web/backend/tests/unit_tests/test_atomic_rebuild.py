"""重建期间旧数据全程可检索（迭代 4 T4.5 的原子重建）。

此前重建是"先清空、再索引"：从清空到索引完成之间，库里查不到任何东西——重建失败
更是永久丢数据。上一轮已改成"先建临时集合、成功后再换名"，但换名仍发生在索引开始
之前，因此**重建期间**的检索窗口依然存在。

现在：重建把新集合建在临时名字下、写入全部指向它，**读路径继续指向正式集合**；
所有文档到达终态后由调度器一次性换名提交。于是任何时刻检索到的要么是完整的旧数据、
要么是完整的新数据，不存在"库空了"的窗口。
"""

import pytest

from api.knowledge_base.doc_service import IndexingTask
from core.rag.vector_store import MilvusVectorStore

pytestmark = pytest.mark.anyio


class FakeVectorStore:
    """只记录重建相关调用的替身。"""

    def __init__(self, staged: bool = True):
        self._staged = staged
        self.writes: list[tuple[str, str | None]] = []
        self.commits = 0

    async def has_staged_collection(self, kb_id: str) -> bool:
        return self._staged

    async def commit_staged_collection(self, kb_id: str) -> bool:
        if not self._staged:
            return False
        self.commits += 1
        self._staged = False
        return True

    async def add_documents(self, kb_id, documents, embeddings, target=None):
        self.writes.append((kb_id, target))
        return []


class RecordingPipeline:
    def __init__(self, store):
        self.vector_store = store


class StubScheduler:
    """借用真实调度器的 maybe_commit_rebuild，但绕开单例与队列。"""

    def __init__(self, store, active_docs: int = 0, queued=None, running=None):
        self._pipeline = RecordingPipeline(store)
        self._queue = queued or []
        self._running = running or {}
        self._active_docs = active_docs

    def _resolve_session_factory(self):
        return _FakeSessionFactory(self._active_docs)

    maybe_commit_rebuild = _maybe_commit_impl = None  # 占位，下面 monkeypatch


class _FakeResult:
    def __init__(self, value):
        self._value = value

    def scalar(self):
        return self._value


class _FakeSession:
    def __init__(self, active_docs: int):
        self._active = active_docs

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def scalar(self, _stmt):
        return self._active


class _FakeSessionFactory:
    def __init__(self, active_docs: int):
        self._active = active_docs

    def __call__(self):
        return _FakeSession(self._active)


# 直接用真实实现（绑定到桩对象上），避免复制粘贴出偏差
from api.knowledge_base.doc_service import IndexingScheduler  # noqa: E402

StubScheduler.maybe_commit_rebuild = IndexingScheduler.maybe_commit_rebuild


class TestCommitDecision:
    async def test_commits_when_all_docs_terminal(self):
        store = FakeVectorStore()
        scheduler = StubScheduler(store, active_docs=0)

        assert await scheduler.maybe_commit_rebuild("kb-1") is True
        assert store.commits == 1

    async def test_waits_while_documents_are_still_active(self):
        store = FakeVectorStore()
        scheduler = StubScheduler(store, active_docs=3)

        assert await scheduler.maybe_commit_rebuild("kb-1") is False
        assert store.commits == 0, "还有文档在索引时不得提交"

    async def test_waits_while_kb_has_queued_tasks(self):
        store = FakeVectorStore()
        queued = [IndexingTask(kb_id="kb-1", doc_id="d2", file_path="p", file_type="md", config={})]
        scheduler = StubScheduler(store, active_docs=0, queued=queued)

        assert await scheduler.maybe_commit_rebuild("kb-1") is False

    async def test_waits_while_kb_has_running_tasks(self):
        store = FakeVectorStore()
        task = IndexingTask(kb_id="kb-1", doc_id="d1", file_path="p", file_type="md", config={})
        scheduler = StubScheduler(store, active_docs=0, running={"d1": (None, task)})

        assert await scheduler.maybe_commit_rebuild("kb-1") is False

    async def test_other_kbs_pending_work_does_not_block(self):
        """别的库还在排队不该拖住本库的提交（否则可能永远提交不了）。"""
        store = FakeVectorStore()
        queued = [IndexingTask(kb_id="kb-2", doc_id="d9", file_path="p", file_type="md", config={})]
        scheduler = StubScheduler(store, active_docs=0, queued=queued)

        assert await scheduler.maybe_commit_rebuild("kb-1") is True

    async def test_no_staging_means_nothing_to_do(self):
        store = FakeVectorStore(staged=False)
        scheduler = StubScheduler(store, active_docs=0)

        assert await scheduler.maybe_commit_rebuild("kb-1") is False
        assert store.commits == 0

    async def test_store_without_staging_api_is_ignored(self):
        """Chroma 等没有临时集合机制的后端：直接返回 False，不报错。"""

        class PlainStore:
            async def add_documents(self, *a, **kw):
                return []

        scheduler = StubScheduler(PlainStore(), active_docs=0)
        assert await scheduler.maybe_commit_rebuild("kb-1") is False


class TestStagingName:
    def test_staging_name_is_deterministic(self):
        assert MilvusVectorStore.staging_name_for("kb-1") == "kb_kb_1__new"

    def test_staging_name_matches_collection_naming(self):
        """临时集合名必须与正式集合同一命名规则，否则恢复时认不出。"""
        live = MilvusVectorStore._collection_name("a-b-c")
        assert MilvusVectorStore.staging_name_for("a-b-c").startswith(live)


class TestWriteTargetPlumbing:
    async def test_task_carries_target_collection(self):
        task = IndexingTask(
            kb_id="kb-1", doc_id="d1", file_path="p", file_type="md", config={},
            target_collection="kb_kb_1__new",
        )
        assert task.target_collection == "kb_kb_1__new"

    async def test_default_target_is_none(self):
        """常规上传不设目标 → 写正式集合（行为不变）。"""
        task = IndexingTask(
            kb_id="kb-1", doc_id="d1", file_path="p", file_type="md", config={},
        )
        assert task.target_collection is None

    async def test_context_passes_target_to_store(self):
        """状态机写入时必须带上目标集合——漏了就会写进正式集合，重建就白做了。"""
        from api.knowledge_base.doc_state import EmbeddingState, IndexingContext

        store = FakeVectorStore()
        ctx = IndexingContext(
            doc_id="d1", kb_id="kb-1", file_path="/tmp/a.md", file_type="md",
            config={}, target_collection="kb_kb_1__new",
        )
        from langchain_core.documents import Document

        ctx.chunks = [Document(page_content="正文" * 10, metadata={"doc_id": "d1"})]

        class FakeEmbeddings:
            async def aembed_documents(self, texts, on_batch=None):
                vectors = [[0.1] * 4 for _ in texts]
                if on_batch:
                    await on_batch(0, texts, vectors)
                return vectors

        class FakePipeline:
            embedding_model = FakeEmbeddings()
            vector_store = store

        await EmbeddingState().handle(ctx, FakePipeline())  # type: ignore[arg-type]

        assert store.writes == [("kb-1", "kb_kb_1__new")]

    async def test_context_without_target_writes_live_collection(self):
        from api.knowledge_base.doc_state import EmbeddingState, IndexingContext
        from langchain_core.documents import Document

        store = FakeVectorStore()
        ctx = IndexingContext(
            doc_id="d1", kb_id="kb-1", file_path="/tmp/a.md", file_type="md", config={},
        )
        ctx.chunks = [Document(page_content="正文" * 10, metadata={"doc_id": "d1"})]

        class FakeEmbeddings:
            async def aembed_documents(self, texts, on_batch=None):
                vectors = [[0.1] * 4 for _ in texts]
                if on_batch:
                    await on_batch(0, texts, vectors)
                return vectors

        class FakePipeline:
            embedding_model = FakeEmbeddings()
            vector_store = store

        await EmbeddingState().handle(ctx, FakePipeline())  # type: ignore[arg-type]

        assert store.writes == [("kb-1", None)]


class TestFlushIsBestEffort:
    """flush 只是可见性优化：失败/超时**不得**让文档失败（数据早已在库里）。

    线上实测两种失败都会发生：服务端速率限制直接拒绝
    （``rate limit exceeded``），高负载时 flush 等待封段超过阶段超时。
    把它们当必成功步骤会把"内容已经写完"的文档判成 failed。
    """

    def _store(self, behaviour: str):
        from core.rag.vector_store import MilvusVectorStore

        class FakeCollection:
            def flush(self):
                if behaviour == "raise":
                    raise RuntimeError("rate limit exceeded")
                if behaviour == "hang":
                    import time
                    time.sleep(5)

            def delete(self, expr):
                pass

        store = MilvusVectorStore(uri="http://fake:19530", user="u", password="p")
        store._connected = True
        store._collections["kb-1"] = FakeCollection()
        return store

    async def test_failing_flush_returns_false_without_raising(self):
        store = self._store("raise")

        assert await store.flush_collection("kb-1") is False

    async def test_slow_flush_times_out_without_raising(self):
        store = self._store("hang")

        assert await store.flush_collection("kb-1", timeout=0.2) is False

    async def test_successful_flush_returns_true(self):
        store = self._store("ok")

        assert await store.flush_collection("kb-1") is True

    async def test_stage_survives_flush_failure(self):
        """flush 失败后文档仍应推进到下一阶段，而不是标记失败。"""
        from api.knowledge_base.doc_state import BM25State, IndexingContext

        store = self._store("raise")

        class FakePipeline:
            vector_store = store

        ctx = IndexingContext(
            doc_id="d1", kb_id="kb-1", file_path="/tmp/a.md", file_type="md", config={},
        )
        ctx.chunks = ["x"]
        ctx.written_chunks = 1

        await BM25State().handle(ctx, FakePipeline())  # type: ignore[arg-type]

        assert ctx.status == "extracting", "flush 失败不该让文档停在 bm25 阶段"
        assert ctx.error_message is None
