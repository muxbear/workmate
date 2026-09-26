"""索引链路可靠性测试（迭代 1）。

覆盖此前的实际缺陷：

- 队列只在进程内存里：重启后队列丢失，进行中的文档永久卡在中间态且不可重试；
- 入队早于事务提交，进度观察者（独立 session）会更新到 0 行或被覆盖回 queued；
- 任务无超时/取消，一次挂死会永久占用并发槽；
- 重试不清理旧向量 → 同一文档出现重复切片；
- 删除文档/知识库不取消在跑任务 → 孤儿向量；
- 冗余计数漂移（实体数取 distinct name，与图谱页签渲染的行数不一致）。
"""

import asyncio
from datetime import datetime

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from api.knowledge_base.doc_service import (
    IndexingScheduler,
    IndexingTask,
    cancel_document,
    delete_document,
    recalc_kb_counters,
    retry_document,
)
from db.models.knowledge_base import KnowledgeBase
from db.models.knowledge_base_document import KnowledgeBaseDocument
from db.models.knowledge_base_entity import KnowledgeBaseEntity
from db.models.knowledge_base_index_task import (
    TASK_STATUS_CANCELED,
    TASK_STATUS_QUEUED,
    TASK_STATUS_RUNNING,
    KnowledgeBaseIndexTask,
)
from db.models.knowledge_base_relation import KnowledgeBaseRelation

pytestmark = pytest.mark.anyio

USER = "user-a"
KB = "kb-a"


@pytest.fixture
async def sessionmaker():
    """内存 SQLite：知识库相关全部表。"""
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


async def seed_kb(sessionmaker, kb_id: str = KB) -> None:
    async with sessionmaker() as db:
        db.add(KnowledgeBase(
            id=kb_id, name="库", user_id=USER, status="ready",
            description="", config={}, tags=[], visibility="private",
        ))
        await db.commit()


async def seed_doc(sessionmaker, doc_id: str = "doc-1", status: str = "queued") -> None:
    async with sessionmaker() as db:
        db.add(KnowledgeBaseDocument(
            id=doc_id, kb_id=KB, name=f"{doc_id}.md", type="md", size_bytes=10,
            status=status, progress=0, storage_path=f"/tmp/{doc_id}.md",
        ))
        await db.commit()


async def seed_task(
    sessionmaker,
    doc_id: str = "doc-1",
    status: str = TASK_STATUS_QUEUED,
) -> None:
    async with sessionmaker() as db:
        db.add(KnowledgeBaseIndexTask(
            id=f"task-{doc_id}", doc_id=doc_id, kb_id=KB, status=status,
            attempt=1, file_path=f"/tmp/{doc_id}.md", file_type="md", config={},
            heartbeat_at=datetime.utcnow(),
        ))
        await db.commit()


async def get_task(sessionmaker, doc_id: str = "doc-1") -> KnowledgeBaseIndexTask | None:
    from sqlalchemy import select

    async with sessionmaker() as db:
        return (
            await db.execute(
                select(KnowledgeBaseIndexTask).where(
                    KnowledgeBaseIndexTask.doc_id == doc_id
                )
            )
        ).scalar_one_or_none()


async def get_doc(sessionmaker, doc_id: str = "doc-1") -> KnowledgeBaseDocument | None:
    from sqlalchemy import select

    async with sessionmaker() as db:
        return (
            await db.execute(
                select(KnowledgeBaseDocument).where(KnowledgeBaseDocument.id == doc_id)
            )
        ).scalar_one_or_none()


class BlockingPipeline:
    """可控流水线：execute 挂起直到 release，便于观察并发与取消。"""

    def __init__(self):
        self.started: list[str] = []
        self.finished: list[str] = []
        self.gate = asyncio.Event()
        self.fail_with: Exception | None = None

    async def execute(self, task: IndexingTask) -> None:
        self.started.append(task.doc_id)
        await self.gate.wait()
        if self.fail_with is not None:
            raise self.fail_with
        self.finished.append(task.doc_id)


