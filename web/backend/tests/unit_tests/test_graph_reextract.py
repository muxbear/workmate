"""按文档重抽图谱：从**已存切片**抽，不重新解析文件（迭代 6 T6.5 批次④）。

两个要盯住的东西：

1. **粒度与一致性**：抽取的输入必须是索引时真正入库的那份文本。此前全库重建会重新
   解析文件、并按硬编码的 ``"recursive"`` 切分——而索引期用的是知识库配置里的策略，
   于是"重建出来的图谱"与"索引时的图谱"可能来自不同的文本。
2. **不阻塞请求**：抽取是 LLM 调用，而切片保存是用户在等的请求（前端默认 15s 超时）。
   放同步路径上必然"假失败"——服务端成功、界面报错。
"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from api.knowledge_base import graph_service
from api.knowledge_base.entity_norm import normalize_name
from api.knowledge_base.graph_service import (
    GraphExtractionError,
    GraphExtractionService,
    _chunk_text,
    reextract_document_graph,
    schedule_document_graph_reextract,
)
from db.models.knowledge_base import KnowledgeBase
from db.models.knowledge_base_document import KnowledgeBaseDocument
from db.models.knowledge_base_entity import KnowledgeBaseEntity
from db.models.knowledge_base_relation import KnowledgeBaseRelation

pytestmark = pytest.mark.anyio

KB = "kb-a"
DOC = "doc-1"


class FakeVectorStore:
    """按文档返回已存切片行（与向量库返回的 dict 同形：正文字段是 chunk_text）。"""

    def __init__(self, texts: list[str]) -> None:
        self.texts = texts
        self.calls = 0

    async def get_chunks_by_doc_id(self, kb_id: str, doc_id: str) -> list[dict]:
        self.calls += 1
        return [
            {"id": f"c{i}", "chunk_index": i, "chunk_text": t}
            for i, t in enumerate(self.texts)
        ]


class RecordingExtractor:
    """记录抽取收到的文本，回一份固定的实体/关系，并走**真实的** ``_persist`` 落库。

    落库这一步刻意不桩掉：本文件要验的正是"删旧行 → 写新行"这条链路，桩掉 ``_persist``
    会让"实体到底有没有写进去"变成一句空断言——第一版就是这样，删掉后其实什么都没写。
    """

    def __init__(self, entities=None, relations=None) -> None:
        self.entities = (
            entities
            if entities is not None
            else [
                {"name": "Milvus", "type": "产品", "source_text": "Milvus"},
            ]
        )
        self.relations = relations if relations is not None else []
        self.seen: list[list[str]] = []

    async def extract_entities_and_relations(
        self,
        kb_id,
        doc_id,
        chunks,
        model_name=None,
    ):
        self.seen.append(list(chunks))
        await GraphExtractionService._persist(
            self,
            kb_id,
            doc_id,
            self.entities,
            self.relations,
        )
        return self.entities, self.relations


@pytest.fixture
async def maker(monkeypatch):
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        for model in (
            KnowledgeBase,
            KnowledgeBaseDocument,
            KnowledgeBaseEntity,
            KnowledgeBaseRelation,
        ):
            await conn.run_sync(model.__table__.create)
    maker = async_sessionmaker(engine, expire_on_commit=False)

    async def _seed() -> None:
        async with maker() as db:
            db.add(
                KnowledgeBase(
                    id=KB,
                    name="库",
                    user_id="u1",
                    config={"enable_graph": True},
                )
            )
            db.add(
                KnowledgeBaseDocument(
                    id=DOC,
                    kb_id=KB,
                    name="方案.md",
                    type="md",
                    status="indexed",
                    storage_path="/nonexistent/方案.md",
                )
            )
            await db.commit()

    await _seed()
    # 后台任务自开 session，这里把它接到测试用的内存库上
    monkeypatch.setattr("db.engine.async_session", maker, raising=False)
    yield maker
    # 清掉模块级状态，免得用例之间互相污染
    graph_service._reextract_inflight.clear()
    graph_service._reextract_pending.clear()
    graph_service._reextract_tasks.clear()
    await engine.dispose()


class TestChunkText:
    def test_dict_rows_use_the_text_field_not_the_repr(self):
        """回归：对切片行 dict 求 ``str()`` 会把元数据一起喂给模型。

        ``{'id': 'c0', 'chunk_text': '正文'}`` 的 repr 长这样——把它们当正文抽取，
        模型会看到一堆 id/index 噪声。
        """
        row = {"id": "c0", "chunk_index": 0, "chunk_text": "正文内容"}
        assert _chunk_text(row) == "正文内容"

    def test_document_objects_use_page_content(self):
        from langchain_core.documents import Document

        assert _chunk_text(Document(page_content="文档正文")) == "文档正文"

    def test_missing_text_is_empty_not_a_crash(self):
        assert _chunk_text({}) == ""
        assert _chunk_text({"chunk_text": None}) == ""


class TestReextractDocumentGraph:
    async def test_replaces_previous_rows_of_that_document(self, maker, monkeypatch):
        """**删掉一段切片后，那段抽出的实体必须从图上消失**。

        先删后插是关键：只插不删会让图谱残留用户已经删掉的内容。
        """
        extractor = RecordingExtractor()
        monkeypatch.setattr(graph_service, "GraphExtractionService", lambda: extractor)
        async with maker() as db:
            db.add_all(
                [
                    KnowledgeBaseEntity(
                        id="old-1",
                        kb_id=KB,
                        doc_id=DOC,
                        name="已删除的实体",
                        name_key=normalize_name("已删除的实体"),
                        type="概念",
                    ),
                    KnowledgeBaseEntity(
                        id="keep-1",
                        kb_id=KB,
                        doc_id="doc-2",
                        name="别篇文档的实体",
                        name_key=normalize_name("别篇文档的实体"),
                        type="概念",
                    ),
                ]
            )
            await db.commit()

        await reextract_document_graph(FakeVectorStore(["新正文"]), KB, DOC)

        async with maker() as db:
            names = {
                r[0] for r in (await db.execute(select(KnowledgeBaseEntity.name))).all()
            }
        assert "已删除的实体" not in names, "本文档的旧实体应被清掉"
        assert "别篇文档的实体" in names, "别的文档不受影响"
        assert "Milvus" in names

    async def test_extracts_from_stored_chunks_not_from_disk(self, maker, monkeypatch):
        """抽取的输入是**已存切片**，不是重新解析出的文本。

        用例把 ``storage_path`` 指成一个不存在的路径：若实现退回去解析文件，这里会
        因为没有文件而抽不到东西（或抛错），而本用例要求它照常抽到已存切片的内容。
        """
        extractor = RecordingExtractor()
        monkeypatch.setattr(graph_service, "GraphExtractionService", lambda: extractor)
        store = FakeVectorStore(["第一片正文", "第二片正文"])

        await reextract_document_graph(store, KB, DOC)

        assert store.calls == 1
        assert extractor.seen == [["第一片正文", "第二片正文"]]

    async def test_blank_chunks_are_dropped(self, maker, monkeypatch):
        extractor = RecordingExtractor(entities=[], relations=[])
        monkeypatch.setattr(graph_service, "GraphExtractionService", lambda: extractor)

        await reextract_document_graph(FakeVectorStore(["正文", "   ", ""]), KB, DOC)

        assert extractor.seen == [["正文"]]

    async def test_no_chunks_clears_the_graph_without_calling_the_llm(
        self,
        maker,
        monkeypatch,
    ):
        """切片被删光时：旧图谱清掉，且**不调模型**（没有正文可抽）。"""
        extractor = RecordingExtractor()
        monkeypatch.setattr(graph_service, "GraphExtractionService", lambda: extractor)
        async with maker() as db:
            db.add(
                KnowledgeBaseEntity(
                    id="e1",
                    kb_id=KB,
                    doc_id=DOC,
                    name="Milvus",
                    name_key="milvus",
                    type="产品",
                )
            )
            await db.commit()

        await reextract_document_graph(FakeVectorStore([]), KB, DOC)

        assert extractor.seen == []
        async with maker() as db:
            rows = (await db.execute(select(KnowledgeBaseEntity))).scalars().all()
        assert rows == []

    async def test_graph_disabled_skips_entirely(self, maker, monkeypatch):
        extractor = RecordingExtractor()
        monkeypatch.setattr(graph_service, "GraphExtractionService", lambda: extractor)
        async with maker() as db:
            kb = await db.get(KnowledgeBase, KB)
            kb.config = {"enable_graph": False}
            await db.commit()
        store = FakeVectorStore(["正文"])

        await reextract_document_graph(store, KB, DOC)

        assert store.calls == 0, "图谱关着就不该去取切片"
        assert extractor.seen == []

    async def test_failure_records_graph_error_and_does_not_raise(
        self,
        maker,
        monkeypatch,
    ):
        """失败只记 graph_error，**不抛**——切片编辑已经提交了，图谱是次要派生数据。"""

        class Boom:
            async def extract_entities_and_relations(self, *a, **kw):
                raise RuntimeError("模型不可用")

        monkeypatch.setattr(graph_service, "GraphExtractionService", lambda: Boom())

        await reextract_document_graph(FakeVectorStore(["正文"]), KB, DOC)

        async with maker() as db:
            doc = await db.get(KnowledgeBaseDocument, DOC)
        assert doc is not None
        assert doc.graph_error is not None
        assert "模型不可用" in doc.graph_error

    async def test_success_clears_a_previous_graph_error(self, maker, monkeypatch):
        """上一次失败留下的 graph_error 要在成功后被清掉，否则界面永远挂着红的。"""
        monkeypatch.setattr(
            graph_service, "GraphExtractionService", lambda: RecordingExtractor()
        )
        async with maker() as db:
            doc = await db.get(KnowledgeBaseDocument, DOC)
            doc.graph_error = "上一次失败"
            await db.commit()

        await reextract_document_graph(FakeVectorStore(["正文"]), KB, DOC)

        async with maker() as db:
            doc = await db.get(KnowledgeBaseDocument, DOC)
        assert doc is not None and doc.graph_error is None


class TestRebuildFromStoredChunks:
    """全库重建也改用已存切片——顺带修掉一处既有的不一致。"""

    async def test_uses_stored_chunks_for_every_indexed_doc(
        self,
        maker,
        monkeypatch,
    ):
        """**不重新解析文件、不用硬编码的 recursive 切分**。

        此前重建会重新解析每篇文档并按 `"recursive"` 切分，而索引期用的是知识库配置里
        的策略——于是"重建出来的图谱"与"索引时的图谱"可能来自**不同的文本**。
        这里把所有文档的 ``storage_path`` 指成不存在的路径：若实现退回去解析文件，
        一篇都抽不到。
        """
        extractor = RecordingExtractor()
        monkeypatch.setattr(graph_service, "GraphExtractionService", lambda: extractor)
        async with maker() as db:
            db.add(
                KnowledgeBaseDocument(
                    id="doc-2",
                    kb_id=KB,
                    name="另一篇.md",
                    type="md",
                    status="indexed",
                    storage_path="/nonexistent/另一篇.md",
                )
            )
            await db.commit()

        class ByDocStore:
            async def get_chunks_by_doc_id(self, kb_id: str, doc_id: str):
                return [{"chunk_text": f"{doc_id} 的切片正文"}]

        async with maker() as db:
            entities, _ = await graph_service.rebuild_graph_for_kb(
                db,
                {"entity_model": None},
                KB,
                ByDocStore(),
            )
            await db.commit()

        assert entities > 0
        # 两篇文档都从各自的已存切片抽到了东西（顺序无关的断言，不依赖行序）
        assert {t for seen in extractor.seen for t in seen} == {
            "doc-1 的切片正文",
            "doc-2 的切片正文",
        }

    async def test_docs_without_chunks_are_skipped(self, maker, monkeypatch):
        """取不到切片的文档跳过并记日志——宁可少一篇，也不用与索引不一致的文本改图谱。"""
        extractor = RecordingExtractor()
        monkeypatch.setattr(graph_service, "GraphExtractionService", lambda: extractor)

        class EmptyStore:
            async def get_chunks_by_doc_id(self, kb_id: str, doc_id: str):
                return []

        async with maker() as db:
            await graph_service.rebuild_graph_for_kb(db, {}, KB, EmptyStore())
            await db.commit()

        assert extractor.seen == []

    async def test_no_indexed_docs_zeroes_the_counters(self, maker, monkeypatch):
        monkeypatch.setattr(
            graph_service, "GraphExtractionService", lambda: RecordingExtractor()
        )
        async with maker() as db:
            doc = await db.get(KnowledgeBaseDocument, DOC)
            doc.status = "failed"
            kb = await db.get(KnowledgeBase, KB)
            kb.entities_count = 99
            kb.relations_count = 99
            await db.commit()

        class UnusedStore:
            async def get_chunks_by_doc_id(self, kb_id: str, doc_id: str):
                raise AssertionError("没有已索引文档时不该去取切片")

        async with maker() as db:
            entities, relations = await graph_service.rebuild_graph_for_kb(
                db,
                {},
                KB,
                UnusedStore(),
            )
        assert (entities, relations) == (0, 0)

    async def test_failing_doc_records_reason_and_others_still_rebuild(
        self,
        maker,
        monkeypatch,
    ):
        """单篇失败要把原因写到该文档行上，其余文档照常重建。

        此前失败只写日志然后 ``continue``，而 KB 计数按侥幸成功的那几篇重算——
        "重建少了几篇"在界面上完全看不出来。
        """

        class FlakyExtractor(RecordingExtractor):
            async def extract_entities_and_relations(self, kb_id, doc_id, chunks, **kw):
                if doc_id == DOC:
                    raise GraphExtractionError("模拟：图谱抽取模型不可用")
                return await super().extract_entities_and_relations(
                    kb_id, doc_id, chunks, **kw,
                )

        extractor = FlakyExtractor()
        monkeypatch.setattr(graph_service, "GraphExtractionService", lambda: extractor)
        async with maker() as db:
            db.add(
                KnowledgeBaseDocument(
                    id="doc-2",
                    kb_id=KB,
                    name="另一篇.md",
                    type="md",
                    status="indexed",
                    storage_path="/nonexistent/另一篇.md",
                )
            )
            await db.commit()

        class ByDocStore:
            async def get_chunks_by_doc_id(self, kb_id, doc_id):
                return [{"chunk_text": f"{doc_id} 的切片正文"}]

        async with maker() as db:
            entities, _ = await graph_service.rebuild_graph_for_kb(
                db,
                {"entity_model": None},
                KB,
                ByDocStore(),
            )
            await db.commit()

        async with maker() as db:
            failed_doc = await db.get(KnowledgeBaseDocument, DOC)
            ok_doc = await db.get(KnowledgeBaseDocument, "doc-2")

        # 失败的那篇：原因可见，而不是消失在一行日志里
        assert failed_doc is not None
        assert failed_doc.graph_error is not None
        assert "模型不可用" in failed_doc.graph_error
        # 另一篇不受牵连：照常抽出实体，且不该挂着任何错误
        assert entities > 0
        assert ok_doc is not None
        assert ok_doc.graph_error is None


class TestScheduling:
    async def test_returns_immediately_without_waiting_for_extraction(
        self,
        maker,
        monkeypatch,
    ):
        """**调度必须立即返回**：抽取是 LLM 调用，切片保存是用户在等的请求。

        放同步路径上必然"假失败"——服务端成功、界面报错（前端默认 15s 超时）。
        """
        started = asyncio.Event()
        release = asyncio.Event()

        async def slow_reextract(vector_store, kb_id, doc_id):
            started.set()
            await release.wait()

        monkeypatch.setattr(graph_service, "reextract_document_graph", slow_reextract)

        assert schedule_document_graph_reextract(FakeVectorStore([]), KB, DOC) is True
        await asyncio.wait_for(started.wait(), timeout=2)
        # 调用方早就返回了，抽取还卡在这里——这正是我们要的
        assert not release.is_set()
        release.set()
        await asyncio.sleep(0)

    async def test_edits_during_a_run_are_coalesced(self, maker, monkeypatch):
        """连续编辑合并成最多两次抽取——不能每敲一次保存就烧一次 LLM。"""
        runs: list[int] = []
        release = asyncio.Event()

        async def counting_reextract(vector_store, kb_id, doc_id):
            runs.append(1)
            if len(runs) == 1:
                await release.wait()

        monkeypatch.setattr(
            graph_service, "reextract_document_graph", counting_reextract
        )

        assert schedule_document_graph_reextract(FakeVectorStore([]), KB, DOC) is True
        while not runs:
            await asyncio.sleep(0)

        # 第一次还在跑——后续三次编辑只记一个待办，都返回 False
        assert schedule_document_graph_reextract(FakeVectorStore([]), KB, DOC) is False
        assert schedule_document_graph_reextract(FakeVectorStore([]), KB, DOC) is False
        assert schedule_document_graph_reextract(FakeVectorStore([]), KB, DOC) is False

        release.set()
        for _ in range(50):
            await asyncio.sleep(0)
            if len(runs) == 2:
                break
        assert len(runs) == 2, f"三次编辑应合并成一次补跑，实际跑了 {len(runs)} 次"
