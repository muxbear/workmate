"""Milvus 原生 BM25 稀疏检索（迭代 4 T4.2）。

背景：此前的客户端 BM25 要把**全量语料**拉进进程、建全库词频统计、每查询做 O(N)
Python 打分——万级切片就不可用，内存还随语料线性增长（实测单次全量扫描 2.9s）。

现在 collection 带 ``sparse`` 字段 + BM25 Function，检索走服务端倒排。用例覆盖三件事：

1. 有原生能力时**必须**走原生路径（不能悄悄退回全量扫描）；
2. 没有原生能力时（老集合、bm25_plus / tf_idf）回退客户端实现；
3. 写入时**不得**显式提供 ``sparse`` 字段——Milvus 会直接报错。
"""

import asyncio
import json
import logging

import pytest

from core.rag.bm25 import SparseConfig
from core.rag.vector_store import MilvusVectorStore

pytestmark = pytest.mark.anyio


class FakeField:
    def __init__(self, name: str):
        self.name = name


class FakeSchema:
    def __init__(self, field_names: list[str]):
        self.fields = [FakeField(n) for n in field_names]


class FakeIndex:
    def __init__(self, field_name: str, params: dict):
        self.field_name = field_name
        self.params = params


class FakeHit:
    def __init__(self, hit_id: str, distance: float):
        self.id = hit_id
        self.distance = distance


class FakeIterator:
    def __init__(self, rows: list[dict]):
        self._rows = rows

    def next(self) -> list[dict]:
        rows, self._rows = self._rows, []
        return rows

    def close(self) -> None:
        pass


class FakeCollection:
    """带原生稀疏能力的假集合（可切换）。"""

    def __init__(
        self,
        *,
        native: bool = True,
        index_params: dict | None = None,
        schema_reads: list[str] | None = None,
    ):
        self.native = native
        self.schema = FakeSchema(
            ["id", "chunk_text", "sparse"] if native else ["id", "chunk_text", "embedding"],
        )
        self.indexes = [FakeIndex("sparse", {
            "index_type": "SPARSE_INVERTED_INDEX",
            "metric_type": "BM25",
            "params": index_params or {"bm25_k1": 1.5, "bm25_b": 0.75},
        })] if native else []
        self._schema_reads = schema_reads if schema_reads is not None else []
        self.search_calls: list[dict] = []
        self.query_iterator_calls = 0
        self.inserted: list[dict] = []
        self.upserted: list[dict] = []
        self.rows = [
            {"id": "c1", "chunk_text": "MySQL 主从复制配置 kubeadm", "metadata_": {}},
        ]

    def search(self, data, anns_field, param, limit, output_fields, expr=None):
        self.search_calls.append({
            "data": data, "anns_field": anns_field, "param": param, "limit": limit,
        })
        return [[FakeHit("c1", 5.83), FakeHit("c2", 1.02)][:limit]]

    def query_iterator(self, expr, output_fields, batch_size=1000):
        self.query_iterator_calls += 1
        return FakeIterator(self.rows)

    def query(self, expr, output_fields=None, **kwargs):
        return self.rows

    def insert(self, data):
        self.inserted.extend(data)

    def upsert(self, data):
        self.upserted.extend(data)

    def delete(self, expr):
        pass

    def flush(self):
        pass


def make_store(collection: FakeCollection) -> MilvusVectorStore:
    store = MilvusVectorStore(uri="http://fake:19530", user="u", password="p")
    store._connected = True
    store._collections["kb-1"] = collection
    return store