@pytest.fixture
def make_scheduler(sessionmaker):
    """构造独立调度器实例（绕开单例，避免用例互相污染）。"""
    created: list[IndexingScheduler] = []

    def _make(pipeline, max_concurrent: int = 3) -> IndexingScheduler:
        IndexingScheduler._instance = None  # type: ignore[attr-defined]
        scheduler = IndexingScheduler(
            pipeline=pipeline,
            max_concurrent=max_concurrent,
            session_factory=sessionmaker,
        )
        created.append(scheduler)
        return scheduler

    yield _make
    IndexingScheduler._instance = None  # type: ignore[attr-defined]


def make_task(doc_id: str = "doc-1") -> IndexingTask:
    return IndexingTask(
        kb_id=KB, doc_id=doc_id, file_path=f"/tmp/{doc_id}.md",
        file_type="md", config={},
    )


# ─── 任务持久化 ──────────────────────────────────────────────────────────────


class TestTaskPersistence:
    async def test_enqueue_writes_task_row(
        self, sessionmaker, make_scheduler,
    ):
        await seed_kb(sessionmaker)
        pipeline = BlockingPipeline()
        scheduler = make_scheduler(pipeline)

        await scheduler.enqueue(make_task())
        await asyncio.sleep(0)

        row = await get_task(sessionmaker)
        assert row is not None
        assert row.status in (TASK_STATUS_QUEUED, TASK_STATUS_RUNNING)
        assert row.attempt == 1
        assert row.kb_id == KB

        pipeline.gate.set()
        await scheduler.shutdown()

    async def test_repeat_enqueue_increments_attempt(
        self, sessionmaker, make_scheduler,
    ):
        """同一文档重复入队只累加尝试次数，不产生重复任务行。"""
        await seed_kb(sessionmaker)
        pipeline = BlockingPipeline()
        scheduler = make_scheduler(pipeline)

        await scheduler.enqueue(make_task())
        await scheduler.enqueue(make_task())

        row = await get_task(sessionmaker)
        assert row is not None
        assert row.attempt == 2

        pipeline.gate.set()
        await scheduler.shutdown()

    async def test_concurrency_limit_is_enforced(
        self, sessionmaker, make_scheduler,
    ):
        """并发上限生效：超出部分留在队列里，空出槽位后自动启动。"""
        await seed_kb(sessionmaker)
        pipeline = BlockingPipeline()
        scheduler = make_scheduler(pipeline, max_concurrent=2)

        await scheduler.enqueue(make_task("doc-1"))
        await scheduler.enqueue(make_task("doc-2"))
        await scheduler.enqueue(make_task("doc-3"))
        await asyncio.sleep(0)

        assert sorted(pipeline.started) == ["doc-1", "doc-2"]

        pipeline.gate.set()
        await asyncio.sleep(0.05)
        assert "doc-3" in pipeline.started

        await scheduler.shutdown()

    async def test_missing_pipeline_logs_and_keeps_queue(
        self, sessionmaker, make_scheduler,
    ):
        """没有绑定流水线时不得静默崩掉（此前会 AttributeError）。"""
        await seed_kb(sessionmaker)
        scheduler = make_scheduler(None)

        await scheduler.enqueue(make_task())
        await asyncio.sleep(0)
        # 任务已落库但未执行
        row = await get_task(sessionmaker)
        assert row is not None


# ─── 启动恢复 ────────────────────────────────────────────────────────────────


