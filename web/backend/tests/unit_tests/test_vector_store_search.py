"""Tests for 向量库检索语义——打分方向 / 稀疏检索 / 切片更新。

用内存假集合替代真实 Milvus / Chroma，以便离线覆盖：
- 两个后端的分数方向必须统一为"越大越相关"；
- BM25 走真 IDF 打分（中文可命中，无关词不命中）；
- 切片更新不得丢失文档归属字段；
- 稀疏索引缓存在写入后失效。
"""

import pytest

from core.rag.bm25 import SparseConfig
from core.rag.vector_store import ChromaVectorStore, MilvusVectorStore

pytestmark = pytest.mark.anyio


# ─── 假 Milvus 集合 ───────────────────────────────────────────────────────────


class FakeMilvusHit:
    def __init__(self, hit_id: str, distance: float):
        self.id = hit_id
        self.distance = distance


class FakeMilvusIterator:
    def __init__(self, rows: list[dict], batch_size: int):
        self._rows = rows
        self._batch_size = batch_size
        self._pos = 0
        self.closed = False

    def next(self) -> list[dict]:
        if self._pos >= len(self._rows):
            return []
        batch = self._rows[self._pos:self._pos + self._batch_size]
        self._pos += len(batch)
        return batch

    def close(self) -> None:
        self.closed = True


class FakeMilvusCollection:
    """只实现被测代码用到的集合接口。"""

    def __init__(self, rows: list[dict] | None = None, hits: list[FakeMilvusHit] | None = None):
        self.rows = rows or []
        self.hits = hits or []
        self.upserted: list[dict] = []
        self.inserted: list[dict] = []
        self.deleted: list[str] = []
        self.search_calls = 0
        self.iterator_batch_size: int | None = None
        self.iterators: list[FakeMilvusIterator] = []

    def search(self, data, anns_field, param, limit, output_fields):
        self.search_calls += 1
        return [self.hits[:limit]]

    def query(self, expr, output_fields=None, **kwargs):
        if output_fields and "chunk_text" not in output_fields:
            # get_chunks_by_ids 路径：按 id 过滤
            ids = [r["id"] for r in self.rows]
            return [r for r in self.rows if r["id"] in ids]
        return self.rows

    def query_iterator(self, expr, output_fields, batch_size=1000):
        self.iterator_batch_size = batch_size
        iterator = FakeMilvusIterator(self.rows, batch_size)
        self.iterators.append(iterator)
        return iterator

    def upsert(self, data):
        self.upserted.extend(data)

    def insert(self, data):
        self.inserted.extend(data)

    def delete(self, expr):
        self.deleted.append(expr)

    def flush(self):
        pass

    def load(self):
        pass


def make_milvus_store(rows=None, hits=None) -> tuple[MilvusVectorStore, FakeMilvusCollection]:
    store = MilvusVectorStore(uri="http://fake:19530", user="u", password="p")
    store._connected = True  # 跳过真实连接
    collection = FakeMilvusCollection(rows=rows, hits=hits)
    store._collections["kb-1"] = collection
    return store, collection


def chunk_row(chunk_id: str, text: str, **overrides) -> dict:
    row = {
        "id": chunk_id,
        "doc_id": "doc-1",
        "kb_id": "kb-1",
        "chunk_index": 0,
        "chunk_text": text,
        "doc_name": "手册.pdf",
        "doc_type": "pdf",
        "metadata_": {"h1": "第一章"},
    }
    row.update(overrides)
    return row


# ─── 分数方向 ────────────────────────────────────────────────────────────────


