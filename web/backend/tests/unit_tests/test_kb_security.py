"""知识库安全与检索退化问题的回归测试（迭代 0）。

覆盖四类已修复的阻断问题：

- **上传文件名路径穿越**（``_sanitize_filename`` / ``_ensure_within``）——
  此前 ``../../x.md`` 与 Windows 绝对路径都能写出上传目录；
- **列表搜索绕过可见性过滤**（``list_kbs``）——此前 ``text("name LIKE OR
  description LIKE")`` 与 scope 条件平铺，SQL 优先级导致 search 分支没有权限过滤；
- **向量库表达式注入**（``safe_expr_id``）——此前 ID 直接拼进 Milvus expr；
- **hybrid 权重全零退化**（``_fuse_scores``）——此前会按 chunk_id 的 UUID 字典序
  返回结果、分数全为 0。
"""

import io
from pathlib import Path

import pytest
from fastapi import HTTPException, UploadFile
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from api.knowledge_base import doc_service
from api.knowledge_base.doc_service import (
    _ensure_within,
    _sanitize_filename,
    upload_documents,
)
from api.knowledge_base.search_service import _fuse_scores
from api.knowledge_base.service import _like_pattern, list_kbs
from core.rag.vector_store import safe_expr_id
from db.models.knowledge_base import KnowledgeBase
from db.models.knowledge_base_document import KnowledgeBaseDocument
from db.models.knowledge_base_entity import KnowledgeBaseEntity
from db.models.knowledge_base_relation import KnowledgeBaseRelation

pytestmark = pytest.mark.anyio

USER_A = "user-a"
USER_B = "user-b"


# ─── T0.1 上传文件名净化 ─────────────────────────────────────────────────────


class TestFilenameSanitization:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("../../evil.md", "evil.md"),
            ("..\\..\\evil.md", "evil.md"),
            ("/etc/passwd.md", "passwd.md"),
            ("C:\\Windows\\evil.json", "evil.json"),
            ("sub/dir/report.md", "report.md"),
            ("正常文档.md", "正常文档.md"),
            ("  spaced.md  ", "spaced.md"),
        ],
    )
    def test_traversal_is_stripped_to_basename(self, raw: str, expected: str):
        assert _sanitize_filename(raw) == expected

    @pytest.mark.parametrize("raw", ["", "   ", ".", "..", "./", "../"])
    def test_degenerate_names_are_rejected(self, raw: str):
        with pytest.raises(HTTPException) as exc:
            _sanitize_filename(raw)
        assert exc.value.status_code == 400

    def test_control_characters_removed(self):
        assert _sanitize_filename("a\x00b\x1f.md") == "ab.md"

    def test_within_allows_nested_path(self, tmp_path: Path):
        target = tmp_path / "kb" / "doc" / "a.md"
        assert _ensure_within(str(target), str(tmp_path / "kb")) == str(target)

    def test_within_rejects_sibling_with_shared_prefix(self, tmp_path: Path):
        """``kb-evil`` 不能因为字符串前缀相同而被放行。"""
        with pytest.raises(HTTPException):
            _ensure_within(str(tmp_path / "kb-evil" / "a.md"), str(tmp_path / "kb"))

    def test_within_rejects_escaped_path(self, tmp_path: Path):
        with pytest.raises(HTTPException):
            _ensure_within(str(tmp_path / "kb" / ".." / "outside.md"), str(tmp_path / "kb"))


@pytest.fixture
async def sessionmaker():
    """内存 SQLite 会话工厂（建知识库相关的四张表）。"""
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        await conn.run_sync(KnowledgeBase.__table__.create)
        await conn.run_sync(KnowledgeBaseDocument.__table__.create)
        # 计数重算（recalc_kb_counters）会查询图谱两张表
        await conn.run_sync(KnowledgeBaseEntity.__table__.create)
        await conn.run_sync(KnowledgeBaseRelation.__table__.create)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    yield maker
    await engine.dispose()


def upload_file(filename: str, content: bytes = b"# title\n") -> UploadFile:
    return UploadFile(file=io.BytesIO(content), filename=filename)