class TestStartupRecovery:
    async def test_pending_tasks_are_requeued_and_docs_reset(
        self, sessionmaker, make_scheduler,
    ):
        """服务重启后：中断的文档回到 queued，任务重新入队。"""
        await seed_kb(sessionmaker)
        await seed_doc(sessionmaker, "doc-1", status="embedding")
        await seed_doc(sessionmaker, "doc-2", status="queued")
        await seed_task(sessionmaker, "doc-1", status=TASK_STATUS_RUNNING)
        await seed_task(sessionmaker, "doc-2", status=TASK_STATUS_QUEUED)

        pipeline = BlockingPipeline()
        scheduler = make_scheduler(pipeline, max_concurrent=1)

        recovered = await scheduler.recover_pending()
        await asyncio.sleep(0)

        assert recovered == 2
        doc1 = await get_doc(sessionmaker, "doc-1")
        assert doc1 is not None and doc1.status == "queued"
        task1 = await get_task(sessionmaker, "doc-1")
        assert task1 is not None and task1.status == TASK_STATUS_QUEUED

        pipeline.gate.set()
        await scheduler.shutdown()

    async def test_terminal_tasks_are_not_recovered(
        self, sessionmaker, make_scheduler,
    ):
        await seed_kb(sessionmaker)
        await seed_doc(sessionmaker, "doc-1", status="indexed")
        await seed_task(sessionmaker, "doc-1", status="succeeded")

        pipeline = BlockingPipeline()
        scheduler = make_scheduler(pipeline)

        assert await scheduler.recover_pending() == 0
        await scheduler.shutdown()

    async def test_orphan_task_row_is_removed(
        self, sessionmaker, make_scheduler,
    ):
        """文档已被删除的任务行是孤儿，恢复时应清理掉。"""
        await seed_kb(sessionmaker)
        await seed_task(sessionmaker, "doc-gone", status=TASK_STATUS_QUEUED)

        pipeline = BlockingPipeline()
        scheduler = make_scheduler(pipeline)

        assert await scheduler.recover_pending() == 0
        assert await get_task(sessionmaker, "doc-gone") is None
        await scheduler.shutdown()


# ─── 取消与关停 ──────────────────────────────────────────────────────────────


class TestCancelAndShutdown:
    async def test_cancel_running_task(self, sessionmaker, make_scheduler):
        await seed_kb(sessionmaker)
        pipeline = BlockingPipeline()
        scheduler = make_scheduler(pipeline)

        await scheduler.enqueue(make_task())
        await asyncio.sleep(0)

        assert await scheduler.cancel("doc-1") is True
        await asyncio.sleep(0)
        assert "doc-1" not in pipeline.finished
        await scheduler.shutdown()

    async def test_cancel_queued_task(self, sessionmaker, make_scheduler):
        await seed_kb(sessionmaker)
        pipeline = BlockingPipeline()
        scheduler = make_scheduler(pipeline, max_concurrent=1)

        await scheduler.enqueue(make_task("doc-1"))
        await scheduler.enqueue(make_task("doc-2"))
        await asyncio.sleep(0)

        assert await scheduler.cancel("doc-2") is True
        pipeline.gate.set()
        await asyncio.sleep(0.05)
        assert "doc-2" not in pipeline.started
        await scheduler.shutdown()

    async def test_cancel_unknown_task_returns_false(
        self, sessionmaker, make_scheduler,
    ):
        await seed_kb(sessionmaker)
        scheduler = make_scheduler(BlockingPipeline())
        assert await scheduler.cancel("nope") is False
        await scheduler.shutdown()

    async def test_shutdown_returns_interrupted_tasks_to_queue(
        self, sessionmaker, make_scheduler,
    ):
        """关停时把在跑任务退回 queued，下次启动可恢复，而不是留下 running。"""
        await seed_kb(sessionmaker)
        await seed_doc(sessionmaker, "doc-1")
        pipeline = BlockingPipeline()
        scheduler = make_scheduler(pipeline)

        await scheduler.enqueue(make_task())
        await asyncio.sleep(0)
        assert pipeline.started == ["doc-1"]

        await scheduler.shutdown()

        task = await get_task(sessionmaker)
        assert task is not None and task.status == TASK_STATUS_QUEUED
        doc = await get_doc(sessionmaker)
        assert doc is not None and doc.status == "queued"


# ─── 计数一致性 ──────────────────────────────────────────────────────────────


