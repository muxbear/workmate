"""文档入库：内容去重与粘贴文本（迭代 6 T6.1）。

两条语义必须钉死：

1. **同库同内容只留一篇**——跳过的是"重复的那一次"，而不是整批；并且报告里要说清
   "重复于哪一篇"，否则用户会以为自己的文件丢了；
2. **粘贴文本也落成真实文件**——解析、重试、图谱重建三条链路都从 ``storage_path``
   读盘，"内存里的 Document"会在第一次重试时崩。

顺序上还有一条容易写错、后果直接可见的约束：**去重必须排在配额之前**。否则
"传 20 个、其中 18 个是重复、配额只剩 1 位"会被整批拒掉，而实际只会新增两篇。
"""

import io
from pathlib import Path

import pytest
from fastapi import HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from api.knowledge_base import doc_service
from api.knowledge_base.doc_service import (
    create_text_document,
    upload_documents,
)
from db.models.knowledge_base import KnowledgeBase
from db.models.knowledge_base_document import KnowledgeBaseDocument
from db.models.knowledge_base_entity import KnowledgeBaseEntity
from db.models.knowledge_base_grant import KnowledgeBaseGrant
from db.models.knowledge_base_share import KnowledgeBaseShare
from db.models.knowledge_base_index_task import KnowledgeBaseIndexTask
from db.models.knowledge_base_relation import KnowledgeBaseRelation
from unit_tests.test_indexing_reliability import RecordingScheduler

pytestmark = pytest.mark.anyio

USER_A = "user-a"
KB = "kb-a"

CONTENT_X = "# 同一份内容\n\n这段话在多个文件里出现。\n"


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
            # 访问判定（T6.3）：分享有效期 + 部门/角色授权
            KnowledgeBaseShare, KnowledgeBaseGrant,
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


def upload_file(filename: str, content: bytes) -> UploadFile:
    return UploadFile(file=io.BytesIO(content), filename=filename)


def count_doc_dirs(upload_root: Path, kb_id: str = KB) -> int:
    """落盘目录数——每篇新文档一个 ``<doc_id>`` 目录。"""
    kb_dir = upload_root / kb_id
    return len([p for p in kb_dir.iterdir() if p.is_dir()]) if kb_dir.exists() else 0


@pytest.fixture
def upload_root(monkeypatch, tmp_path):
    monkeypatch.setattr(doc_service.settings, "DOC_UPLOAD_DIR", str(tmp_path))
    return tmp_path