class TestUploadPathTraversal:
    """上传接口必须拒绝穿越文件名，且失败时不在磁盘留下任何文件。"""

    async def _seed_kb(self, sessionmaker) -> None:
        async with sessionmaker() as session:
            session.add(KnowledgeBase(
                id="kb-a", name="库", user_id=USER_A, status="ready",
                description="", config={}, tags=[], visibility="private",
            ))
            await session.commit()

    async def test_traversal_filename_cannot_escape_upload_dir(
        self, sessionmaker, monkeypatch, tmp_path: Path,
    ):
        """``../../evil.md`` 只保留基名，落盘仍在上传目录内。"""
        await self._seed_kb(sessionmaker)
        monkeypatch.setattr(doc_service.settings, "DOC_UPLOAD_DIR", str(tmp_path))

        async with sessionmaker() as session:
            await upload_documents(
                session, "kb-a", USER_A, [upload_file("../../evil.md")],
            )

        written = list(tmp_path.rglob("evil.md"))
        assert len(written) == 1
        # 上传目录之外（tmp_path 的父目录）不得出现该文件
        assert not (tmp_path.parent / "evil.md").exists()
        assert written[0].parent.parent.name == "kb-a"

    async def test_absolute_path_filename_is_stored_as_basename(
        self, sessionmaker, monkeypatch, tmp_path: Path,
    ):
        """Windows 绝对路径同样只保留基名（os.path.join 会丢弃前缀）。"""
        await self._seed_kb(sessionmaker)
        monkeypatch.setattr(doc_service.settings, "DOC_UPLOAD_DIR", str(tmp_path))

        async with sessionmaker() as session:
            results = await upload_documents(
                session, "kb-a", USER_A, [upload_file("C:\\Windows\\evil.json")],
            )

        assert results.created[0].name == "evil.json"
        written = list(tmp_path.rglob("evil.json"))
        assert len(written) == 1
        assert written[0].parent.parent.name == "kb-a"

    async def test_valid_upload_lands_inside_kb_directory(
        self, sessionmaker, monkeypatch, tmp_path: Path,
    ):
        await self._seed_kb(sessionmaker)
        monkeypatch.setattr(doc_service.settings, "DOC_UPLOAD_DIR", str(tmp_path))

        async with sessionmaker() as session:
            results = await upload_documents(
                session, "kb-a", USER_A, [upload_file("报告.md")],
            )

        assert len(results.created) == 1
        written = list(tmp_path.rglob("报告.md"))
        assert len(written) == 1
        assert written[0].parent.parent.name == "kb-a"

    async def test_upload_response_carries_progress_fields(
        self, sessionmaker, monkeypatch, tmp_path: Path,
    ):
        """上传响应必须与文档列表同形状，否则前端进度条渲染出 NaN。"""
        await self._seed_kb(sessionmaker)
        monkeypatch.setattr(doc_service.settings, "DOC_UPLOAD_DIR", str(tmp_path))

        async with sessionmaker() as session:
            results = await upload_documents(
                session, "kb-a", USER_A, [upload_file("a.md")],
            )
        payload = results.created[0].model_dump()

        for field in (
            "progress", "chunks_count", "entities_count", "relations_count", "stages",
        ):
            assert field in payload
        assert payload["progress"] == 0
        assert payload["stages"][0]["status"] == "running"


# ─── T0.2 列表搜索的可见性过滤 ────────────────────────────────────────────────


