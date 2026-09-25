"""文档级批量操作与下载原文（迭代 6 T6.1）。

批量最要紧的两条语义：

1. **部分成功是一等公民**——逐项报告，成功的那些必须**真的生效**。这逼着实现
   逐项提交：``delete_document`` 的副作用（清向量 + 删磁盘）发生在提交之前，
   整批只提交一次的话，中途失败回滚会留下"行还在、文件与向量已经没了"的鬼文档；
2. **下载是读操作**——能看正文的人就能下载原文，不需要写权限；且一律
   attachment + octet-stream（html 在上传白名单里，内联渲染 = 同源存储型 XSS）。
"""

from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from api.knowledge_base import doc_service
from api.knowledge_base.doc_service import (
    batch_documents,
    download_document,
)
from db.models.knowledge_base import KnowledgeBase
from db.models.knowledge_base_document import KnowledgeBaseDocument
from db.models.knowledge_base_entity import KnowledgeBaseEntity
from db.models.knowledge_base_index_task import KnowledgeBaseIndexTask
from db.models.knowledge_base_relation import KnowledgeBaseRelation
from unit_tests.test_indexing_reliability import FakeVectorStore, RecordingScheduler

pytestmark = pytest.mark.anyio

USER_A = "user-a"
USER_B = "user-b"
KB = "kb-a"


@pytest.fixture
async def sessionmaker():
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        for model in (
            KnowledgeBase, KnowledgeBaseDocument, KnowledgeBaseEntity,
            KnowledgeBaseRelation, KnowledgeBaseIndexTask,
        ):
            await conn.run_sync(model.__table__.create)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    yield maker
    await engine.dispose()


async def seed_kb(sessionmaker, kb_id: str = KB, user_id: str = USER_A) -> None:
    async with sessionmaker() as db:
        db.add(KnowledgeBase(
            id=kb_id, name=f"库-{kb_id}", user_id=user_id, status="ready",
            description="", config={}, tags=[], visibility="private",
        ))
        await db.commit()


async def seed_doc(
    sessionmaker,
    doc_id: str,
    *,
    kb_id: str = KB,
    status: str = "queued",
    storage_path: str = "",
) -> None:
    async with sessionmaker() as db:
        db.add(KnowledgeBaseDocument(
            id=doc_id, kb_id=kb_id, name=f"{doc_id}.md", type="md", size_bytes=3,
            status=status, progress=0, storage_path=storage_path or f"/tmp/{doc_id}.md",
        ))
        await db.commit()


async def existing_doc_ids(sessionmaker, kb_id: str = KB) -> set[str]:
    """换一个会话查——用来证明"提交过了"，而不是只在本事务里可见。"""
    async with sessionmaker() as db:
        rows = (await db.execute(
            select(KnowledgeBaseDocument.id).where(KnowledgeBaseDocument.kb_id == kb_id)
        )).scalars().all()
    return set(rows)


class TestBatchDelete:
    async def test_partial_failure_is_reported_per_item(self, sessionmaker, monkeypatch, tmp_path):
        await seed_kb(sessionmaker)
        for doc_id in ("doc-1", "doc-2"):
            await seed_doc(sessionmaker, doc_id)
        monkeypatch.setattr(doc_service.settings, "DOC_UPLOAD_DIR", str(tmp_path))

        async with sessionmaker() as db:
            items = await batch_documents(
                db, KB, USER_A,
                action="delete", doc_ids=["doc-1", "不存在的", "doc-2"],
                vector_store=FakeVectorStore(),
            )

        assert [i.ok for i in items] == [True, False, True]
        assert "不存在" in (items[1].message or "")
        # 成功的两项必须**真的**删掉了（逐项提交的证据）
        assert await existing_doc_ids(sessionmaker) == set()

    async def test_delete_removes_vectors_and_disk(self, sessionmaker, monkeypatch, tmp_path):
        await seed_kb(sessionmaker)
        file_dir = tmp_path / KB / "doc-1"
        file_dir.mkdir(parents=True)
        (file_dir / "doc-1.md").write_text("内容", encoding="utf-8")
        await seed_doc(sessionmaker, "doc-1", storage_path=str(file_dir / "doc-1.md"))
        monkeypatch.setattr(doc_service.settings, "DOC_UPLOAD_DIR", str(tmp_path))

        store = FakeVectorStore()
        async with sessionmaker() as db:
            items = await batch_documents(
                db, KB, USER_A, action="delete", doc_ids=["doc-1"], vector_store=store,
            )

        assert items[0].ok
        assert store.deleted_docs == ["doc-1"], "向量必须一起清掉"
        assert not file_dir.exists(), "磁盘目录必须一起清掉"

    async def test_other_users_kb_is_not_found(self, sessionmaker):
        await seed_kb(sessionmaker, KB, USER_A)
        await seed_doc(sessionmaker, "doc-1")

        async with sessionmaker() as db:
            with pytest.raises(HTTPException) as exc:
                await batch_documents(
                    db, KB, USER_B, action="delete", doc_ids=["doc-1"],
                    vector_store=FakeVectorStore(),
                )

        assert exc.value.status_code == 404
        assert await existing_doc_ids(sessionmaker) == {"doc-1"}