class TestContentDedup:
    async def test_same_content_different_name_is_skipped(
        self, sessionmaker, upload_root, monkeypatch,
    ):
        await seed_kb(sessionmaker)
        monkeypatch.setattr(doc_service.settings, "KB_MAX_DOCS_PER_KB", 0)
        scheduler = RecordingScheduler()

        async with sessionmaker() as db:
            first = await upload_documents(
                db, KB, USER_A, [upload_file("a.md", CONTENT_X.encode())], scheduler,
            )
            await db.commit()
        async with sessionmaker() as db:
            second = await upload_documents(
                db, KB, USER_A, [upload_file("换个名字.md", CONTENT_X.encode())], scheduler,
            )
            await db.commit()

        assert [r.name for r in first.created] == ["a.md"]
        assert second.created == []
        assert len(second.skipped) == 1
        skip = second.skipped[0]
        assert skip.reason == "duplicate"
        assert skip.name == "换个名字.md"
        assert skip.existing_doc_name == "a.md", "报告必须说清重复于哪一篇"
        # 跳过要是**彻底**跳过：不落盘、不建行、不入队
        assert count_doc_dirs(upload_root) == 1
        assert len(scheduler.enqueued) == 1

    async def test_same_content_in_one_batch_creates_only_one(
        self, sessionmaker, upload_root,
    ):
        """同一个请求里两份相同内容——第二份也要被拦住。"""
        await seed_kb(sessionmaker)

        async with sessionmaker() as db:
            outcome = await upload_documents(
                db, KB, USER_A,
                [upload_file("第一份.md", CONTENT_X.encode()),
                 upload_file("第二份.md", CONTENT_X.encode())],
            )
            await db.commit()

        assert [r.name for r in outcome.created] == ["第一份.md"]
        assert [s.existing_doc_name for s in outcome.skipped] == ["第一份.md"]
        assert count_doc_dirs(upload_root) == 1

    async def test_same_content_in_another_kb_is_allowed(self, sessionmaker, upload_root):
        """判重是"同一知识库内"的：别的库有同样内容不影响我。"""
        await seed_kb(sessionmaker, KB, USER_A)
        await seed_kb(sessionmaker, "kb-b", USER_A)

        async with sessionmaker() as db:
            await upload_documents(db, KB, USER_A, [upload_file("a.md", CONTENT_X.encode())])
            await db.commit()
        async with sessionmaker() as db:
            other = await upload_documents(
                db, "kb-b", USER_A, [upload_file("a.md", CONTENT_X.encode())],
            )
            await db.commit()

        assert len(other.created) == 1
        assert other.skipped == []

    async def test_reupload_after_delete_is_allowed(self, sessionmaker, upload_root):
        """文档是硬删除：删掉之后同一内容应当能重传。"""
        await seed_kb(sessionmaker)
        async with sessionmaker() as db:
            await upload_documents(db, KB, USER_A, [upload_file("a.md", CONTENT_X.encode())])
            await db.commit()

        async with sessionmaker() as db:
            doc = (await db.execute(select(KnowledgeBaseDocument))).scalar_one()
            await db.delete(doc)
            await db.commit()

        async with sessionmaker() as db:
            again = await upload_documents(
                db, KB, USER_A, [upload_file("a.md", CONTENT_X.encode())],
            )
            await db.commit()

        assert len(again.created) == 1
        assert again.skipped == []

    async def test_legacy_rows_without_hash_do_not_block(self, sessionmaker, upload_root):
        """迁移前的存量文档没有哈希（NULL），不该把重传判成重复。"""
        await seed_kb(sessionmaker)
        async with sessionmaker() as db:
            db.add(KnowledgeBaseDocument(
                id="legacy", kb_id=KB, name="老文档.md", type="md", size_bytes=1,
                status="indexed", progress=100, storage_path="/tmp/legacy.md",
                content_hash=None,
            ))
            await db.commit()

        async with sessionmaker() as db:
            outcome = await upload_documents(
                db, KB, USER_A, [upload_file("新文档.md", CONTENT_X.encode())],
            )
            await db.commit()

        assert len(outcome.created) == 1

    async def test_failed_document_is_reported_with_its_status(
        self, sessionmaker, upload_root,
    ):
        """重复于一篇**失败**的文档时，要把状态带出去（用户可直接去点重试）。"""
        await seed_kb(sessionmaker)
        async with sessionmaker() as db:
            await upload_documents(db, KB, USER_A, [upload_file("a.md", CONTENT_X.encode())])
            await db.commit()
        async with sessionmaker() as db:
            doc = (await db.execute(select(KnowledgeBaseDocument))).scalar_one()
            doc.status = "failed"
            await db.commit()

        async with sessionmaker() as db:
            outcome = await upload_documents(
                db, KB, USER_A, [upload_file("a.md", CONTENT_X.encode())],
            )

        assert outcome.skipped[0].existing_doc_status == "failed"


class TestDedupPrecedesQuota:
    async def test_duplicates_do_not_consume_quota(self, sessionmaker, upload_root, monkeypatch):
        """配额只剩 1 位时，一份重复 + 一份新内容不该被整批拒掉。"""
        await seed_kb(sessionmaker)
        monkeypatch.setattr(doc_service.settings, "KB_MAX_DOCS_PER_KB", 2)

        async with sessionmaker() as db:
            await upload_documents(db, KB, USER_A, [upload_file("a.md", CONTENT_X.encode())])
            await db.commit()

        async with sessionmaker() as db:
            outcome = await upload_documents(
                db, KB, USER_A,
                [upload_file("重复.md", CONTENT_X.encode()),
                 upload_file("新的.md", "# 另一份内容\n".encode())],
            )
            await db.commit()

        assert [r.name for r in outcome.created] == ["新的.md"]
        assert len(outcome.skipped) == 1

    async def test_quota_still_stops_a_genuinely_new_file(
        self, sessionmaker, upload_root, monkeypatch,
    ):
        await seed_kb(sessionmaker)
        monkeypatch.setattr(doc_service.settings, "KB_MAX_DOCS_PER_KB", 1)
        async with sessionmaker() as db:
            await upload_documents(db, KB, USER_A, [upload_file("a.md", CONTENT_X.encode())])
            await db.commit()

        async with sessionmaker() as db:
            with pytest.raises(HTTPException) as exc:
                await upload_documents(
                    db, KB, USER_A, [upload_file("b.md", "# 新内容\n".encode())],
                )

        assert exc.value.status_code == 400
        assert "KB_MAX_DOCS_PER_KB" in exc.value.detail

    async def test_quota_failure_cleans_up_already_written_files(
        self, sessionmaker, upload_root, monkeypatch,
    ):
        """第 2 个文件撞配额时，第 1 个已落盘的目录必须被清掉。

        事务由调用方回滚，但**文件不会自己消失**——此前靠"整批预校验"避免孤儿，
        逐文件之后必须自己收尾。
        """
        await seed_kb(sessionmaker)
        monkeypatch.setattr(doc_service.settings, "KB_MAX_DOCS_PER_KB", 1)

        async with sessionmaker() as db:
            with pytest.raises(HTTPException):
                await upload_documents(
                    db, KB, USER_A,
                    [upload_file("一.md", "# 一\n".encode()), upload_file("二.md", "# 二\n".encode())],
                )
            await db.rollback()

        assert count_doc_dirs(upload_root) == 0, "失败后不该留下任何落盘目录"