class TestMilvusScoreDirection:
    async def test_similarity_score_is_passed_through(self):
        """Milvus COSINE 返回的就是余弦相似度，不得再做 1-d/2 换算。

        旧实现把相似度 0.9 换算成 0.55、把 0.2 换算成 0.9，分数整体反转。
        """
        store, _ = make_milvus_store(hits=[
            FakeMilvusHit("c1", 0.9),
            FakeMilvusHit("c2", 0.2),
        ])
        results = await store.similarity_search("kb-1", [0.1] * 8, top_k=2)

        assert results == [("c1", 0.9), ("c2", 0.2)]

    async def test_better_match_has_higher_score(self):
        """口径契约：分数越大越相关。"""
        store, _ = make_milvus_store(hits=[
            FakeMilvusHit("best", 0.95),
            FakeMilvusHit("worse", 0.4),
        ])
        results = dict(await store.similarity_search("kb-1", [0.0] * 8, top_k=2))
        assert results["best"] > results["worse"]

    async def test_negative_similarity_preserved(self):
        """余弦相似度可为负，不应被压到 [0.5, 1]。"""
        store, _ = make_milvus_store(hits=[FakeMilvusHit("c1", -0.3)])
        results = await store.similarity_search("kb-1", [0.0] * 8, top_k=1)
        assert results == [("c1", -0.3)]


# ─── 真 BM25 ─────────────────────────────────────────────────────────────────


CORPUS_ROWS = [
    chunk_row("c1", "向量数据库用于相似度检索，Milvus 是常用的向量数据库实现。"),
    chunk_row("c2", "知识图谱用于抽取实体和关系，实体之间通过关系连接。"),
    chunk_row("c3", "文本切片决定了检索粒度，切片过大或过小都会影响召回效果。"),
]


class TestMilvusBM25:
    async def test_chinese_query_hits_relevant_chunk(self):
        """中文查询应能命中（旧实现整句作为一个 token，tf 恒为 0）。"""
        store, _ = make_milvus_store(rows=CORPUS_ROWS)
        results = await store.bm25_search("kb-1", "向量数据库检索", top_k=3)
        assert results
        assert results[0][0] == "c1"

    async def test_phrase_need_not_appear_verbatim(self):
        """查询词分散出现即可命中。"""
        store, _ = make_milvus_store(rows=CORPUS_ROWS)
        ids = dict(await store.bm25_search("kb-1", "数据库 检索", top_k=3))
        assert "c1" in ids

    async def test_unrelated_query_returns_empty(self):
        """无关查询不应命中——旧实现只要单字重合就会给分。"""
        store, _ = make_milvus_store(rows=CORPUS_ROWS)
        assert await store.bm25_search("kb-1", "量子纠缠光谱仪", top_k=3) == []

    async def test_k1_and_b_from_config_affect_scores(self):
        """k1/b 现在真的参与打分。"""
        store, _ = make_milvus_store(rows=CORPUS_ROWS)
        default = dict(await store.bm25_search("kb-1", "数据库", top_k=3))
        tuned = dict(await store.bm25_search(
            "kb-1", "数据库", top_k=3, sparse_config=SparseConfig(bm25_b=0.0),
        ))
        assert default != tuned

    async def test_sparse_algo_none_disables_search(self):
        """sparse_algo=none 真正关闭稀疏检索。"""
        store, _ = make_milvus_store(rows=CORPUS_ROWS)
        results = await store.bm25_search(
            "kb-1", "数据库", top_k=3, sparse_config=SparseConfig(sparse_algo="none"),
        )
        assert results == []

    async def test_uses_iterator_to_avoid_query_window_truncation(self):
        """语料通过 query_iterator 分页拉取，避免默认查询窗口截断。"""
        rows = [chunk_row(f"c{i}", "数据库内容") for i in range(2500)]
        store, collection = make_milvus_store(rows=rows)
        await store.bm25_search("kb-1", "数据库", top_k=5)

        assert collection.iterator_batch_size == 1000
        assert len(collection.iterators) == 1
        assert collection.iterators[0].closed, "迭代器必须关闭以释放服务端资源"

    async def test_corpus_cache_avoids_refetch(self):
        """同参数重复检索命中缓存，不重复拉取全量语料。"""
        store, collection = make_milvus_store(rows=CORPUS_ROWS)
        await store.bm25_search("kb-1", "数据库", top_k=3)
        await store.bm25_search("kb-1", "切片", top_k=3)
        assert len(collection.iterators) == 1

    async def test_add_documents_invalidates_corpus_cache(self):
        """写入后缓存失效，检索能看到新切片。"""
        store, collection = make_milvus_store(rows=CORPUS_ROWS)
        await store.bm25_search("kb-1", "数据库", top_k=3)
        assert await store.bm25_search("kb-1", "新词条", top_k=3) == []

        collection.rows = CORPUS_ROWS + [chunk_row("c4", "新词条出现了")]
        await store.add_documents("kb-1", [], [])
        results = await store.bm25_search("kb-1", "新词条", top_k=3)
        assert results and results[0][0] == "c4"

    async def test_delete_by_doc_id_invalidates_corpus_cache(self):
        store, collection = make_milvus_store(rows=CORPUS_ROWS)
        await store.bm25_search("kb-1", "数据库", top_k=3)
        collection.rows = CORPUS_ROWS[1:]
        await store.delete_by_doc_id("kb-1", "doc-1")
        assert await store.bm25_search("kb-1", "数据库", top_k=3) == []


