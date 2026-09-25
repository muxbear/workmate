"""迁移机制与软删除（迭代 5 T5.6）。

两件事必须可靠：

1. **迁移机制**：能发现版本、按序应用、按序回滚，且"有回滚脚本"这件事不能被
   文件扫描顺序影响（``.down.sql`` 按字典序排在主文件之前——一遍扫描会漏）；
2. **软删除**：删掉的库要**对所有查询**都不可见。这里的关键不是"某条查询过滤了"，
   而是"全局过滤器装上之后，任何 ORM 查询都自动过滤"——单测的内存库不经过
   `init_db`，因此必须显式安装，否则测的是"没装过滤器时的行为"，等于没测。
"""

import pytest
from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from db.migrate import applied_versions, apply_pending, discover, rollback_last
from db.models.knowledge_base import KnowledgeBase
from db.models.knowledge_base_document import KnowledgeBaseDocument

pytestmark = pytest.mark.anyio


@pytest.fixture
def migrations_dir(tmp_path):
    """两个迁移（SQLite 可执行）+ 回滚脚本，用于验证机制本身。"""
    (tmp_path / "0001_first.sql").write_text(
        "CREATE TABLE t_one (id INTEGER PRIMARY KEY);", encoding="utf-8",
    )
    (tmp_path / "0001_first.down.sql").write_text(
        "DROP TABLE IF EXISTS t_one;", encoding="utf-8",
    )
    (tmp_path / "0002_second.sql").write_text(
        "CREATE TABLE t_two (id INTEGER PRIMARY KEY);", encoding="utf-8",
    )
    (tmp_path / "0002_second.down.sql").write_text(
        "DROP TABLE IF EXISTS t_two;", encoding="utf-8",
    )
    return tmp_path


class TestDiscovery:
    def test_finds_versions_in_order(self, migrations_dir):
        versions = [m.version for m in discover(migrations_dir)]

        assert versions == ["0001", "0002"]

    def test_rollback_scripts_are_attached(self, migrations_dir):
        """回归：``.down.sql`` 字典序在前，一遍扫描会把它丢掉——
        表现是"明明写了回滚脚本，却报没有"。"""
        for migration in discover(migrations_dir):
            assert migration.has_rollback, f"{migration.version} 的回滚脚本没被关联"

    def test_missing_directory_is_not_fatal(self, tmp_path):
        assert discover(tmp_path / "nope") == []

    def test_real_migration_has_rollback(self):
        """仓库里真实的迁移也必须带回滚脚本（方案要求可回滚）。"""
        for migration in discover():
            assert migration.has_rollback, f"{migration.version} 缺少回滚脚本"


class TestApplyAndRollback:
    @pytest.fixture
    async def conn(self):
        engine = create_async_engine(
            "sqlite+aiosqlite://",
            poolclass=StaticPool,
            connect_args={"check_same_thread": False},
        )
        async with engine.begin() as connection:
            yield connection
        await engine.dispose()

    async def test_apply_then_status(self, conn, migrations_dir):
        applied = await apply_pending(conn, migrations_dir)

        assert applied == ["0001", "0002"]
        assert await applied_versions(conn) == ["0001", "0002"]

    async def test_apply_is_idempotent(self, conn, migrations_dir):
        await apply_pending(conn, migrations_dir)

        assert await apply_pending(conn, migrations_dir) == []

    async def test_rollback_removes_objects_and_version(self, conn, migrations_dir):
        await apply_pending(conn, migrations_dir)

        rolled = await rollback_last(conn, 1, migrations_dir)

        assert rolled == ["0002"]
        assert await applied_versions(conn) == ["0001"]
        with pytest.raises(Exception):
            await conn.execute(text("SELECT * FROM t_two"))

    async def test_rollback_goes_from_the_end(self, conn, migrations_dir):
        """只允许从末尾往回滚：跳着滚会留下中间态。"""
        await apply_pending(conn, migrations_dir)

        assert await rollback_last(conn, 2, migrations_dir) == ["0002", "0001"]
        assert await applied_versions(conn) == []

    async def test_rollback_uses_the_given_directory(self, conn, tmp_path):
        """回归：回滚要按**传入目录**里的定义执行。

        此前这里写死默认目录，于是"回滚某个目录里应用的 0001"会去取仓库里真实 0001 的
        回滚脚本——滚错迁移比不滚更危险。这条用例故意用与仓库真实迁移**撞号**的 0001：
        若取了默认目录的定义，执行的就不是这里的 DROP TABLE（实现前实测：SQLite 上直接
        报 `ALTER TABLE ... DROP COLUMN IF EXISTS` 语法错）。
        """
        (tmp_path / "0001_first.sql").write_text(
            "CREATE TABLE t_one (id INTEGER PRIMARY KEY);", encoding="utf-8",
        )
        (tmp_path / "0001_first.down.sql").write_text(
            "DROP TABLE IF EXISTS t_one;", encoding="utf-8",
        )
        await apply_pending(conn, tmp_path)

        assert await rollback_last(conn, 1, tmp_path) == ["0001"]

        with pytest.raises(Exception):
            await conn.execute(text("SELECT * FROM t_one"))
        assert await applied_versions(conn) == []

    async def test_rollback_without_script_is_refused(self, conn, tmp_path):
        (tmp_path / "0001_only.sql").write_text(
            "CREATE TABLE t_x (id INTEGER PRIMARY KEY);", encoding="utf-8",
        )
        await apply_pending(conn, tmp_path)

        with pytest.raises(RuntimeError, match="没有回滚脚本"):
            await rollback_last(conn, 1, tmp_path)