class TestCounterRecalc:
    async def test_entity_count_matches_graph_nodes(self, sessionmaker):
        """实体/关系数按**归一后的分组数**计，与图谱页签渲染的节点数一致。

        **口径变更（迭代 6 T6.5）**：此前这里数**行数**（`count(*)`，T1.6 时期的写法），
        而 `rebuild_graph_for_kb` 数**分组数**——两处不同口径正是方案里记的
        "255 / 282 / 322 三值不等"的成因。归一之后图谱把 `calico` 与 `Calico` 合成一个
        节点，计数跟着按分组走，于是这条用例的期望从 2 变成 1。

        这不是"把用例改成迁就实现"：T1.6 当时的意图就是"计数要与图谱页签看到的一致"，
        归一改变了图谱看到的东西，计数必须跟着变。
        """
        await seed_kb(sessionmaker)
        await seed_doc(sessionmaker, "doc-1", status="indexed")
        async with sessionmaker() as db:
            db.add_all([
                KnowledgeBaseEntity(id="e1", kb_id=KB, doc_id="doc-1", name="calico", type="框架"),
                KnowledgeBaseEntity(id="e2", kb_id=KB, doc_id="doc-1", name="Calico", type="框架"),
                KnowledgeBaseRelation(
                    id="r1", kb_id=KB, doc_id="doc-1", from_entity="calico",
                    to_entity="Calico", label="别名",
                ),
            ])
            await db.commit()

        async with sessionmaker() as db:
            await recalc_kb_counters(db, KB)
            await db.commit()

        async with sessionmaker() as db:
            kb = await db.get(KnowledgeBase, KB)
        assert kb is not None
        assert kb.entities_count == 1, "大小写变体应合成一个节点"
        assert kb.relations_count == 1
        assert kb.chunks_count == 0
        assert kb.docs_count == 1
        assert kb.status == "ready"

    async def test_counter_matches_get_graph_data(self, sessionmaker):
        """计数与图谱接口返回的条数必须逐一对上——两条路各算各的就会漂移。"""
        from api.knowledge_base.graph_service import get_graph_data

        await seed_kb(sessionmaker)
        await seed_doc(sessionmaker, "doc-1", status="indexed")
        await seed_doc(sessionmaker, "doc-2", status="indexed")
        async with sessionmaker() as db:
            db.add_all([
                # 同一实体跨两篇文档：两行、一个节点
                KnowledgeBaseEntity(id="e1", kb_id=KB, doc_id="doc-1", name="Milvus", type="产品"),
                KnowledgeBaseEntity(id="e2", kb_id=KB, doc_id="doc-2", name="milvus", type="产品"),
                KnowledgeBaseEntity(id="e3", kb_id=KB, doc_id="doc-1", name="RAG", type="概念"),
                KnowledgeBaseRelation(
                    id="r1", kb_id=KB, doc_id="doc-1", from_entity="Milvus",
                    to_entity="RAG", label="用于",
                ),
                KnowledgeBaseRelation(
                    id="r2", kb_id=KB, doc_id="doc-2", from_entity="milvus",
                    to_entity="rag", label="用于",
                ),
            ])
            await db.commit()

        async with sessionmaker() as db:
            await recalc_kb_counters(db, KB)
            await db.commit()

        async with sessionmaker() as db:
            kb = await db.get(KnowledgeBase, KB)
            graph = await get_graph_data(db, KB)
        assert kb is not None
        assert kb.entities_count == len(graph["entities"]) == 2
        assert kb.relations_count == len(graph["relations"]) == 1

    async def test_status_becomes_indexing_while_docs_are_active(
        self, sessionmaker,
    ):
        await seed_kb(sessionmaker)
        await seed_doc(sessionmaker, "doc-1", status="embedding")

        async with sessionmaker() as db:
            await recalc_kb_counters(db, KB)
            await db.commit()
            kb = await db.get(KnowledgeBase, KB)

        assert kb is not None and kb.status == "indexing"

    async def test_empty_kb_status_is_draft(self, sessionmaker):
        await seed_kb(sessionmaker)
        async with sessionmaker() as db:
            await recalc_kb_counters(db, KB)
            await db.commit()
            kb = await db.get(KnowledgeBase, KB)

        assert kb is not None and kb.status == "draft"