# ─── 切片更新 ────────────────────────────────────────────────────────────────


class TestMilvusUpdateChunk:
    async def test_upsert_includes_all_schema_fields(self):
        """upsert 必须补齐全部字段。

        Milvus upsert 是「删除+插入」，schema 未声明 nullable/default_value 时
        pymilvus 会因缺字段抛 DataNotMatchException；即使写入成功，缺字段也会让
        切片脱离文档归属。
        """
        store, collection = make_milvus_store(rows=[chunk_row("c1", "旧内容", chunk_index=3)])
        await store.update_chunk("kb-1", "c1", "新内容", [0.5] * 8)

        assert len(collection.upserted) == 1
        row = collection.upserted[0]
        for field in ("id", "doc_id", "kb_id", "chunk_index", "chunk_text",
                      "embedding", "doc_name", "doc_type", "metadata_", "created_at"):
            assert field in row, f"upsert 缺少字段 {field}"
        assert row["doc_id"] == "doc-1"
        assert row["chunk_index"] == 3
        assert row["doc_name"] == "手册.pdf"
        assert row["metadata_"] == {"h1": "第一章"}
        assert row["chunk_text"] == "新内容"

    async def test_update_missing_chunk_raises(self):
        store, _ = make_milvus_store(rows=[])
        with pytest.raises(ValueError, match="Chunk not found"):
            await store.update_chunk("kb-1", "missing", "x", [0.0] * 8)

    async def test_update_invalidates_corpus_cache(self):
        store, collection = make_milvus_store(rows=[chunk_row("c1", "旧词条")])
        await store.bm25_search("kb-1", "旧词条", top_k=1)
        collection.rows = [chunk_row("c1", "全新词条")]
        await store.update_chunk("kb-1", "c1", "全新词条", [0.0] * 8)
        results = await store.bm25_search("kb-1", "全新词条", top_k=1)
        assert results and results[0][0] == "c1"


# ─── 假 Chroma 集合 ───────────────────────────────────────────────────────────


class FakeChromaCollection:
    def __init__(self):
        self.ids: list[str] = []
        self.documents: list[str] = []
        self.metadatas: list[dict] = []
        self.embeddings: list[list[float]] = []
        self.query_distances: list[float] = []
        self.updated: list[dict] = []

    def add(self, ids, documents, embeddings, metadatas):
        self.ids.extend(ids)
        self.documents.extend(documents)
        self.embeddings.extend(embeddings)
        self.metadatas.extend(metadatas)

    def query(self, query_embeddings, n_results, include):
        n = min(n_results, len(self.ids))
        return {
            "ids": [self.ids[:n]],
            "distances": [self.query_distances[:n]],
        }

    def get(self, ids=None, where=None, include=None):
        if ids is not None:
            picked = [(i, cid) for i, cid in enumerate(self.ids) if cid in ids]
        else:
            picked = list(enumerate(self.ids))
        return {
            "ids": [cid for _, cid in picked],
            "documents": [self.documents[i] for i, _ in picked],
            "metadatas": [self.metadatas[i] for i, _ in picked],
        }

    def update(self, ids, documents, embeddings, metadatas):
        self.updated.append({"ids": ids, "documents": documents, "metadatas": metadatas})
        for i, cid in enumerate(self.ids):
            if cid in ids:
                pos = ids.index(cid)
                self.documents[i] = documents[pos]
                self.metadatas[i] = metadatas[pos]

    def delete(self, ids):
        keep = [i for i, cid in enumerate(self.ids) if cid not in ids]
        self.ids = [self.ids[i] for i in keep]
        self.documents = [self.documents[i] for i in keep]
        self.metadatas = [self.metadatas[i] for i in keep]


