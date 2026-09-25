"""软删除的**全局查询过滤**（迭代 5 T5.6）。

问题：软删除只加一列是不够的——每一条查询都必须记得过滤 ``deleted_at IS NULL``。
本项目直接 ``select(KnowledgeBase)`` 的地方有 18 处，靠人工逐个补必然会漏，而漏掉的
后果是"**删掉的库又出现在搜索结果里**"——它不报错、不会崩，只会让用户看到本该消失
的数据，是最难被发现的一类缺陷。

做法：用 SQLAlchemy 的 ``do_orm_execute`` 事件给 ORM 查询**统一追加过滤条件**
（``with_loader_criteria``），因此：

- 任何 ``select(KnowledgeBase)`` 都自动排除软删除行，**包括未来新写的查询**；
- 需要看已删除记录时（恢复、清理任务）显式声明：``include_deleted(True)``，
  默认关闭——"默认看不见、要看必须明说"，与权限判定同一取向。

裸 SQL（``text(...)``）不经过 ORM，不受此过滤器约束；本模块只覆盖 ORM 查询。
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar

from sqlalchemy import event
from sqlalchemy.orm import LoaderCriteriaOption, Session, with_loader_criteria

logger = logging.getLogger(__name__)

#: 是否在本次查询中带上软删除的行（默认不带）
_include_deleted: ContextVar[bool] = ContextVar("include_deleted", default=False)

_installed = False


@contextmanager
def include_deleted(flag: bool = True) -> Iterator[None]:
    """在作用域内让 ORM 查询**包含**软删除的行（恢复、清理任务用）。"""
    token = _include_deleted.set(flag)
    try:
        yield
    finally:
        _include_deleted.reset(token)


def _criteria_for(session: Session) -> list[LoaderCriteriaOption]:
    """按模型生成过滤条件；只对声明了 ``deleted_at`` 的模型生效。"""
    from db.base import Base

    criteria = []
    for mapper in Base.registry.mappers:
        model = mapper.class_
        if hasattr(model, "deleted_at"):
            criteria.append(
                with_loader_criteria(
                    model, model.deleted_at.is_(None), include_aliases=True,
                ),
            )
    return criteria


def install_soft_delete_filter() -> None:
    """安装全局过滤器（重复调用无副作用）。

    在 ``init_db`` 里调用一次即可；未安装时软删除行会照常出现在查询结果里。
    """
    global _installed
    if _installed:
        return
    _installed = True

    @event.listens_for(Session, "do_orm_execute", propagate=True)
    def _filter_soft_deleted(state) -> None:  # type: ignore[no-untyped-def]
        if not state.is_select:
            return
        if state.execution_options.get("include_deleted"):
            return
        if _include_deleted.get():
            return
        try:
            state.statement = state.statement.options(*_criteria_for(state.session))
        except Exception:  # noqa: BLE001 - 过滤失败不能把查询带崩
            logger.warning("软删除过滤器安装失败，本次查询不过滤", exc_info=True)


__all__ = ["include_deleted", "install_soft_delete_filter"]