class TestPasteTextDocument:
    async def test_creates_a_real_markdown_file(self, sessionmaker, upload_root):
        """必须落成真实文件——解析/重试/图谱重建都从 storage_path 读盘。"""
        await seed_kb(sessionmaker)
        text = "# 粘贴的标题\n\n正文内容。\n"

        async with sessionmaker() as db:
            outcome = await create_text_document(
                db, KB, USER_A, name="会议纪要", content=text,
            )
            await db.commit()

        doc = outcome.created[0]
        assert doc.name == "会议纪要.md"
        assert doc.type == "md"
        assert doc.size_display.endswith("B") or "K" in doc.size_display

        async with sessionmaker() as db:
            row = (await db.execute(select(KnowledgeBaseDocument))).scalar_one()
        assert row.type == "md"
        assert row.size_bytes == len(text.encode("utf-8")), "大小按 UTF-8 字节算"
        assert Path(row.storage_path).is_file()
        assert Path(row.storage_path).read_text(encoding="utf-8") == text

    async def test_default_name_carries_a_timestamp(self, sessionmaker, upload_root):
        await seed_kb(sessionmaker)

        async with sessionmaker() as db:
            outcome = await create_text_document(db, KB, USER_A, content="随便写点什么")

        name = outcome.created[0].name
        assert name.startswith("粘贴文本-") and name.endswith(".md")

    async def test_non_markdown_extension_is_rewritten(self, sessionmaker, upload_root):
        """用户把名字写成 .txt 也改写为 .md：内容就是 markdown/纯文本。"""
        await seed_kb(sessionmaker)

        async with sessionmaker() as db:
            outcome = await create_text_document(
                db, KB, USER_A, name="备忘.txt", content="内容",
            )

        assert outcome.created[0].name == "备忘.md"

    async def test_empty_content_is_rejected(self, sessionmaker, upload_root):
        await seed_kb(sessionmaker)

        async with sessionmaker() as db:
            with pytest.raises(HTTPException) as exc:
                await create_text_document(db, KB, USER_A, content="   \n  ")

        assert exc.value.status_code == 400

    async def test_over_limit_is_rejected_with_readable_message(
        self, sessionmaker, upload_root, monkeypatch,
    ):
        await seed_kb(sessionmaker)
        monkeypatch.setattr(doc_service.settings, "KB_MAX_PASTE_KB", 1)   # 1KB

        async with sessionmaker() as db:
            with pytest.raises(HTTPException) as exc:
                await create_text_document(db, KB, USER_A, content="字" * 2000)

        assert exc.value.status_code == 413
        assert "KB_MAX_PASTE_KB" in exc.value.detail

    async def test_pasted_text_is_deduped_too(self, sessionmaker, upload_root):
        """粘贴也走去重：同一段文本粘两次只留一篇。"""
        await seed_kb(sessionmaker)
        text = "# 同一段\n"

        async with sessionmaker() as db:
            await create_text_document(db, KB, USER_A, name="第一次", content=text)
            await db.commit()
        async with sessionmaker() as db:
            again = await create_text_document(db, KB, USER_A, name="第二次", content=text)
            await db.commit()

        assert again.created == []
        assert again.skipped[0].existing_doc_name == "第一次.md"

    async def test_paste_enqueues_indexing(self, sessionmaker, upload_root):
        await seed_kb(sessionmaker)
        scheduler = RecordingScheduler()

        async with sessionmaker() as db:
            outcome = await create_text_document(
                db, KB, USER_A, content="内容", scheduler=scheduler,
            )
            await db.commit()

        assert scheduler.enqueued == [outcome.created[0].id]


