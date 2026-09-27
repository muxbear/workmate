"""文档的目录归属：写入、判重范围、按目录过滤与目录聚合。

三组不变式，都是"看不见就出错"的那类：

1. **归一化只有一份口径**——写入与过滤必须走同一个 :func:`normalize_folder`。两边口径
   一旦分叉（例如写 `a/b`、查 `a/./b`），目录点进去就是空的，而错误不会以任何形式
   报出来；
2. **同名只管同一目录**——`a/报告.md` 与 `b/报告.md` 是两个文件，各该保原名；只有同一
   目录里的重名才需要 `(2)` 序号（这正是目录浏览要还原的东西）；
3. **内容判重仍是全库级**（同内容不重复索引），但报告里必须带上"重复于哪个目录"，
   否则用户在当前目录里根本找不到那个文件。
"""

import io
from datetime import datetime

import pytest
from fastapi import HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from api.knowledge_base import doc_service
from api.knowledge_base.doc_service import (
    MAX_FOLDER_LEN,
    list_documents,
    list_folders,
    normalize_folder,
    upload_documents,
)
from db.models.knowledge_base import KnowledgeBase
from db.models.knowledge_base_document import KnowledgeBaseDocument
from db.models.knowledge_base_entity import KnowledgeBaseEntity
from db.models.knowledge_base_grant import KnowledgeBaseGrant
from db.models.knowledge_base_index_task import KnowledgeBaseIndexTask
from db.models.knowledge_base_relation import KnowledgeBaseRelation
from db.models.knowledge_base_share import KnowledgeBaseShare
from unit_tests.test_indexing_reliability import RecordingScheduler

pytestmark = pytest.mark.anyio

USER_A = "user-a"
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


@pytest.fixture
def upload_root(monkeypatch, tmp_path):
    monkeypatch.setattr(doc_service.settings, "DOC_UPLOAD_DIR", str(tmp_path))
    monkeypatch.setattr(doc_service.settings, "KB_MAX_DOCS_PER_KB", 0)
    return tmp_path


class TestNormalizeFolder:
    """归一化矩阵。空/退化输入一律归到根目录，而不是抛错。"""

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("a/b", "a/b"),
            ("/a//b/./c/", "a/b/c"),
            ("a\\b", "a/b"),
            ("  资料 / 2024  ", "资料 / 2024"),
            # 越界与退化片段：丢弃（与 artifact_store.normalize_key 同一判定）
            ("a/../b", "a/b"),
            ("docs", "docs"),
        ],
    )
    def test_normalizes(self, raw: str, expected: str):
        assert normalize_folder(raw) == expected

    @pytest.mark.parametrize("raw", [None, "", "   ", "/", ".", "..", "../..", "///"])
    def test_degenerate_values_mean_root(self, raw):
        assert normalize_folder(raw) is None

    def test_too_long_is_rejected_with_400(self):
        with pytest.raises(HTTPException) as exc:
            normalize_folder("d" * (MAX_FOLDER_LEN + 1))
        assert exc.value.status_code == 400

    def test_control_characters_are_stripped_not_turned_into_levels(self):
        """控制字符去掉就完了，不能当成目录分隔符（那会凭空多出一级）。"""
        assert normalize_folder("a\r\nb") == "ab"


class TestFolderOnWrite:
    async def test_upload_records_folder_without_touching_storage_path(
        self, sessionmaker, upload_root,
    ):
        """folder 只是展示维度：磁盘布局必须仍与目录无关。"""
        await seed_kb(sessionmaker)
        async with sessionmaker() as db:
            outcome = await upload_documents(
                db, KB, USER_A, [upload_file("报告.md", b"# a\n")],
                folder="资料/2024",
            )
            await db.commit()
            row = (await db.execute(select(KnowledgeBaseDocument))).scalar_one()

        assert outcome.created[0].folder == "资料/2024"
        assert row.folder == "资料/2024"
        assert "资料" not in row.storage_path.replace("\\", "/"), (
            "目录不参与落盘——它只是知识库内的展示归属"
        )

    async def test_root_when_folder_missing_or_empty(self, sessionmaker, upload_root):
        await seed_kb(sessionmaker)
        async with sessionmaker() as db:
            first = await upload_documents(db, KB, USER_A, [upload_file("一.md", b"# 1\n")])
            second = await upload_documents(
                db, KB, USER_A, [upload_file("二.md", b"# 2\n")], folder="",
            )
            await db.commit()
        assert first.created[0].folder is None
        assert second.created[0].folder is None


