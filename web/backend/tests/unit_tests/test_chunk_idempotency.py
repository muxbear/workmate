"""入库幂等（迭代 4 T4.5）。

此前每片切片用**随机 uuid4** 做 ID、写入用 ``insert``：同一文档被索引两次就多出
一份切片（内容相同、ID 不同），库内计数虚高、检索结果重复。重试、重复入队、
批次重跑都会踩到。

现在 ID 由 ``(doc_id, chunk_index)`` 确定性推导，写入用 upsert——同一个位置
永远落成同一行。用例覆盖：ID 确定性、重复写入不产生新行、文档变短时清理尾部、
内容哈希随写入与改写更新。
"""

import pytest
from langchain_core.documents import Document

from core.rag.vector_store import (
    ChromaVectorStore,
    MilvusVectorStore,
    chunk_content_hash,
    chunk_id_for,
)

pytestmark = pytest.mark.anyio


class RecordingCollection:
    """只记录写入内容的假集合。"""

    def __init__(self):
        self.upserted: list[dict] = []
        self.deleted: list[str] = []
        self.rows: list[dict] = []

    def upsert(self, data):
        self.upserted.extend(data)

    def delete(self, expr):
        self.deleted.append(expr)

    def flush(self):
        pass

    def query(self, expr, output_fields=None, **kwargs):
        return self.rows

    def search(self, data, anns_field, param, limit, output_fields, expr=None):
        return [[]]


def make_store(collection) -> MilvusVectorStore:
    store = MilvusVectorStore(uri="http://fake:19530", user="u", password="p")
    store._connected = True
    store._collections["kb-1"] = collection
    return store


def make_doc(text: str, doc_id: str = "doc-1", index: int = 0) -> Document:
    return Document(
        page_content=text,
        metadata={"doc_id": doc_id, "chunk_index": index, "metadata_": {}},
    )


class TestChunkIdIsDeterministic:
    def test_same_document_and_index_yields_same_id(self):
        assert chunk_id_for("doc-1", 3) == chunk_id_for("doc-1", 3)

    def test_different_index_or_document_yields_different_id(self):
        ids = {
            chunk_id_for("doc-1", 0),
            chunk_id_for("doc-1", 1),
            chunk_id_for("doc-2", 0),
        }
        assert len(ids) == 3

    def test_id_is_milvus_expression_safe(self):
        """ID 会拼进 Milvus expr，必须只含白名单字符。"""
        from core.rag.vector_store import safe_expr_id

        assert safe_expr_id(chunk_id_for("doc-1", 0), "chunk_id")

    def test_content_hash_changes_with_content(self):
        assert chunk_content_hash("甲") != chunk_content_hash("乙")
        assert chunk_content_hash("甲") == chunk_content_hash("甲")
        assert chunk_content_hash("") == chunk_content_hash("")


class TestRepeatedWriteIsIdempotent:
    async def test_same_document_written_twice_reuses_ids(self):
        collection = RecordingCollection()
        store = make_store(collection)
        docs = [make_doc("甲", index=0), make_doc("乙", index=1)]
        vectors = [[0.1] * 4, [0.2] * 4]

        first = await store.add_documents("kb-1", docs, vectors)
        second = await store.add_documents("kb-1", docs, vectors)

        assert first == second, "同一个 (doc, index) 必须得到同一个 ID"
        assert len(set(first)) == 2

    async def test_write_uses_upsert_not_insert(self):
        """用 insert 会因主键冲突报错，或在后端表现为追加；必须走 upsert。"""
        collection = RecordingCollection()
        store = make_store(collection)

        await store.add_documents("kb-1", [make_doc("甲")], [[0.1] * 4])

        assert collection.upserted, "写入应走 upsert"

    async def test_content_hash_is_persisted(self):
        collection = RecordingCollection()
        store = make_store(collection)

        await store.add_documents("kb-1", [make_doc("正文内容")], [[0.1] * 4])

        meta = collection.upserted[0]["metadata_"]
        assert meta["content_hash"] == chunk_content_hash("正文内容")

    async def test_chunk_index_is_written_as_integer(self):
        """chunk_index 在 Milvus 里是 INT64，传字符串会被拒。"""
        collection = RecordingCollection()
        store = make_store(collection)
        doc = make_doc("甲")
        doc.metadata["chunk_index"] = 7

        await store.add_documents("kb-1", [doc], [[0.1] * 4])

        assert collection.upserted[0]["chunk_index"] == 7


class TestStaleTailIsPruned:
    async def test_shrinking_document_drops_tail_chunks(self):
        """文档变短时，旧的尾部切片必须删掉。

        幂等键是 (doc_id, chunk_index)，写入只覆盖"本次有的那些号"——上次有 5 片、
        这次只剩 3 片时，第 4、5 片会以旧内容留在库里继续被检索到。
        """
        collection = RecordingCollection()
        store = make_store(collection)
        docs = [make_doc(f"第{i}段", index=i) for i in range(3)]

        await store.add_documents("kb-1", docs, [[0.1] * 4] * 3)

        assert collection.deleted, "应收口删除超出范围的尾部切片"
        expr = collection.deleted[-1]
        assert 'doc_id == "doc-1"' in expr
        assert "chunk_index > 2" in expr

    async def test_multiple_documents_are_pruned_separately(self):
        collection = RecordingCollection()
        store = make_store(collection)
        docs = [
            make_doc("甲", doc_id="doc-a", index=0),
            make_doc("乙", doc_id="doc-b", index=4),
        ]

        await store.add_documents("kb-1", docs, [[0.1] * 4] * 2)

        exprs = {e.split(" and ")[0] for e in collection.deleted}
        assert exprs == {'doc_id == "doc-a"', 'doc_id == "doc-b"'}


class TestUpdateChunkRefreshesHash:
    async def test_edited_chunk_gets_new_content_hash(self):
        collection = RecordingCollection()
        collection.rows = [{
            "id": "c1", "doc_id": "doc-1", "kb_id": "kb-1", "chunk_index": 0,
            "chunk_text": "旧正文", "doc_name": "手册.pdf", "doc_type": "pdf",
            "metadata_": {"content_hash": chunk_content_hash("旧正文")},
        }]
        store = make_store(collection)

        await store.update_chunk("kb-1", "c1", "全新正文", [0.3] * 4)

        meta = collection.upserted[0]["metadata_"]
        assert meta["content_hash"] == chunk_content_hash("全新正文")


class TestChromaMatchesMilvusSemantics:
    async def test_chroma_uses_upsert_with_deterministic_ids(self):
        recorded: dict = {}

        class FakeChromaCollection:
            def upsert(self, **kwargs):
                recorded.update(kwargs)

        store = ChromaVectorStore(persist_dir="./fake")
        store._get_collection = _async_return(FakeChromaCollection())  # type: ignore[method-assign]

        ids = await store.add_documents("kb-1", [make_doc("甲")], [[0.1] * 4])

        assert ids == [chunk_id_for("doc-1", 0)]
        assert recorded["ids"] == ids


def _async_return(value):
    async def inner(*args, **kwargs):
        return value
    return inner
