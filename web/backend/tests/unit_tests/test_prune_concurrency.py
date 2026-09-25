"""尾部裁剪的并发正确性（迭代 4 T4.5，线上实测踩到的坑）。

背景：幂等键是 (doc_id, chunk_index)，写入只覆盖"本次有的那些号"，因此文档变短时
需要删掉尾部残留。第一版把这件事做在 ``add_documents`` 里、按**这一批**的最大编号裁：
分批写入是并发的（embedding 并发 4 路），批次完成顺序不定——低编号的批次先落盘时，
会把另一个批次**已经写好**的高编号切片删掉。

一次在线重建因此丢了三篇文档的大部分切片：文档行说 50 片、库里只剩 30 片；
42→12、35→20。这些用例锁住"裁剪必须等整篇写完、按最终总数收口"。
"""

import asyncio

import pytest
from langchain_core.documents import Document

from core.rag.vector_store import MilvusVectorStore

pytestmark = pytest.mark.anyio


class ConcurrencyRecordingCollection:
    """记录 upsert / delete 的假集合，可模拟每批写入的耗时。"""

    def __init__(self):
        self.rows: dict[str, int] = {}
        self.deleted_exprs: list[str] = []

    def upsert(self, data):
        for row in data:
            self.rows[row["id"]] = row["chunk_index"]

    def delete(self, expr):
        self.deleted_exprs.append(expr)
        # 解析 "doc_id == \"X\" and chunk_index >= N" 并真的删（便于断言最终状态）
        if "chunk_index >=" in expr:
            threshold = int(expr.rsplit(">=", 1)[1].strip())
            for chunk_id, index in list(self.rows.items()):
                if index >= threshold:
                    del self.rows[chunk_id]

    def flush(self):
        pass


def make_store() -> tuple[MilvusVectorStore, ConcurrencyRecordingCollection]:
    collection = ConcurrencyRecordingCollection()
    store = MilvusVectorStore(uri="http://fake:19530", user="u", password="p")
    store._connected = True
    store._collections["kb-1"] = collection
    return store, collection


def batch(doc_id: str, start: int, count: int) -> list[Document]:
    return [
        Document(
            page_content=f"第{start + i}段正文",
            metadata={"doc_id": doc_id, "chunk_index": start + i, "metadata_": {}},
        )
        for i in range(count)
    ]


class TestConcurrentBatchesDoNotDeleteEachOther:
    async def test_out_of_order_batches_keep_all_chunks(self):
        """乱序完成的分批写入：最终必须 50 片都在。

        反例（第一版实现）：每批写完就按本批最大编号裁——第 0 批先落盘时执行
        "chunk_index > 9 全删"，把第 20、30、40 批**已经写好**的切片删掉。
        """
        store, collection = make_store()

        batches = [(start, batch("doc-1", start, 10)) for start in range(0, 50, 10)]
        # 故意让低编号的批次**最后**完成
        for start, docs in reversed(batches):
            await store.add_documents("kb-1", docs, [[0.1] * 4] * len(docs))

        assert len(collection.rows) == 50
        assert collection.deleted_exprs == [], "写入阶段不该删除任何切片"

    async def test_write_then_prune_keeps_exactly_the_final_count(self):
        """先写完 50 片，再按最终 50 片收口：一片都不该少。"""
        store, collection = make_store()

        for start in range(0, 50, 10):
            docs = batch("doc-1", start, 10)
            await store.add_documents("kb-1", docs, [[0.1] * 4] * len(docs))

        await store.prune_document_tail("kb-1", "doc-1", keep_count=50)

        assert len(collection.rows) == 50

    async def test_shrinking_document_is_trimmed_to_new_count(self):
        store, collection = make_store()

        for start in range(0, 50, 10):
            docs = batch("doc-1", start, 10)
            await store.add_documents("kb-1", docs, [[0.1] * 4] * len(docs))
        # 重切后只剩 25 片（覆盖 0~24），尾部 25~49 是上一轮的残留
        for start in range(0, 25, 10):
            docs = batch("doc-1", start, min(10, 25 - start))
            await store.add_documents("kb-1", docs, [[0.1] * 4] * len(docs))

        await store.prune_document_tail("kb-1", "doc-1", keep_count=25)

        assert sorted(collection.rows.values()) == list(range(25))

    async def test_concurrent_writes_with_prune_only_after_completion(self):
        """并发写入 + 写完再裁：并发本身不该让任何切片消失。"""
        store, collection = make_store()

        async def write(start: int) -> None:
            await asyncio.sleep(0.01 * (5 - start // 10))  # 越高编号的批越快
            docs = batch("doc-1", start, 10)
            await store.add_documents("kb-1", docs, [[0.1] * 4] * len(docs))

        await asyncio.gather(*(write(start) for start in range(0, 50, 10)))
        await store.prune_document_tail("kb-1", "doc-1", keep_count=50)

        assert len(collection.rows) == 50