# ─── 重试 / 取消 / 删除 ──────────────────────────────────────────────────────


class FakeVectorStore:
    def __init__(self):
        self.deleted_docs: list[str] = []

    async def delete_by_doc_id(self, kb_id: str, doc_id: str, target=None) -> None:
        self.deleted_docs.append(doc_id)


class RecordingScheduler:
    """只记录 enqueue 调用的调度器替身。"""

    def __init__(self):
        self.enqueued: list[str] = []

    async def enqueue(self, task: IndexingTask) -> None:
        self.enqueued.append(task.doc_id)

    async def cancel(self, doc_id: str) -> bool:
        return False

    async def cancel_and_wait(self, doc_id: str) -> bool:
        return False


class TestRetryDocument:
    async def test_retry_cleans_previous_vectors_and_graph(self, sessionmaker):
        """回归：重试前不清理会往同一 doc_id 追加一份切片（重复内容）。"""
        await seed_kb(sessionmaker)
        await seed_doc(sessionmaker, "doc-1", status="failed")
        async with sessionmaker() as db:
            db.add(KnowledgeBaseEntity(
                id="e1", kb_id=KB, doc_id="doc-1", name="旧实体", type="概念",
            ))
            await db.commit()

        store = FakeVectorStore()
        scheduler = RecordingScheduler()

        async with sessionmaker() as db:
            await retry_document(
                db, KB, "doc-1", USER, scheduler, vector_store=store,  # type: ignore[arg-type]
            )

        assert store.deleted_docs == ["doc-1"]
        assert scheduler.enqueued == ["doc-1"]
        async with sessionmaker() as db:
            from sqlalchemy import select

            entities = (
                await db.execute(
                    select(KnowledgeBaseEntity).where(KnowledgeBaseEntity.doc_id == "doc-1")
                )
            ).scalars().all()
            assert entities == []
            doc = await db.get(KnowledgeBaseDocument, "doc-1")
            assert doc is not None
            assert doc.status == "queued"
            assert doc.chunks_count == 0

    async def test_retry_allows_canceled_and_intermediate_states(
        self, sessionmaker,
    ):
        """卡在中间态 / 已取消的文档也能重试（此前只接受 failed）。"""
        await seed_kb(sessionmaker)
        await seed_doc(sessionmaker, "doc-1", status="canceled")

        async with sessionmaker() as db:
            await retry_document(db, KB, "doc-1", USER, RecordingScheduler())  # type: ignore[arg-type]

        doc = await get_doc(sessionmaker)
        assert doc is not None and doc.status == "queued"

    async def test_retry_rejects_indexed_document(self, sessionmaker):
        from fastapi import HTTPException

        await seed_kb(sessionmaker)
        await seed_doc(sessionmaker, "doc-1", status="indexed")

        async with sessionmaker() as db:
            with pytest.raises(HTTPException) as exc:
                await retry_document(db, KB, "doc-1", USER, RecordingScheduler())  # type: ignore[arg-type]
        assert exc.value.status_code == 400


class TestCancelDocument:
    async def test_cancel_marks_doc_and_task_canceled(self, sessionmaker):
        await seed_kb(sessionmaker)
        await seed_doc(sessionmaker, "doc-1", status="embedding")
        await seed_task(sessionmaker, "doc-1", status=TASK_STATUS_RUNNING)

        async with sessionmaker() as db:
            result = await cancel_document(
                db, KB, "doc-1", USER, RecordingScheduler(),  # type: ignore[arg-type]
            )

        assert result.status == "canceled"
        task = await get_task(sessionmaker)
        assert task is not None and task.status == TASK_STATUS_CANCELED

    async def test_cancel_rejects_indexed_document_with_conflict(self, sessionmaker):
        """已完成的文档不是"参数错误"而是"状态冲突"——用 409 更准确。"""
        from fastapi import HTTPException

        await seed_kb(sessionmaker)
        await seed_doc(sessionmaker, "doc-1", status="indexed")

        async with sessionmaker() as db:
            with pytest.raises(HTTPException) as exc:
                await cancel_document(db, KB, "doc-1", USER, RecordingScheduler())  # type: ignore[arg-type]
        assert exc.value.status_code == 409