@pytest.fixture
async def maker():
    """知识库相关的全套表 + 生产同款的部分唯一索引。

    软删除用例与唯一约束用例共用：前者要 ``purge_kb`` 能清空全部子表（缺一张就测不到
    完整行为），后者要真的撞上索引——只测应用层"先查后插"那条路径，恰恰是并发下会漏的
    那条，测了等于没测。
    """
    from db.models.knowledge_base_entity import KnowledgeBaseEntity
    from db.models.knowledge_base_index_task import KnowledgeBaseIndexTask
    from db.models.knowledge_base_relation import KnowledgeBaseRelation
    from db.models.knowledge_base_share import KnowledgeBaseShare
    from db.soft_delete import install_soft_delete_filter

    install_soft_delete_filter()   # 幂等
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        for table in (
            KnowledgeBase.__table__,
            KnowledgeBaseDocument.__table__,
            KnowledgeBaseEntity.__table__,
            KnowledgeBaseRelation.__table__,
            KnowledgeBaseShare.__table__,
            KnowledgeBaseIndexTask.__table__,
        ):
            await conn.run_sync(table.create)
        # 生产库上的部分唯一索引（见 migrations/0001）
        await conn.execute(text(
            "CREATE UNIQUE INDEX uq_kb_user_name ON knowledge_bases (user_id, name) "
            "WHERE deleted_at IS NULL"
        ))
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


class TestSoftDelete:
    """软删除：删掉的库对**所有** ORM 查询不可见（由全局过滤器保证，不靠人工补条件）。"""

    async def _seed(self, maker, kb_id: str = "kb-1", name: str = "库") -> None:
        async with maker() as db:
            db.add(KnowledgeBase(
                id=kb_id, name=name, description="", user_id="u1", status="ready",
                config={}, tags=[], visibility="private",
            ))
            await db.commit()

    async def _soft_delete(self, maker, kb_id: str = "kb-1") -> None:
        from datetime import datetime

        async with maker() as db:
            kb = (
                await db.execute(select(KnowledgeBase).where(KnowledgeBase.id == kb_id))
            ).scalar_one()
            kb.deleted_at = datetime.utcnow()
            await db.commit()

    async def test_deleted_kb_is_invisible_to_plain_select(self, maker):
        """关键用例：**不写任何过滤条件**的查询也看不到它。"""
        await self._seed(maker)
        await self._soft_delete(maker)

        async with maker() as db:
            rows = (await db.execute(select(KnowledgeBase))).scalars().all()

        assert rows == []

    async def test_include_deleted_sees_it_again(self, maker):
        from db.soft_delete import include_deleted

        await self._seed(maker)
        await self._soft_delete(maker)

        with include_deleted():
            async with maker() as db:
                rows = (await db.execute(select(KnowledgeBase))).scalars().all()

        assert [r.id for r in rows] == ["kb-1"]

    async def test_filter_does_not_leak_outside_scope(self, maker):
        from db.soft_delete import include_deleted

        await self._seed(maker)
        await self._soft_delete(maker)
        with include_deleted():
            pass

        async with maker() as db:
            assert (await db.execute(select(KnowledgeBase))).scalars().all() == []

    async def test_restore_brings_it_back(self, maker):
        from api.knowledge_base.service import restore_kb

        await self._seed(maker)
        await self._soft_delete(maker)

        async with maker() as db:
            await restore_kb(db, "kb-1", "u1")
            await db.commit()

        async with maker() as db:
            assert len((await db.execute(select(KnowledgeBase))).scalars().all()) == 1

    async def test_restore_rejects_when_name_is_taken(self, maker):
        """删除后同名重建是允许的（部分唯一索引），此时恢复必须给出可读冲突提示。"""
        from fastapi import HTTPException

        from api.knowledge_base.service import restore_kb

        await self._seed(maker, "kb-1", "手册")
        await self._soft_delete(maker, "kb-1")
        await self._seed(maker, "kb-2", "手册")   # 删除后用同名重建

        async with maker() as db:
            with pytest.raises(HTTPException) as exc:
                await restore_kb(db, "kb-1", "u1")

        assert exc.value.status_code == 409
        assert "同名" in exc.value.detail

    async def test_restore_rejects_non_deleted_kb(self, maker):
        from fastapi import HTTPException

        from api.knowledge_base.service import restore_kb

        await self._seed(maker)

        async with maker() as db:
            with pytest.raises(HTTPException) as exc:
                await restore_kb(db, "kb-1", "u1")

        assert exc.value.status_code == 400

    async def test_purge_removes_everything(self, maker):
        """彻底删除是软删除之外的显式出口——否则被删的库永远占着向量与磁盘。"""
        from api.knowledge_base.service import purge_kb

        await self._seed(maker)
        async with maker() as db:
            db.add(KnowledgeBaseDocument(
                id="d1", kb_id="kb-1", name="文档", type="md", size_bytes=1,
                storage_path="/tmp/x.md", status="indexed",
            ))
            await db.commit()
        await self._soft_delete(maker)

        async with maker() as db:
            await purge_kb(db, "kb-1", "u1")
            await db.commit()

        async with maker() as db:
            assert (await db.execute(select(KnowledgeBase))).scalars().all() == []
            assert (await db.execute(select(KnowledgeBaseDocument))).scalars().all() == []

    async def test_purge_rejects_other_users_kb(self, maker):
        from fastapi import HTTPException

        from api.knowledge_base.service import purge_kb

        await self._seed(maker)

        async with maker() as db:
            with pytest.raises(HTTPException) as exc:
                await purge_kb(db, "kb-1", "u2")

        assert exc.value.status_code == 404


