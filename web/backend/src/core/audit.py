"""审计日志——记录"谁、从哪、对什么、做了什么、结果如何"。

与 `api/agent/event_logger.log_event` 的区别（**不要互相替代**）：

- `log_event` 用调用方的会话写并 **commit/rollback 那个会话**——它服务于"顺手记一条
  运行事件"（Agent 执行、模型切换），放在业务事务里会**破坏业务原子性**：审计那次
  commit 会把业务尚未完成的部分先提交掉，失败时的 rollback 更是把业务改动一起回滚；
- 本模块用**独立会话、独立事务**写，且在业务事务提交**之后**调用，因此：
  1. 业务要么成功要么失败，审计不会改变它；
  2. 业务失败时审计仍然留痕（"失败尝试"恰恰是审计最关心的）；
  3. 审计自身失败只记日志，**绝不**冒泡给业务。

用法（在路由层，因为 IP 只有那里有）::

    async with audit_scope("knowledge.delete", user_id, request) as entry:
        await delete_kb(...)
        entry.target = kb_id

正常退出记 ``success``，抛异常记 ``failed`` 并**原样向上抛**。
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

logger = logging.getLogger(__name__)

#: 审计分类——沿用 system_events.category 的既有取值集合
CATEGORY = "knowledge"

RESULT_SUCCESS = "success"
RESULT_FAILED = "failed"
RESULT_DENIED = "denied"


def _default_session_factory() -> async_sessionmaker[AsyncSession]:
    from db.engine import async_session

    return async_session


async def record_audit(
    action: str,
    *,
    user_id: str | None = None,
    ip: str | None = None,
    target: str | None = None,
    result: str = RESULT_SUCCESS,
    message: str = "",
    detail: dict[str, Any] | None = None,
    session_factory: async_sessionmaker[AsyncSession] | None = None,
) -> None:
    """写一条审计事件（独立事务；失败只记日志）。

    Args:
        action: 动作键，如 ``knowledge.delete``；检索时按它归类。
        user_id: 操作者。**为 None 也照记**——"谁都没登录就动了数据"本身是重要线索。
        ip: 来源 IP。
        target: 操作对象（知识库 ID / 文档 ID）。
        result: ``success`` / ``failed`` / ``denied``。
        message: 人可读描述。
        detail: 附加信息（如被删库的名称、文档数）。
        session_factory: 会话工厂（测试可注入内存库）。
    """
    from db.models.system_event import SystemEvent

    factory = session_factory or _default_session_factory()
    try:
        async with factory() as db:
            db.add(SystemEvent(
                type="info" if result == RESULT_SUCCESS else "warn",
                category=CATEGORY,
                message=message or action,
                metadata_=detail or {},
                action=action,
                user_id=user_id,
                ip=ip,
                target=target,
                result=result,
            ))
            await db.commit()
    except Exception:  # noqa: BLE001 - 审计绝不影响业务
        logger.warning("写审计事件失败 action=%s target=%s", action, target, exc_info=True)


@dataclass
class AuditEntry:
    """一次操作的审计条目（可在业务逻辑中补充 target / detail）。"""

    action: str
    user_id: str | None = None
    ip: str | None = None
    target: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)
    session_factory: async_sessionmaker[AsyncSession] | None = None
    #: 业务未抛异常但**自己判定为失败**时（例如接口以 ``{"code": 500}`` 返回）可改写，
    #: 避免审计把"操作没成功"记成成功
    result: str = RESULT_SUCCESS


@asynccontextmanager
async def audit_scope(
    action: str,
    user_id: str | None,
    request: Any = None,
    *,
    target: str | None = None,
    **detail: Any,
) -> AsyncIterator[AuditEntry]:
    """把一段业务包进审计：正常退出记 success，异常记 failed 后原样抛出。

    ``request`` 用于取来源 IP（没有也不影响记录）；``target`` / ``detail`` 可在
    业务执行过程中再补（有些 ID 要等创建完成才知道）。
    """
    entry = AuditEntry(
        action=action,
        user_id=user_id,
        ip=_client_ip(request),
        target=target,
        detail=detail,
    )
    try:
        yield entry
    except Exception as exc:
        await record_audit(
            action, user_id=entry.user_id, ip=entry.ip, target=entry.target,
            result=RESULT_FAILED, detail={**entry.detail, "error": str(exc)[:200]},
            session_factory=entry.session_factory,
        )
        raise
    await record_audit(
        action, user_id=entry.user_id, ip=entry.ip, target=entry.target,
        result=entry.result, detail=entry.detail,
        session_factory=entry.session_factory,
    )


def _client_ip(request: Any) -> str | None:
    """从请求里取来源 IP（取不到返回 None——审计不因缺 IP 而不记）。"""
    if request is None:
        return None
    try:
        from api.deps import get_client_ip

        return get_client_ip(request)
    except Exception:  # noqa: BLE001
        return None


__all__ = [
    "CATEGORY",
    "RESULT_DENIED",
    "RESULT_FAILED",
    "RESULT_SUCCESS",
    "AuditEntry",
    "audit_scope",
    "record_audit",
]