class FakeChromaClient:
    def __init__(self, collection: FakeChromaCollection):
        self._collection = collection

    def get_collection(self, name):
        return self._collection


def make_chroma_store() -> tuple[ChromaVectorStore, FakeChromaCollection]:
    store = ChromaVectorStore(persist_dir="./unused")
    collection = FakeChromaCollection()
    store._client = FakeChromaClient(collection)
    return store, collection


class TestChromaScoreDirection:
    async def test_distance_converted_to_similarity(self):
        """Chroma 返回的是距离（越小越近），必须换算成相似度。"""
        store, collection = make_chroma_store()
        collection.ids = ["c1", "c2"]
        collection.query_distances = [0.1, 0.8]  # c1 更近

        results = dict(await store.similarity_search("kb-1", [0.0] * 8, top_k=2))
        assert results["c1"] == pytest.approx(0.9)
        assert results["c2"] == pytest.approx(0.2)
        assert results["c1"] > results["c2"], "越近的切片分数必须越高"

    async def test_identical_vector_scores_one(self):
        store, collection = make_chroma_store()
        collection.ids = ["c1"]
        collection.query_distances = [0.0]
        results = dict(await store.similarity_search("kb-1", [0.0] * 8, top_k=1))
        assert results["c1"] == pytest.approx(1.0)


class TestChromaBM25:
    def _seed(self, collection: FakeChromaCollection) -> None:
        assert CORPUS_ROWS
        collection.ids = [r["id"] for r in CORPUS_ROWS]
        collection.documents = [r["chunk_text"] for r in CORPUS_ROWS]
        collection.metadatas = [
            {k: v for k, v in r.items() if k not in ("id", "chunk_text")}
            for r in CORPUS_ROWS
        ]

    async def test_chinese_query_hits_relevant_chunk(self):
        store, collection = make_chroma_store()
        self._seed(collection)
        results = await store.bm25_search("kb-1", "向量数据库检索", top_k=3)
        assert results and results[0][0] == "c1"

    async def test_unrelated_query_returns_empty(self):
        store, collection = make_chroma_store()
        self._seed(collection)
        assert await store.bm25_search("kb-1", "量子纠缠光谱仪", top_k=3) == []

    async def test_no_contains_prefilter_on_longest_term(self):
        """不再用 where_document $contains 预过滤（中文会退化成整句匹配）。"""
        store, collection = make_chroma_store()
        self._seed(collection)
        # 查询中"缺少"的最长词若用于预过滤，将导致零命中
        results = await store.bm25_search("kb-1", "向量数据库与切片", top_k=3)
        assert results, "不应因为最长词不存在而整体零命中"


class TestChromaUpdateChunk:
    async def test_metadata_is_merged_not_replaced(self):
        """Chroma 的 metadata 是整体替换，必须先合并原字段。"""
        store, collection = make_chroma_store()
        collection.ids = ["c1"]
        collection.documents = ["旧内容"]
        collection.metadatas = [
            {"doc_id": "doc-1", "kb_id": "kb-1", "chunk_index": 2,
             "doc_name": "手册.pdf", "doc_type": "pdf", "metadata_": "{}", "created_at": 1}
        ]

        await store.update_chunk("kb-1", "c1", "新内容", [0.5] * 8)

        meta = collection.metadatas[0]
        assert meta["doc_id"] == "doc-1"
        assert meta["kb_id"] == "kb-1"
        assert meta["chunk_index"] == 2
        assert meta["doc_name"] == "手册.pdf"
        assert meta["created_at"] != 1, "created_at 应被刷新"
        assert collection.documents[0] == "新内容"

    async def test_update_missing_chunk_raises(self):
        store, _ = make_chroma_store()
        with pytest.raises(ValueError, match="Chunk not found"):
            await store.update_chunk("kb-1", "missing", "x", [0.0] * 8)