class TestNameDisambiguationScope:
    """同名判定收窄到"同一目录"——这是目录浏览的直接前提。"""

    async def test_same_name_in_different_folders_keeps_both_names(
        self, sessionmaker, upload_root,
    ):
        await seed_kb(sessionmaker)
        async with sessionmaker() as db:
            a = await upload_documents(
                db, KB, USER_A, [upload_file("报告.md", "# A 版\n".encode())], folder="a",
            )
            b = await upload_documents(
                db, KB, USER_A, [upload_file("报告.md", "# B 版\n".encode())], folder="b",
            )
            await db.commit()

        assert [r.name for r in a.created] == ["报告.md"]
        assert [r.name for r in b.created] == ["报告.md"], (
            "不同目录的同名文件各该保原名，否则「按原始目录结构展示」就失真了"
        )

    async def test_same_name_in_same_folder_still_gets_suffix(
        self, sessionmaker, upload_root,
    ):
        await seed_kb(sessionmaker)
        async with sessionmaker() as db:
            first = await upload_documents(
                db, KB, USER_A, [upload_file("报告.md", "# 第一版\n".encode())], folder="a",
            )
            second = await upload_documents(
                db, KB, USER_A, [upload_file("报告.md", "# 第二版\n".encode())], folder="a",
            )
            await db.commit()

        assert [r.name for r in first.created] == ["报告.md"]
        assert [r.name for r in second.created] == ["报告(2).md"]

    async def test_same_batch_across_folders_keeps_names(
        self, sessionmaker, upload_root,
    ):
        """同一批里跨目录同名：两条都要保原名（序号只在同目录内产生）。"""
        await seed_kb(sessionmaker)
        async with sessionmaker() as db:
            outcome_a = await upload_documents(
                db, KB, USER_A, [upload_file("README.md", b"# from a\n")], folder="a",
            )
            outcome_b = await upload_documents(
                db, KB, USER_A, [upload_file("README.md", b"# from b\n")], folder="b",
            )
            await db.commit()
        assert [r.name for r in outcome_a.created] == ["README.md"]
        assert [r.name for r in outcome_b.created] == ["README.md"]

    async def test_root_folder_is_the_same_bucket_as_missing_folder(
        self, sessionmaker, upload_root,
    ):
        """根目录的新文档与存量（folder=NULL）的根文档同名时，仍要加序号。"""
        await seed_kb(sessionmaker)
        async with sessionmaker() as db:
            await upload_documents(db, KB, USER_A, [upload_file("a.md", b"# 1\n")])
            outcome = await upload_documents(
                db, KB, USER_A, [upload_file("a.md", b"# 2\n")], folder="",
            )
            await db.commit()
        assert [r.name for r in outcome.created] == ["a(2).md"]


class TestContentDedupAcrossFolders:
    async def test_duplicate_content_is_still_skipped_but_reports_folder(
        self, sessionmaker, upload_root,
    ):
        """判重是全库级的（同内容不重复索引），报告要说清重复于**哪个目录**。"""
        await seed_kb(sessionmaker)
        async with sessionmaker() as db:
            await upload_documents(
                db, KB, USER_A, [upload_file("旧版.md", "# 同样的内容\n".encode())], folder="sub",
            )
            outcome = await upload_documents(
                db, KB, USER_A, [upload_file("新版.md", "# 同样的内容\n".encode())], folder="another",
            )
            await db.commit()

        assert outcome.created == []
        skip = outcome.skipped[0]
        assert skip.reason == "duplicate"
        assert skip.existing_doc_name == "旧版.md"
        assert skip.existing_doc_folder == "sub", (
            "跨目录判重时不报路径，用户会在当前目录里找不到那个文件"
        )