class TestListSearchScope:
    @pytest.fixture(autouse=True)
    def _no_owner_lookup(self, monkeypatch):
        """owner 昵称需要 account 表；本组测试只关心可见性过滤。"""
        async def fake_owner_names(db, user_ids):
            return {}
        monkeypatch.setattr(
            "api.knowledge_base.service._load_owner_names", fake_owner_names,
        )

    async def _seed(self, sessionmaker) -> None:
        async with sessionmaker() as session:
            session.add(KnowledgeBase(
                id="kb-b", name="私密方案", user_id=USER_B, status="ready",
                description="含关键词 绝密 的描述", config={}, tags=[],
                visibility="private",
            ))
            session.add(KnowledgeBase(
                id="kb-a", name="我的库", user_id=USER_A, status="ready",
                description="我的描述", config={}, tags=[], visibility="private",
            ))
            await session.commit()

    async def test_search_does_not_leak_other_users_kb_by_name(self, sessionmaker):
        await self._seed(sessionmaker)
        async with sessionmaker() as session:
            resp = await list_kbs(session, USER_A, search="私密")

        assert resp.total == 0
        assert resp.items == []

    async def test_search_does_not_leak_other_users_kb_by_description(self, sessionmaker):
        """按描述命中是此前 SQL 优先级漏洞的主路径（description 分支无 scope）。"""
        await self._seed(sessionmaker)
        async with sessionmaker() as session:
            resp = await list_kbs(session, USER_A, search="绝密")

        assert resp.total == 0
        assert resp.items == []

    async def test_search_still_finds_own_kb(self, sessionmaker):
        await self._seed(sessionmaker)
        async with sessionmaker() as session:
            resp = await list_kbs(session, USER_A, search="我的")

        assert [item.id for item in resp.items] == ["kb-a"]

    async def test_search_scope_public_only_returns_public(self, sessionmaker):
        await self._seed(sessionmaker)
        async with sessionmaker() as session:
            resp = await list_kbs(session, USER_A, search="私密", scope="public")

        assert resp.total == 0

    def test_like_pattern_escapes_wildcards(self):
        assert _like_pattern("a_b") == "%a\\_b%"
        assert _like_pattern("100%") == "%100\\%%"
        assert _like_pattern("c:\\x") == "%c:\\\\x%"


# ─── T0.5 向量库表达式注入 ────────────────────────────────────────────────────


class TestSafeExprId:
    def test_uuid_is_allowed(self):
        value = "5a28d123-ef33-49d1-b2a9-336ebd60f5b7"
        assert safe_expr_id(value) == value

    @pytest.mark.parametrize(
        "value",
        [
            'x" or id != "',
            'a" and doc_id == "b',
            "id in [1,2]",
            "x\n",
            "",
            "a" * 65,
            "切片 id",
        ],
    )
    def test_injection_attempts_are_rejected(self, value: str):
        with pytest.raises(ValueError):
            safe_expr_id(value)


# ─── T0.8 hybrid 权重全零退化 ─────────────────────────────────────────────────


class TestFuseScoresDegenerate:
    """两路权重之和恒为 1，因此至多一路权重为 0；此时不能退化成 UUID 排序。"""

    def test_alpha_zero_with_sparse_disabled_returns_vector_results(self):
        vec = [("zzz", 0.9), ("aaa", 0.5)]
        result = _fuse_scores(vec, [], top_k=2, alpha=0.0)

        assert [c.chunk_id for c in result] == ["zzz", "aaa"]
        # 回传原始分：末位不应被归一化成 0.0（那看起来像"完全无关"）
        assert [c.score for c in result] == [0.9, 0.5]
        assert all(c.score > 0 for c in result)

    def test_alpha_one_with_empty_vector_returns_bm25_results(self):
        bm25 = [("zzz", 9.0), ("aaa", 3.0)]
        result = _fuse_scores([], bm25, top_k=2, alpha=1.0)

        assert [c.chunk_id for c in result] == ["zzz", "aaa"]
        assert result[0].bm25_score is not None
        assert result[0].vec_score is None

    def test_both_channels_empty_returns_empty(self):
        assert _fuse_scores([], [], top_k=5, alpha=0.5) == []

    def test_order_is_not_uuid_lexicographic(self):
        """回归：此前 rrf 全为 0 时按 chunk_id 字典序返回。"""
        vec = [("ffff", 0.99), ("0000", 0.11)]
        result = _fuse_scores(vec, [], top_k=2, alpha=0.0)

        assert [c.chunk_id for c in result] == ["ffff", "0000"]
