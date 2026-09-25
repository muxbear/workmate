"""向量库调用不得阻塞事件循环（迭代 4 T4.1）。

pymilvus 与 chromadb 的对外 API 都是**同步**的，直接在 ``async def`` 里调用它们
等于在事件循环里做网络 IO 与本地计算。实测最严重的是 BM25 全量语料扫描——
**2967ms 期间整个异步服务停摆**（HTTP 请求、SSE 推送、健康检查全部卡住）。

这里的用例把"调用发生在哪个线程"作为断言对象：只要有一次向量库调用落在事件循环
线程上，用例就失败——这正是本次回归要防的东西。行为断言比扫源码文本可靠：
前者不会因为重构改个写法就误报，也不会因为漏看一处调用点而漏报。
"""

import asyncio
import threading
import time

import pytest

from core.rag.vector_store import ChromaVectorStore, MilvusVectorStore

pytestmark = pytest.mark.anyio


class ThreadRecorder:
    """记录每次调用发生在线程池线程还是事件循环线程。"""

    def __init__(self, delay: float = 0.0):
        self.delay = delay
        self.calls: list[tuple[str, bool]] = []

    def record(self, name: str) -> None:
        """记录一次调用；``True`` 表示"跑在事件循环线程上"（即违规）。"""
        self.calls.append((name, threading.current_thread() is threading.main_thread()))
        if self.delay:
            time.sleep(self.delay)

    @property
    def loop_thread_calls(self) -> list[str]:
        return [name for name, on_loop in self.calls if on_loop]

    @property
    def called(self) -> set[str]:
        return {name for name, _ in self.calls}


class FakeMilvusIterator:
    def __init__(self, rows: list[dict], recorder: ThreadRecorder):
        self._rows = rows
        self._recorder = recorder
        self._done = False

    def next(self) -> list[dict]:
        self._recorder.record("iterator.next")
        if self._done:
            return []
        self._done = True
        return self._rows

    def close(self) -> None:
        self._recorder.record("iterator.close")


class FakeMilvusCollection:
    """只实现被测代码用到的接口，并记录调用线程。"""

    def __init__(self, recorder: ThreadRecorder, rows: list[dict] | None = None):
        self._recorder = recorder
        self.rows = rows if rows is not None else [
            {"id": "c1", "doc_id": "doc-1", "kb_id": "kb-1", "chunk_index": 0,
             "chunk_text": "内容一", "doc_name": "手册.pdf", "doc_type": "pdf",
             "metadata_": {}},
        ]
        self.hits = [FakeMilvusHit("c1", 0.9)]

    def search(self, data, anns_field, param, limit, output_fields, expr=None):
        self._recorder.record("collection.search")
        return [self.hits[:limit]]

    def query(self, expr, output_fields=None, **kwargs):
        self._recorder.record("collection.query")
        return self.rows

    def query_iterator(self, expr, output_fields, batch_size=1000):
        self._recorder.record("collection.query_iterator")
        return FakeMilvusIterator(self.rows, self._recorder)

    def upsert(self, data):
        self._recorder.record("collection.upsert")

    def insert(self, data):
        self._recorder.record("collection.insert")

    def delete(self, expr):
        self._recorder.record("collection.delete")

    def flush(self):
        self._recorder.record("collection.flush")

    def load(self):
        self._recorder.record("collection.load")

    def create_index(self, field_name, index_params):
        self._recorder.record("collection.create_index")


class FakeMilvusHit:
    def __init__(self, hit_id: str, distance: float):
        self.id = hit_id
        self.distance = distance


def make_milvus_store(delay: float = 0.0) -> tuple[MilvusVectorStore, ThreadRecorder]:
    store = MilvusVectorStore(uri="http://fake:19530", user="u", password="p")
    store._connected = True
    recorder = ThreadRecorder(delay=delay)
    store._collections["kb-1"] = FakeMilvusCollection(recorder)
    return store, recorder


