"""审计日志（迭代 5 T5.4）。

审计的价值取决于**它会不会说谎**与**它会不会拖垮业务**，所以这里锁三件事：

1. **不干扰业务**：审计写在自己的事务里，既不提交也不回滚调用方的事务。既有的
   `log_event` 恰好相反（commit/rollback 调用方会话），放在业务事务里会破坏原子性；
2. **如实**：业务抛异常记 `failed`，业务自己判定失败（接口以错误码返回）也能标记，
   不会把"没做成"记成成功；
3. **可查**：按操作者 / 动作 / 对象 / 结果过滤（此前 `get_events` 收了过滤参数
   却没用，属于静默失效）。
"""

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from core.audit import (
    RESULT_FAILED,
    RESULT_SUCCESS,
    audit_scope,
    record_audit,
)
from db.models.system_event import SystemEvent

pytestmark = pytest.mark.anyio


@pytest.fixture
async def session_factory():
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        await conn.run_sync(SystemEvent.__table__.create)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    yield maker
    await engine.dispose()


async def events(factory) -> list[SystemEvent]:
    async with factory() as db:
        return list(
            (await db.execute(select(SystemEvent).order_by(SystemEvent.created_at))).scalars()
        )


class TestRecordAudit:
    async def test_records_all_dimensions(self, session_factory):
        await record_audit(
            "knowledge.delete",
            user_id="u1", ip="10.0.0.8", target="kb-1",
            detail={"kb_name": "研发手册"},
            session_factory=session_factory,
        )

        row = (await events(session_factory))[0]
        assert (row.action, row.user_id, row.ip, row.target) == (
            "knowledge.delete", "u1", "10.0.0.8", "kb-1",
        )
        assert row.result == RESULT_SUCCESS
        assert row.metadata_["kb_name"] == "研发手册"

    async def test_missing_operator_is_still_recorded(self, session_factory):
        """"谁都没登录就动了数据"本身是线索，不能因为缺操作者就不记。"""
        await record_audit("knowledge.delete", target="kb-1", session_factory=session_factory)

        row = (await events(session_factory))[0]
        assert row.user_id is None
        assert row.target == "kb-1"

    async def test_failed_result_is_warn_level(self, session_factory):
        await record_audit(
            "knowledge.delete", result=RESULT_FAILED,
            detail={"error": "404"}, session_factory=session_factory,
        )

        assert (await events(session_factory))[0].type == "warn"

    async def test_write_failure_never_raises(self):
        """审计自身失败**绝不**冒泡——它不该成为业务失败的原因。"""

        class BrokenFactory:
            def __call__(self):
                raise RuntimeError("db down")

        await record_audit("knowledge.delete", session_factory=BrokenFactory())


class TestAuditScope:
    async def test_scope_records_success_via_injected_factory(self, session_factory):
        async with audit_scope(
            "knowledge.create", "u1", None,
        ) as entry:
            entry.session_factory = session_factory  # noqa: SLF001
            entry.target = "kb-7"

        row = (await events(session_factory))[0]
        assert row.target == "kb-7"
        assert row.result == RESULT_SUCCESS

    async def test_exception_is_recorded_and_reraised(self, session_factory):
        with pytest.raises(ValueError, match="boom"):
            async with audit_scope("knowledge.delete", "u1", None, target="kb-1") as entry:
                entry.session_factory = session_factory  # noqa: SLF001
                raise ValueError("boom")

        row = (await events(session_factory))[0]
        assert row.result == RESULT_FAILED
        assert "boom" in row.metadata_["error"]

    async def test_result_can_be_overridden_without_exception(self, session_factory):
        """接口以 ``{"code": 500}`` 返回时业务没抛异常，审计不能记成成功。"""
        async with audit_scope("knowledge.chunk.update", "u1", None, target="c1") as entry:
            entry.session_factory = session_factory  # noqa: SLF001
            entry.result = RESULT_FAILED

        assert (await events(session_factory))[0].result == RESULT_FAILED

    async def test_ip_is_taken_from_request(self, session_factory):
        """IP 只有路由层能拿到——审计要把它记下来（取不到也不影响记录）。"""

        class FakeRequest:
            # 用真实大小写：Starlette 的 Headers 不区分大小写，普通 dict 区分——
            # 替身用错大小写会"看不出哪里错了"地回退到直连 IP
            headers = {"X-Forwarded-For": "203.0.113.7", "user-agent": "pytest"}
            client = None

        async with audit_scope("knowledge.create", "u1", FakeRequest()) as entry:
            entry.session_factory = session_factory  # noqa: SLF001

        assert (await events(session_factory))[0].ip == "203.0.113.7"

    async def test_none_request_does_not_break(self, session_factory):
        async with audit_scope("knowledge.create", "u1", None) as entry:
            entry.session_factory = session_factory  # noqa: SLF001

        assert (await events(session_factory))[0].ip is None


class TestAuditDoesNotTouchBusinessTransaction:
    """审计必须与业务事务解耦——这是本模块存在的理由。"""

    async def test_caller_session_is_not_committed_by_audit(self, session_factory, tmp_path):
        """审计不得把业务会话里未提交的数据一起提交。

        用**文件库**而不是内存库：内存库配合 StaticPool 只有一个物理连接，两个会话
        共享它——任何一方 commit 都会把另一方的待提交行一起落盘，测不出"事务是否独立"。

        **本用例只断言这一半**（业务数据没被顺带提交）：SQLite 是单写者，业务事务持有
        写锁时第二个连接写审计会被锁住并（按设计）静默降级，因此"审计仍落库"这一半在
        SQLite 上无法与并发写共存——它由上面那些内存库用例覆盖（那是不存在锁竞争的
        场景），生产用 Postgres 连接池时两件事互不影响。
        """
        from db.models.knowledge_base import KnowledgeBase

        engine = create_async_engine(
            f"sqlite+aiosqlite:///{tmp_path / 'audit_isolation.db'}",
        )
        async with engine.begin() as conn:
            await conn.run_sync(KnowledgeBase.__table__.create)
            await conn.run_sync(SystemEvent.__table__.create)
        maker = async_sessionmaker(engine, expire_on_commit=False)

        async with maker() as business_db:
            business_db.add(KnowledgeBase(
                id="kb-x", name="未提交的库", description="", user_id="u1",
                status="draft", config={}, tags=[], visibility="private",
            ))
            await business_db.flush()

            # 审计用独立会话；它不能提交、也不能回滚业务会话
            await record_audit(
                "knowledge.create", user_id="u1", target="kb-x",
                session_factory=maker,
            )

            # 业务会话里回滚 → 未提交的库必须消失（若审计碰过这个会话就不会是这样）
            await business_db.rollback()

        async with maker() as check:
            assert (await check.execute(select(KnowledgeBase))).scalars().all() == []

        await engine.dispose()