class TestBatchRetry:
    async def test_mixed_batch_reports_what_could_not_be_retried(self, sessionmaker):
        """用户"全选重试"必然混进已完成的文档——逐项报告，别整批失败。"""
        await seed_kb(sessionmaker)
        await seed_doc(sessionmaker, "doc-failed", status="failed")
        await seed_doc(sessionmaker, "doc-done", status="indexed")
        scheduler = RecordingScheduler()

        async with sessionmaker() as db:
            items = await batch_documents(
                db, KB, USER_A,
                action="retry", doc_ids=["doc-failed", "doc-done"],
                scheduler=scheduler, vector_store=FakeVectorStore(),
            )

        assert [i.ok for i in items] == [True, False]
        assert "已索引" in (items[1].message or "")
        assert scheduler.enqueued == ["doc-failed"]
        assert items[0].doc is not None and items[0].doc.status == "queued"

    async def test_retry_clears_previous_vectors(self, sessionmaker):
        """重试前清旧向量——否则同一 doc_id 会出现重复切片。"""
        await seed_kb(sessionmaker)
        await seed_doc(sessionmaker, "doc-1", status="failed")
        store = FakeVectorStore()

        async with sessionmaker() as db:
            await batch_documents(
                db, KB, USER_A, action="retry", doc_ids=["doc-1"],
                scheduler=RecordingScheduler(), vector_store=store,
            )

        assert store.deleted_docs == ["doc-1"]


class TestDownloadDocument:
    async def test_returns_path_and_attachment_type(self, sessionmaker, monkeypatch, tmp_path):
        await seed_kb(sessionmaker)
        file_dir = tmp_path / KB / "doc-1"
        file_dir.mkdir(parents=True)
        target = file_dir / "报告.md"
        target.write_text("# 报告\n", encoding="utf-8")
        await seed_doc(sessionmaker, "doc-1", storage_path=str(target))
        monkeypatch.setattr(doc_service.settings, "DOC_UPLOAD_DIR", str(tmp_path))

        async with sessionmaker() as db:
            path, name, media_type = await download_document(db, KB, "doc-1", USER_A)

        assert Path(path).read_text(encoding="utf-8") == "# 报告\n"
        assert name == "doc-1.md"
        # 一律二进制流：html 在内，内联渲染用户上传内容 = 同源存储型 XSS
        assert media_type == "application/octet-stream"

    async def test_missing_file_gives_readable_error(self, sessionmaker, monkeypatch, tmp_path):
        await seed_kb(sessionmaker)
        await seed_doc(sessionmaker, "doc-1", storage_path=str(tmp_path / KB / "gone.md"))
        monkeypatch.setattr(doc_service.settings, "DOC_UPLOAD_DIR", str(tmp_path))

        async with sessionmaker() as db:
            with pytest.raises(HTTPException) as exc:
                await download_document(db, KB, "doc-1", USER_A)

        assert exc.value.status_code == 404
        assert "重新上传" in exc.value.detail

    async def test_document_of_another_kb_is_not_found(self, sessionmaker, monkeypatch, tmp_path):
        """doc_id 必须与 kb_id 联合校验，不能拿别的库的文档 id 来下载。"""
        await seed_kb(sessionmaker, KB, USER_A)
        await seed_kb(sessionmaker, "kb-b", USER_A)
        file_dir = tmp_path / KB / "doc-1"
        file_dir.mkdir(parents=True)
        target = file_dir / "a.md"
        target.write_text("内容", encoding="utf-8")
        await seed_doc(sessionmaker, "doc-1", kb_id="kb-b", storage_path=str(target))
        monkeypatch.setattr(doc_service.settings, "DOC_UPLOAD_DIR", str(tmp_path))

        async with sessionmaker() as db:
            with pytest.raises(HTTPException) as exc:
                await download_document(db, KB, "doc-1", USER_A)

        assert exc.value.status_code == 404

    async def test_storage_path_outside_upload_dir_is_refused(self, sessionmaker, monkeypatch, tmp_path):
        """即便 DB 里的 storage_path 被人改过，也读不到上传目录之外的文件。"""
        await seed_kb(sessionmaker)
        outside = tmp_path / "outside.md"
        outside.write_text("秘密", encoding="utf-8")
        upload_dir = tmp_path / "uploads"
        (upload_dir / KB).mkdir(parents=True)
        await seed_doc(sessionmaker, "doc-1", storage_path=str(outside))
        monkeypatch.setattr(doc_service.settings, "DOC_UPLOAD_DIR", str(upload_dir))

        async with sessionmaker() as db:
            with pytest.raises(HTTPException):
                await download_document(db, KB, "doc-1", USER_A)