class TestUrlImportDocument:
    """URL 导入的服务层落库行为（抓取守卫本身见 test_url_import.py）。"""

    @staticmethod
    def _fetcher(title: str = "示例页"):
        from core.storage.safe_fetch import FetchedPage

        async def fetch(url: str, policy):   # noqa: ANN001 - 与真实抓取器同签名
            html = f"<html><head><title>{title}</title></head><body><p>正文</p></body></html>"
            return FetchedPage(
                content=html.encode("utf-8"),
                final_url=url,
                content_type="text/html",
                suggested_name=f"{title}.html",
                declared_encoding="utf-8",
            )

        return fetch

    async def test_creates_utf8_html_file_with_source_url(self, sessionmaker, upload_root):
        from api.knowledge_base.doc_service import import_document_from_url

        await seed_kb(sessionmaker)
        scheduler = RecordingScheduler()

        async with sessionmaker() as db:
            outcome = await import_document_from_url(
                db, KB, USER_A, url="https://example.com/doc",
                fetcher=self._fetcher("示例页"), scheduler=scheduler,
            )
            await db.commit()

        doc = outcome.created[0]
        assert doc.name == "示例页.html"
        assert doc.type == "html"
        assert scheduler.enqueued == [doc.id]

        async with sessionmaker() as db:
            row = (await db.execute(select(KnowledgeBaseDocument))).scalar_one()
        assert row.source_url == "https://example.com/doc"
        assert row.type == "html"
        assert row.content_hash, "URL 导入也要参与内容去重"
        # 落盘是 UTF-8 且内容完整（下游 BSHTMLLoader 写死了 open_encoding="utf-8"）
        text = Path(row.storage_path).read_text(encoding="utf-8")
        assert "正文" in text

    async def test_same_url_imported_twice_is_skipped(self, sessionmaker, upload_root):
        from api.knowledge_base.doc_service import import_document_from_url

        await seed_kb(sessionmaker)
        async with sessionmaker() as db:
            await import_document_from_url(
                db, KB, USER_A, url="https://example.com/doc", fetcher=self._fetcher(),
            )
            await db.commit()
        async with sessionmaker() as db:
            again = await import_document_from_url(
                db, KB, USER_A, url="https://example.com/doc", fetcher=self._fetcher(),
            )
            await db.commit()

        assert again.created == []
        assert again.skipped[0].reason == "duplicate"


class TestNameDisambiguation:
    """同名不同内容：加序号区分。

    库里没有文档名唯一约束（同名是合法的），但目录上传会让"不同子目录里的同名
    文件"从偶尔变成必然——两行同名会让用户分不清、删起来容易删错。
    """

    async def test_same_name_different_content_gets_a_suffix(
        self, sessionmaker, upload_root,
    ):
        await seed_kb(sessionmaker)

        async with sessionmaker() as db:
            first = await upload_documents(db, KB, USER_A, [upload_file("报告.md", "# 第一版\n".encode())])
            await db.commit()
        async with sessionmaker() as db:
            second = await upload_documents(db, KB, USER_A, [upload_file("报告.md", "# 第二版\n".encode())])
            await db.commit()

        assert [r.name for r in first.created] == ["报告.md"]
        assert [r.name for r in second.created] == ["报告(2).md"]

    async def test_same_batch_collisions_are_numbered_in_order(
        self, sessionmaker, upload_root,
    ):
        """目录上传：同一个批次里三个同名文件，序号要按顺序给。"""
        await seed_kb(sessionmaker)

        async with sessionmaker() as db:
            outcome = await upload_documents(db, KB, USER_A, [
                upload_file("a/README.md", b"# A\n"),
                upload_file("b/README.md", b"# B\n"),
                upload_file("c/README.md", b"# C\n"),
            ])
            await db.commit()

        assert [r.name for r in outcome.created] == ["README.md", "README(2).md", "README(3).md"]

    async def test_suffix_keeps_the_extension(self, sessionmaker, upload_root):
        await seed_kb(sessionmaker)
        async with sessionmaker() as db:
            await upload_documents(db, KB, USER_A, [upload_file("数据.csv", b"a,b\n1,2\n")])
            await db.commit()
        async with sessionmaker() as db:
            outcome = await upload_documents(db, KB, USER_A, [upload_file("数据.csv", b"a,b\n3,4\n")])

        assert outcome.created[0].name == "数据(2).csv"
        assert outcome.created[0].type == "csv", "加序号不能把类型判没了"

    async def test_dedup_still_wins_over_renaming(self, sessionmaker, upload_root):
        """同内容不同名 → 仍然是跳过，而不是被改名收下。"""
        await seed_kb(sessionmaker)
        async with sessionmaker() as db:
            await upload_documents(db, KB, USER_A, [upload_file("报告.md", CONTENT_X.encode())])
            await db.commit()
        async with sessionmaker() as db:
            outcome = await upload_documents(
                db, KB, USER_A, [upload_file("报告.md", CONTENT_X.encode())],
            )

        assert outcome.created == []
        assert outcome.skipped[0].reason == "duplicate"