class TestListDocumentsByFolder:
    async def _seed_tree(self, sessionmaker) -> None:
        await seed_kb(sessionmaker)
        async with sessionmaker() as db:
            await upload_documents(db, KB, USER_A, [upload_file("根.md", b"# root\n")])
            await upload_documents(
                db, KB, USER_A, [upload_file("甲.md", b"# a\n")], folder="a",
            )
            await upload_documents(
                db, KB, USER_A, [upload_file("乙.md", b"# b\n")], folder="a/b",
            )
            await db.commit()

    async def test_folder_is_three_state(self, sessionmaker, upload_root):
        await self._seed_tree(sessionmaker)
        async with sessionmaker() as db:
            all_docs = await list_documents(db, KB, USER_A)
            root = await list_documents(db, KB, USER_A, folder="")
            in_a = await list_documents(db, KB, USER_A, folder="a")
            in_ab = await list_documents(db, KB, USER_A, folder="a/b")

        assert {i["name"] for i in all_docs["items"]} == {"根.md", "甲.md", "乙.md"}
        assert all_docs["total"] == 3
        assert [i["name"] for i in root["items"]] == ["根.md"], (
            "空串 = 根目录（只给根自己的直属文档），不是「全库」"
        )
        assert [i["name"] for i in in_a["items"]] == ["甲.md"], (
            "目录过滤是**直属**的：a 里不该出现 a/b 的文档"
        )
        assert [i["name"] for i in in_ab["items"]] == ["乙.md"]
        assert root["total"] == 1 and in_a["total"] == 1

    async def test_response_carries_folder(self, sessionmaker, upload_root):
        await self._seed_tree(sessionmaker)
        async with sessionmaker() as db:
            all_docs = await list_documents(db, KB, USER_A)
        by_name = {i["name"]: i["folder"] for i in all_docs["items"]}
        assert by_name == {"根.md": None, "甲.md": "a", "乙.md": "a/b"}

    async def test_search_spans_all_folders(self, sessionmaker, upload_root):
        """搜索是跨目录的：搜索态下前端不传 folder，后端也不该按目录收窄。"""
        await self._seed_tree(sessionmaker)
        async with sessionmaker() as db:
            hit = await list_documents(db, KB, USER_A, search="乙")
        assert [i["name"] for i in hit["items"]] == ["乙.md"]
        assert hit["total"] == 1

    async def test_paging_is_stable_when_timestamps_tie(self, sessionmaker, upload_root):
        """同一时刻落库的一批文档翻页不许重复或漏行（目录上传是常态）。"""
        await seed_kb(sessionmaker)
        stamp = datetime(2026, 1, 1, 0, 0, 0)
        async with sessionmaker() as db:
            for index in range(7):
                db.add(KnowledgeBaseDocument(
                    id=f"doc-{index}", kb_id=KB, name=f"d{index}.md", type="md",
                    size_bytes=1, status="indexed", storage_path=f"/tmp/d{index}.md",
                    uploaded_at=stamp, folder="a",
                ))
            await db.commit()

        seen: list[str] = []
        async with sessionmaker() as db:
            for page in (1, 2, 3):
                chunk = await list_documents(db, KB, USER_A, page=page, page_size=3, folder="a")
                seen.extend(i["id"] for i in chunk["items"])

        assert len(seen) == 7 and len(set(seen)) == 7, (
            f"翻页出现重复或漏行：{seen}"
        )


class TestListFolders:
    async def test_aggregates_tree_with_intermediate_nodes(
        self, sessionmaker, upload_root,
    ):
        await seed_kb(sessionmaker)
        async with sessionmaker() as db:
            await upload_documents(db, KB, USER_A, [upload_file("根.md", b"# 0\n")])
            await upload_documents(
                db, KB, USER_A, [upload_file("甲.md", b"# 1\n")], folder="a/b/c",
            )
            await upload_documents(
                db, KB, USER_A, [upload_file("乙.md", b"# 2\n")], folder="a",
            )
            await db.commit()

        async with sessionmaker() as db:
            data = await list_folders(db, KB, USER_A)

        paths = {f["path"]: f for f in data["folders"]}
        assert set(paths) == {"a", "a/b", "a/b/c"}, (
            "中间节点必须补齐，否则 a/b/c 在界面上走不到"
        )
        assert paths["a"]["name"] == "a" and paths["a"]["parent"] == ""
        assert paths["a/b"]["parent"] == "a" and paths["a/b"]["doc_count"] == 0
        assert paths["a/b/c"]["doc_count"] == 1
        assert paths["a"]["doc_count"] == 1
        assert data["root_count"] == 1
        assert data["total"] == 3

    async def test_empty_kb(self, sessionmaker, upload_root):
        await seed_kb(sessionmaker)
        async with sessionmaker() as db:
            data = await list_folders(db, KB, USER_A)
        assert data == {"folders": [], "root_count": 0, "total": 0}


class TestRouteOrdering:
    def test_folders_route_is_declared_before_doc_id(self):
        """``/documents/folders`` 必须排在 ``/documents/{doc_id}`` 之前。

        FastAPI 按声明顺序匹配：排在后面的话 ``folders`` 会被当成 doc_id 命中详情
        路由，返回 404「文档不存在」——一个"看起来在跑、返回的却是另一种错"的陷阱。
        这条断言不需要起服务，直接盯住路由表，改动顺序就会红。
        """
        from api.knowledge_base.doc_api import router

        paths = [getattr(route, "path", "") for route in router.routes]
        folders = "/api/knowledge-bases/{kb_id}/documents/folders"
        detail = "/api/knowledge-bases/{kb_id}/documents/{doc_id}"
        assert folders in paths, "目录清单路由不见了"
        assert paths.index(folders) < paths.index(detail)


class TestSchedulerStillSeesFlatPaths:
    async def test_indexing_task_uses_storage_path(self, sessionmaker, upload_root):
        """索引任务走 storage_path（与目录无关）——加了 folder 也不能影响它。"""
        await seed_kb(sessionmaker)
        scheduler = RecordingScheduler()
        async with sessionmaker() as db:
            outcome = await upload_documents(
                db, KB, USER_A, [upload_file("甲.md", b"# 1\n")],
                scheduler, folder="a/b",
            )
            await db.commit()
            row = (await db.execute(select(KnowledgeBaseDocument))).scalar_one()

        assert scheduler.enqueued == [outcome.created[0].id]
        assert row.storage_path.replace("\\", "/").endswith("/甲.md")
        assert "/a/b/" not in row.storage_path.replace("\\", "/")