class TestNativePathIsPreferred:
    async def test_native_search_uses_sparse_field_with_raw_query(self):
        """原生路径要把**原始查询文本**交给 Milvus 分词，而不是查出来的向量。"""
        collection = FakeCollection(native=True)
        store = make_store(collection)

        hits = await store.bm25_search("kb-1", "MySQL 主从复制", top_k=2)

        assert [h[0] for h in hits] == ["c1", "c2"]
        call = collection.search_calls[0]
        assert call["anns_field"] == "sparse"
        assert call["data"] == ["MySQL 主从复制"]
        assert call["param"] == {"metric_type": "BM25"}
        # 关键：原生路径**不得**再拉全量语料
        assert collection.query_iterator_calls == 0

    async def test_native_scores_are_passed_through(self):
        collection = FakeCollection(native=True)
        store = make_store(collection)

        hits = await store.bm25_search("kb-1", "查询", top_k=2)

        assert hits == [("c1", 5.83), ("c2", 1.02)]

    async def test_probe_is_cached_across_queries(self):
        """schema/索引探测是一次远程调用，不能每次检索都读一遍。"""
        collection = FakeCollection(native=True)
        store = make_store(collection)
        reads = 0
        original = store._read_sparse_index_params

        def counting_read(coll):
            nonlocal reads
            reads += 1
            return original(coll)

        store._read_sparse_index_params = counting_read  # type: ignore[method-assign]

        await store.bm25_search("kb-1", "查询一", top_k=1)
        await store.bm25_search("kb-1", "查询二", top_k=1)

        assert reads == 1

    async def test_kb_param_drift_warns_but_keeps_native_path(self, caplog):
        """配置改了 k1/b 但索引是旧的：如实告警，但**不**退回全量扫描。

        回退会让一次参数微调把检索从服务端倒排打回 O(N) 全量打分——性能差两个数量级，
        比排序略有偏差更糟。正确做法是提示"重建索引生效"。
        """
        collection = FakeCollection(native=True, index_params={"bm25_k1": 1.5, "bm25_b": 0.75})
        store = make_store(collection)

        with caplog.at_level(logging.WARNING):
            await store.bm25_search(
                "kb-1", "查询", top_k=1,
                sparse_config=SparseConfig(bm25_k1=1.2, bm25_b=0.9),
            )

        assert "重建索引" in caplog.text
        assert collection.query_iterator_calls == 0, "不得回退到客户端全量扫描"
        assert collection.search_calls[0]["anns_field"] == "sparse"

    async def test_matching_params_do_not_warn(self, caplog):
        collection = FakeCollection(native=True, index_params={"bm25_k1": 1.5, "bm25_b": 0.75})
        store = make_store(collection)

        with caplog.at_level(logging.WARNING):
            await store.bm25_search(
                "kb-1", "查询", top_k=1,
                sparse_config=SparseConfig(bm25_k1=1.5, bm25_b=0.75),
            )

        assert "重建索引" not in caplog.text


class TestClientFallback:
    async def test_legacy_collection_without_sparse_field_falls_back(self):
        collection = FakeCollection(native=False)
        store = make_store(collection)

        hits = await store.bm25_search("kb-1", "kubeadm", top_k=5)

        assert collection.query_iterator_calls == 1, "老集合要走客户端语料索引"
        assert collection.search_calls == [], "不该用原生稀疏检索"
        assert [h[0] for h in hits] == ["c1"]

    async def test_non_bm25_algorithms_fall_back(self):
        """bm25_plus / tf_idf 是客户端实现特有的打分变体，Milvus 原生不支持。"""
        for algo in ("bm25_plus", "tf_idf"):
            collection = FakeCollection(native=True)
            store = make_store(collection)

            await store.bm25_search(
                "kb-1", "查询", top_k=1, sparse_config=SparseConfig(sparse_algo=algo),
            )

            assert collection.search_calls == [], f"{algo} 不该走原生路径"
            assert collection.query_iterator_calls == 1

    async def test_sparse_algo_none_disables_search(self):
        collection = FakeCollection(native=True)
        store = make_store(collection)

        hits = await store.bm25_search(
            "kb-1", "查询", top_k=1, sparse_config=SparseConfig(sparse_algo="none"),
        )

        assert hits == []
        assert collection.search_calls == []
        assert collection.query_iterator_calls == 0

    async def test_probe_failure_falls_back_instead_of_raising(self):
        """探测本身失败（老服务端 / 权限异常）不能让检索整条挂掉。"""
        collection = FakeCollection(native=True)
        store = make_store(collection)

        def broken_probe(coll):
            raise RuntimeError("schema unavailable")

        store._read_sparse_index_params = broken_probe  # type: ignore[method-assign]

        hits = await store.bm25_search("kb-1", "kubeadm", top_k=5)

        assert hits, "探测失败时应回退客户端实现并正常返回"
        assert collection.query_iterator_calls == 1


class TestWritePathExcludesGeneratedField:
    async def test_write_does_not_send_sparse(self):
        """Milvus 会拒绝显式提供 Function 的输出字段（实测报错）。"""
        from langchain_core.documents import Document

        collection = FakeCollection(native=True)
        store = make_store(collection)

        await store.add_documents(
            "kb-1",
            [Document(page_content="正文", metadata={"doc_id": "doc-1"})],
            [[0.1] * 8],
        )

        assert collection.upserted
        assert "sparse" not in collection.upserted[0]

    async def test_update_does_not_send_sparse(self):
        collection = FakeCollection(native=True)
        collection.rows = [{
            "id": "c1", "doc_id": "doc-1", "kb_id": "kb-1", "chunk_index": 0,
            "chunk_text": "旧正文", "doc_name": "手册.pdf", "doc_type": "pdf",
            "metadata_": {},
        }]
        store = make_store(collection)

        await store.update_chunk("kb-1", "c1", "新正文", [0.2] * 8)

        assert collection.upserted
        assert "sparse" not in collection.upserted[0]