class FakeChromaCollection:
    def __init__(self, recorder: ThreadRecorder):
        self._recorder = recorder

    def add(self, **kwargs):
        self._recorder.record("collection.add")

    def upsert(self, **kwargs):
        self._recorder.record("collection.upsert")

    def get(self, **kwargs):
        self._recorder.record("collection.get")
        return {
            "ids": ["c1"],
            "documents": ["内容一"],
            "metadatas": [{
                "doc_id": "doc-1", "kb_id": "kb-1", "chunk_index": 0,
                "doc_name": "手册.pdf", "doc_type": "pdf", "metadata_": "{}",
            }],
        }

    def delete(self, **kwargs):
        self._recorder.record("collection.delete")

    def update(self, **kwargs):
        self._recorder.record("collection.update")

    def query(self, **kwargs):
        self._recorder.record("collection.query")
        return {"ids": [["c1"]], "distances": [[0.1]]}


class FakeChromaClient:
    def __init__(self, recorder: ThreadRecorder):
        self._recorder = recorder
        self._collection = FakeChromaCollection(recorder)

    def get_collection(self, name):
        self._recorder.record("client.get_collection")
        return self._collection

    def create_collection(self, **kwargs):
        self._recorder.record("client.create_collection")

    def delete_collection(self, name):
        self._recorder.record("client.delete_collection")


def make_chroma_store(delay: float = 0.0) -> tuple[ChromaVectorStore, ThreadRecorder]:
    store = ChromaVectorStore(persist_dir="./fake")
    recorder = ThreadRecorder(delay=delay)
    store._client = FakeChromaClient(recorder)
    return store, recorder


class TestRunSyncGateway:
    async def test_executes_off_the_event_loop_thread(self):
        from core.rag.vector_store import BaseVectorStore

        seen: list[threading.Thread] = []

        def blocking() -> str:
            seen.append(threading.current_thread())
            return "done"

        result = await BaseVectorStore.run_sync(blocking)

        assert result == "done"
        assert seen[0] is not threading.main_thread()

    async def test_passes_positional_and_keyword_args(self):
        from core.rag.vector_store import BaseVectorStore

        def target(a, b, c=0, d=0):
            return a + b + c + d

        assert await BaseVectorStore.run_sync(target, 1, 2, c=3, d=4) == 10


class TestMilvusCallsAreThreaded:
    async def test_read_paths_run_off_the_loop_thread(self):
        store, recorder = make_milvus_store()

        await store.similarity_search("kb-1", [0.1] * 8, top_k=1)
        await store.get_chunks_by_ids("kb-1", ["c1"])
        await store.get_chunks_by_doc_id("kb-1", "doc-1")
        await store.bm25_search("kb-1", "查询", top_k=5)

        assert recorder.called >= {
            "collection.search", "collection.query", "collection.query_iterator",
        }
        assert recorder.loop_thread_calls == []

    async def test_write_paths_run_off_the_loop_thread(self):
        from langchain_core.documents import Document

        store, recorder = make_milvus_store()
        doc = Document(page_content="正文", metadata={"doc_id": "doc-1"})

        await store.add_documents("kb-1", [doc], [[0.1] * 8])
        await store.delete_by_doc_id("kb-1", "doc-1")
        await store.delete_chunk_by_id("kb-1", "c1")
        await store.update_chunk("kb-1", "c1", "新正文", [0.2] * 8)

        assert recorder.called >= {
            "collection.upsert", "collection.delete", "collection.flush",
        }
        assert recorder.loop_thread_calls == []

    async def test_get_collection_loads_off_the_loop_thread(self, monkeypatch):
        """首次访问知识库要"构造 Collection + load"，同样是远程调用。"""
        import pymilvus

        recorder = ThreadRecorder()

        class FakeCollection:
            def __init__(self, name):
                recorder.record("Collection.__init__")
                self.name = name

            def load(self):
                recorder.record("collection.load")

        monkeypatch.setattr(pymilvus, "Collection", FakeCollection)

        store, _ = make_milvus_store()
        store._collections.clear()
        await store._get_collection("kb-1")

        assert recorder.called == {"Collection.__init__", "collection.load"}
        assert recorder.loop_thread_calls == []

    async def test_collection_lifecycle_runs_off_the_loop_thread(self, monkeypatch):
        """建库/删库要走 has_collection / drop_collection / create_index。"""
        import pymilvus
        from pymilvus import utility

        recorder = ThreadRecorder()

        class FakeCollection(FakeMilvusCollection):
            def __init__(self, name=None, schema=None):
                recorder.record("Collection.__init__")
                super().__init__(recorder)

        monkeypatch.setattr(pymilvus, "Collection", FakeCollection)
        monkeypatch.setattr(pymilvus, "connections", type("C", (), {
            "connect": staticmethod(lambda **kwargs: recorder.record("connections.connect")),
        }))
        monkeypatch.setattr(utility, "has_collection", lambda name: (
            recorder.record("utility.has_collection"), False
        )[1])
        monkeypatch.setattr(utility, "drop_collection", lambda name: (
            recorder.record("utility.drop_collection")
        ))
        monkeypatch.setattr(utility, "rename_collection", lambda old, new: (
            recorder.record("utility.rename_collection")
        ))

        store = MilvusVectorStore(uri="http://fake:19530", user="u", password="p")
        await store.create_collection("kb-1", dim=8)
        await store.delete_collection("kb-1")

        assert {"utility.has_collection", "Collection.__init__",
                "collection.create_index", "collection.load",
                "utility.rename_collection", "utility.drop_collection"} <= recorder.called
        assert recorder.loop_thread_calls == []