class TestDeleteDocument:
    async def test_delete_cancels_running_task(self, sessionmaker):
        """回归：删除文档不取消任务 → 任务继续写向量，产生孤儿数据。"""

        class CancellingScheduler(RecordingScheduler):
            def __init__(self):
                super().__init__()
                self.cancelled: list[str] = []

            async def cancel(self, doc_id: str) -> bool:
                self.cancelled.append(doc_id)
                return True

        await seed_kb(sessionmaker)
        await seed_doc(sessionmaker, "doc-1", status="embedding")
        await seed_task(sessionmaker, "doc-1", status=TASK_STATUS_RUNNING)

        store = FakeVectorStore()
        scheduler = CancellingScheduler()

        async with sessionmaker() as db:
            await delete_document(
                db, KB, "doc-1", USER, store, scheduler=scheduler,  # type: ignore[arg-type]
            )
            await db.commit()

        assert scheduler.cancelled == ["doc-1"]
        assert store.deleted_docs == ["doc-1"]
        assert await get_doc(sessionmaker) is None
        assert await get_task(sessionmaker) is None


# ─── 进度事件总线 ────────────────────────────────────────────────────────────


class TestIndexingEventBus:
    def test_publish_reaches_subscribers(self):
        from api.knowledge_base.indexing_events import IndexingEventBus

        IndexingEventBus.reset()
        queue = IndexingEventBus.subscribe(KB)

        IndexingEventBus.publish(KB, {"doc_id": "doc-1", "status": "parsing"})

        assert queue.get_nowait()["doc_id"] == "doc-1"
        IndexingEventBus.reset()

    def test_other_kb_does_not_receive(self):
        from api.knowledge_base.indexing_events import IndexingEventBus

        IndexingEventBus.reset()
        queue = IndexingEventBus.subscribe("kb-other")

        IndexingEventBus.publish(KB, {"doc_id": "doc-1"})

        assert queue.empty()
        IndexingEventBus.reset()

    def test_unsubscribe_stops_delivery(self):
        from api.knowledge_base.indexing_events import IndexingEventBus

        IndexingEventBus.reset()
        queue = IndexingEventBus.subscribe(KB)
        IndexingEventBus.unsubscribe(KB, queue)

        IndexingEventBus.publish(KB, {"doc_id": "doc-1"})

        assert queue.empty()
        assert IndexingEventBus.subscriber_count(KB) == 0
        IndexingEventBus.reset()

    def test_full_queue_drops_event_without_raising(self):
        """队列满时丢事件而不是抛异常（进度是幂等快照，前端会兜底重拉）。"""
        from api.knowledge_base.indexing_events import IndexingEventBus

        IndexingEventBus.reset()
        queue = IndexingEventBus.subscribe(KB)
        for i in range(queue.maxsize + 10):
            IndexingEventBus.publish(KB, {"doc_id": f"doc-{i}"})

        assert queue.qsize() == queue.maxsize
        IndexingEventBus.reset()


# ─── 迁移机制（新增列） ──────────────────────────────────────────────────────