class TestCollectionSchemaCreation:
    async def test_sparse_field_function_and_index_are_created(self, monkeypatch):
        import pymilvus
        from pymilvus import utility

        captured: dict = {}

        class FakeCollectionCtor:
            def __init__(self, name=None, schema=None):
                captured["name"] = name
                if schema is not None:
                    # 换名之后会再构造一次句柄（不带 schema），不要覆盖这里捕获的
                    captured["schema"] = schema
                self._index_params: list[tuple[str, dict]] = []

            def create_index(self, field_name, index_params):
                self._index_params.append((field_name, index_params))
                captured["indexes"] = self._index_params

            def load(self):
                pass

        monkeypatch.setattr(pymilvus, "Collection", FakeCollectionCtor)
        monkeypatch.setattr(pymilvus, "connections", type("C", (), {
            "connect": staticmethod(lambda **kwargs: None),
        }))
        monkeypatch.setattr(utility, "has_collection", lambda name: False)
        monkeypatch.setattr(utility, "drop_collection", lambda name: None)
        # 换名式替换（T4.5）：这里只关心建出来的 schema，换名给个空实现即可
        monkeypatch.setattr(utility, "rename_collection", lambda old, new: None)

        store = MilvusVectorStore(uri="http://fake:19530", user="u", password="p")
        await store.create_collection(
            "kb-1", dim=8, enable_bm25=True, sparse_params={"bm25_k1": 1.8, "bm25_b": 0.6},
        )

        schema = captured["schema"]
        field_names = [f.name for f in schema.fields]
        assert "sparse" in field_names
        # chunk_text 必须挂中文分析器，否则中文整句会变成一个 token
        # （pymilvus 会把 analyzer_params 序列化成 JSON 字符串，两种形态都认）
        text_field = next(f for f in schema.fields if f.name == "chunk_text")
        assert text_field.params.get("enable_analyzer") is True
        analyzer = text_field.params.get("analyzer_params")
        if isinstance(analyzer, str):
            analyzer = json.loads(analyzer)
        assert analyzer == {"type": "chinese"}
        # BM25 函数把 chunk_text 映射到 sparse
        assert schema.functions and schema.functions[0].name
        index_map = dict(captured["indexes"])
        assert index_map["sparse"]["metric_type"] == "BM25"
        assert index_map["sparse"]["params"]["bm25_k1"] == 1.8
        assert index_map["sparse"]["params"]["bm25_b"] == 0.6

    async def test_enable_bm25_false_skips_sparse_field(self, monkeypatch):
        import pymilvus
        from pymilvus import utility

        captured: dict = {}

        class FakeCollectionCtor:
            def __init__(self, name=None, schema=None):
                if schema is not None:
                    captured["schema"] = schema

            def create_index(self, field_name, index_params):
                pass

            def load(self):
                pass

        monkeypatch.setattr(pymilvus, "Collection", FakeCollectionCtor)
        monkeypatch.setattr(pymilvus, "connections", type("C", (), {
            "connect": staticmethod(lambda **kwargs: None),
        }))
        monkeypatch.setattr(utility, "has_collection", lambda name: False)
        monkeypatch.setattr(utility, "rename_collection", lambda old, new: None)

        store = MilvusVectorStore(uri="http://fake:19530", user="u", password="p")
        await store.create_collection("kb-1", dim=8, enable_bm25=False)

        assert "sparse" not in [f.name for f in captured["schema"].fields]


class TestConcurrentIndexBuild:
    async def test_concurrent_queries_build_corpus_index_once(self):
        """冷缓存下并发查询：只应拉一次全量语料（此前每个协程各拉一次）。"""
        collection = FakeCollection(native=False)
        store = make_store(collection)

        started = asyncio.Event()
        original_fetch = store._fetch_corpus

        async def slow_fetch(kb_id: str):
            started.set()
            await asyncio.sleep(0.05)
            return await original_fetch(kb_id)

        store._fetch_corpus = slow_fetch  # type: ignore[method-assign]

        await asyncio.gather(
            *(store.bm25_search("kb-1", f"查询{i}", top_k=1) for i in range(5)),
        )

        assert collection.query_iterator_calls == 1