class TestChromaCallsAreThreaded:
    async def test_all_paths_run_off_the_loop_thread(self):
        from langchain_core.documents import Document

        store, recorder = make_chroma_store()
        doc = Document(page_content="正文", metadata={"doc_id": "doc-1"})

        await store.similarity_search("kb-1", [0.1] * 8, top_k=1)
        await store.get_chunks_by_ids("kb-1", ["c1"])
        await store.get_chunks_by_doc_id("kb-1", "doc-1")
        await store.bm25_search("kb-1", "查询", top_k=5)
        await store.add_documents("kb-1", [doc], [[0.1] * 8])
        await store.delete_by_doc_id("kb-1", "doc-1")
        await store.delete_chunk_by_id("kb-1", "c1")

        assert recorder.loop_thread_calls == []

    async def test_collection_lifecycle_runs_off_the_loop_thread(self):
        store, recorder = make_chroma_store()

        await store.create_collection("kb-1", dim=8)
        await store.delete_collection("kb-1")

        assert recorder.called >= {"client.create_collection", "client.delete_collection"}
        assert recorder.loop_thread_calls == []


class TestEventLoopStaysResponsive:
    async def test_heartbeat_keeps_ticking_during_a_slow_vector_call(self):
        """阻塞调用期间事件循环必须仍在转——这是本任务的存在理由。

        反例（未走线程池时）：心跳会在整个阻塞期间停摆，最大间隔 ≈ 阻塞时长。
        """
        delay = 0.4
        store, _ = make_milvus_store(delay=delay)
        gaps: list[float] = []
        stop = asyncio.Event()

        async def heartbeat() -> None:
            last = time.perf_counter()
            while not stop.is_set():
                await asyncio.sleep(0.01)
                now = time.perf_counter()
                gaps.append(now - last)
                last = now

        task = asyncio.create_task(heartbeat())
        await asyncio.sleep(0.03)          # 让心跳先跑起来
        await store.similarity_search("kb-1", [0.1] * 8, top_k=1)
        stop.set()
        await task

        assert gaps, "心跳没有采样到任何间隔"
        # 阈值取阻塞时长的一半：线程池路径下间隔是毫秒级，未走线程池时≈阻塞时长
        assert max(gaps) < delay / 2, f"事件循环被阻塞了 {max(gaps):.3f}s"

    async def test_concurrent_calls_do_not_serialize_the_loop(self):
        """并发检索时事件循环仍能调度其它协程（线程池允许并行）。"""
        store, _ = make_milvus_store(delay=0.2)
        ticks = 0

        async def ticker() -> None:
            nonlocal ticks
            for _ in range(20):
                await asyncio.sleep(0.01)
                ticks += 1

        await asyncio.gather(
            store.similarity_search("kb-1", [0.1] * 8, top_k=1),
            store.get_chunks_by_ids("kb-1", ["c1"]),
            ticker(),
        )

        assert ticks >= 15, "并发检索期间事件循环被占满"