class TestColumnMigration:
    """本次为 knowledge_base_documents 新增 graph_error 列，走的是 init_db 里既有的
    “查列 → 缺则 ALTER” 迁移方式（项目未使用 Alembic）。这里验证该机制在 SQLite 上
    可用，避免“模型加了字段但老库没有该列”导致运行时写入失败。
    """

    async def test_missing_column_is_added(self, monkeypatch):
        from sqlalchemy import text

        from agent.config import settings
        from db.engine import _get_existing_columns, _table_exists

        # 迁移助手按 DATABASE_BACKEND 选择方言；本用例用内存 SQLite，
        # 因此把后端切到 sqlite 分支（真实部署里二者由 .env 保证一致）。
        monkeypatch.setattr(settings, "DATABASE_BACKEND", "sqlite")

        engine = create_async_engine(
            "sqlite+aiosqlite://",
            poolclass=StaticPool,
            connect_args={"check_same_thread": False},
        )
        try:
            async with engine.begin() as conn:
                await conn.execute(text(
                    "CREATE TABLE knowledge_base_documents ("
                    "id VARCHAR(36) PRIMARY KEY, kb_id VARCHAR(36) NOT NULL)"
                ))
                assert await _table_exists(conn, "knowledge_base_documents")
                existing = await _get_existing_columns(conn, "knowledge_base_documents")
                assert "graph_error" not in existing

                if "graph_error" not in existing:
                    await conn.execute(text(
                        "ALTER TABLE knowledge_base_documents ADD COLUMN graph_error TEXT"
                    ))

                after = await _get_existing_columns(conn, "knowledge_base_documents")
                assert "graph_error" in after
        finally:
            await engine.dispose()


# ─── 取消的原子性与清理（复查发现的竞态） ────────────────────────────────────


class TestCancelAtomicity:
    async def test_cancel_loses_race_with_completed_index(self, sessionmaker):
        """流水线在取消窗口内写完 indexed 时，取消必须失败而不是覆盖终态。

        复现方式：让 cancel_and_wait 在返回前把文档改成 indexed（等价于"任务在
        我们读取状态之后、写 canceled 之前完成"）。
        """

        class RacingScheduler(RecordingScheduler):
            def __init__(self, maker):
                super().__init__()
                self._maker = maker

            async def cancel_and_wait(self, doc_id: str) -> bool:
                from sqlalchemy import update as sql_update

                async with self._maker() as db:
                    await db.execute(
                        sql_update(KnowledgeBaseDocument)
                        .where(KnowledgeBaseDocument.id == doc_id)
                        .values(status="indexed", progress=100)
                    )
                    await db.commit()
                return True

        from fastapi import HTTPException

        await seed_kb(sessionmaker)
        await seed_doc(sessionmaker, "doc-1", status="extracting")

        async with sessionmaker() as db:
            with pytest.raises(HTTPException) as exc:
                await cancel_document(
                    db, KB, "doc-1", USER, RacingScheduler(sessionmaker),  # type: ignore[arg-type]
                )

        assert exc.value.status_code == 409
        doc = await get_doc(sessionmaker)
        assert doc is not None and doc.status == "indexed"

    async def test_cancel_cleans_partial_vectors_and_graph(self, sessionmaker):
        """取消要清掉已写入的切片与图谱，否则"已取消"的内容仍能被检索到。"""

        class WaitingScheduler(RecordingScheduler):
            def __init__(self):
                super().__init__()
                self.waited: list[str] = []

            async def cancel_and_wait(self, doc_id: str) -> bool:
                self.waited.append(doc_id)
                return True

        await seed_kb(sessionmaker)
        await seed_doc(sessionmaker, "doc-1", status="bm25")
        async with sessionmaker() as db:
            db.add(KnowledgeBaseEntity(
                id="e1", kb_id=KB, doc_id="doc-1", name="已抽取实体", type="概念",
            ))
            await db.commit()

        store = FakeVectorStore()
        scheduler = WaitingScheduler()

        async with sessionmaker() as db:
            result = await cancel_document(
                db, KB, "doc-1", USER, scheduler, vector_store=store,  # type: ignore[arg-type]
            )

        assert scheduler.waited == ["doc-1"]
        assert store.deleted_docs == ["doc-1"]
        assert result.status == "canceled"
        assert result.chunks_count == 0
        assert result.entities_count == 0
        async with sessionmaker() as db:
            from sqlalchemy import select

            entities = (
                await db.execute(
                    select(KnowledgeBaseEntity).where(KnowledgeBaseEntity.doc_id == "doc-1")
                )
            ).scalars().all()
            assert entities == []
            kb = await db.get(KnowledgeBase, KB)
            assert kb is not None and kb.entities_count == 0