class TestDuplicateNameIsIntercepted:
    """唯一约束：并发重名由**数据库**拦住，并如实翻译成 409（T5.6 验收项）。

    应用层在插入前先查了一次重名，但并发下两个请求可以同时查不到、同时插入——所以
    这里刻意绕过预检查，直接制造"数据库看到重名"的那一刻。只测预检查那条路径，
    测的正是并发下会漏的那条。
    """

    async def _seed(self, maker, kb_id: str = "kb-1", name: str = "手册",
                    user_id: str = "u1") -> None:
        async with maker() as db:
            db.add(KnowledgeBase(
                id=kb_id, name=name, description="", user_id=user_id, status="ready",
                config={}, tags=[], visibility="private",
            ))
            await db.commit()

    async def test_concurrent_duplicate_insert_becomes_409(self, maker):
        from api.knowledge_base.service import _flush_or_name_conflict

        await self._seed(maker)

        async with maker() as db:
            # 模拟并发的第二个请求：它的预检查发生在第一个请求提交之前，因此没查到
            db.add(KnowledgeBase(
                id="kb-2", name="手册", description="", user_id="u1", status="draft",
                config={}, tags=[], visibility="private",
            ))
            with pytest.raises(HTTPException) as exc:
                await _flush_or_name_conflict(db, "手册")

        assert exc.value.status_code == 409
        assert "已存在" in exc.value.detail

    async def test_session_is_usable_after_conflict(self, maker):
        """撞约束后必须回滚：事务留在中止状态的话，依赖注入收尾时的 commit 会再炸一次，
        用户看到的仍然是 500——那这个修复就白做了。"""
        from api.knowledge_base.service import _flush_or_name_conflict

        await self._seed(maker)

        async with maker() as db:
            db.add(KnowledgeBase(
                id="kb-2", name="手册", description="", user_id="u1", status="draft",
                config={}, tags=[], visibility="private",
            ))
            with pytest.raises(HTTPException):
                await _flush_or_name_conflict(db, "手册")

            rows = (await db.execute(select(KnowledgeBase))).scalars().all()
            await db.commit()   # 回滚过了，这里不该再抛

        assert [r.id for r in rows] == ["kb-1"]

    async def test_renaming_onto_an_existing_name_is_409(self, maker):
        """改名是第二条会撞索引的路径——此前它是个 500。"""
        from api.knowledge_base.schemas import KBUpdateRequest
        from api.knowledge_base.service import update_kb

        await self._seed(maker, "kb-1", "手册")
        await self._seed(maker, "kb-2", "运维笔记")

        async with maker() as db:
            with pytest.raises(HTTPException) as exc:
                await update_kb(db, "kb-2", "u1", KBUpdateRequest(name="手册"))

        assert exc.value.status_code == 409

    async def test_same_name_is_allowed_for_another_user(self, maker):
        """唯一性是「同一用户下」的：别人叫这个名字不影响我。"""
        from api.knowledge_base.service import _flush_or_name_conflict

        await self._seed(maker, "kb-1", "手册", user_id="u1")

        async with maker() as db:
            db.add(KnowledgeBase(
                id="kb-2", name="手册", description="", user_id="u2", status="draft",
                config={}, tags=[], visibility="private",
            ))
            await _flush_or_name_conflict(db, "手册")   # 不该抛
            await db.commit()
