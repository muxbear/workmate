"""数据范围解析——把「角色 × 资源」的数据范围落成"能看哪些部门的记录"。

平台在「权限管理 → 数据权限」里给每个角色按资源配了范围（all / dept_and_children /
dept / self / custom / none），但**业务查询从来没读过它**——知识库尤其明显：
`public` 一直等于"全站可见"，与部门无关。本模块提供统一的解析入口，供各资源接入。

约定（与前端 `getDataScope()` 保持一致，避免两套口径）：

- **未配置该资源 = none**：前端的 `dataScopes[resourceKey] || 'none'` 就是这么写的。
  权限类配置"配了才算数"比"没配就全放行"安全，也不会因为新增角色漏配范围而把数据
  敞开；
- 没有部门归属（未建人员档案）的用户，`dept*` 类范围解析为空集——**不是**放行；
- 超管不受数据范围限制（与 `check_user_permission` 对待超管的方式一致）。

**本模块只负责回答"能看哪些部门"，不负责"能看哪些记录"**：后者取决于各资源的语义
（例如知识库只把范围用于收敛**公开库**的可见性，不放宽私有库——见
`api/knowledge_base.service._readable_condition`）。
"""

from __future__ import annotations

import json
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.models.data_scope import DataScope
from db.models.department import Department
from db.models.personnel import Personnel

logger = logging.getLogger(__name__)

#: 不受数据范围限制的资源范围值
SCOPE_ALL = "all"
#: 解析结果中的"无任何可见部门"
EMPTY_SCOPE: set[str] = set()


async def resolve_user_dept(db: AsyncSession, user_id: str) -> str | None:
    """取用户的部门 ID（经人员档案关联账号）。没有档案时返回 ``None``。"""
    dept_id = await db.scalar(
        select(Personnel.dept_id).where(Personnel.account_id == user_id)
    )
    return dept_id or None


async def dept_subtree(db: AsyncSession, root_id: str) -> set[str]:
    """展开部门子树（含自身）。

    一次取回全部部门后在内存里遍历，而不是递归查库：部门表是配置级数据（几十到
    几百行），一次查询远优于每层一次往返；也避免递归深度受数据库限制。
    """
    rows = (await db.execute(select(Department.id, Department.parent_id))).all()
    children: dict[str | None, list[str]] = {}
    for dept_id, parent_id in rows:
        children.setdefault(parent_id, []).append(dept_id)

    result: set[str] = set()
    stack = [root_id]
    while stack:
        current = stack.pop()
        if current in result:
            continue
        result.add(current)
        stack.extend(children.get(current, []))
    return result


async def dept_ancestors(db: AsyncSession, dept_id: str) -> set[str]:
    """展开部门的**祖先链**（含自身）。

    用途与 ``dept_subtree`` 正好相反：知识库授权挂在某个部门上、且 ``include_subtree``
    为真时，该部门的**子孙**都在覆盖范围内——于是判断"我是否被这条授权覆盖"，要把
    我所在部门的祖先链拿出来与授权的目标求交。同样一次取全表在内存里遍历。
    """
    rows = (await db.execute(select(Department.id, Department.parent_id))).all()
    parents: dict[str, str | None] = {row[0]: row[1] for row in rows}

    result: set[str] = set()
    current: str | None = dept_id
    while current and current not in result:
        result.add(current)
        current = parents.get(current)
    return result


async def resolve_dept_scope(
    db: AsyncSession, user_id: str, resource_key: str, role_key: str | None = None,
) -> set[str] | None:
    """解析该用户在某资源上的可见部门集合。

    Args:
        db: 会话。
        user_id: 用户 ID。
        resource_key: 资源键（如 ``knowledge``）。
        role_key: 活动角色键。**有请求上下文时应当传入**（与接口鉴权的活动角色
            同源）；拿不到时回退为权限最大的角色——用户确实通过那个角色拥有该范围，
            取最大而不是最小，避免"有权限却看不到"。

    Returns:
        ``None`` 表示**不限制部门**（范围 = all）；空集表示**看不到任何部门**的
        记录（范围 = self / none / 无配置且无部门归属）；否则为可见部门 ID 集合。
    """
    from api.rbac.role_utils import find_active_user_role, pick_default_role

    try:
        role = None
        if role_key:
            role = await find_active_user_role(db, user_id, role_key)
        if role is None:
            role = await pick_default_role(db, user_id)
    except Exception:  # noqa: BLE001 - 解析失败不能把业务读取带崩
        # RBAC 表缺失或查询出错时**失败关闭**（按无可见部门处理）并留下告警：
        # 让读取直接 500 是更糟的结果，而"出错就放行"则是安全漏洞。
        logger.warning(
            "解析用户数据范围失败，本次按「无可见部门」处理 user=%s", user_id, exc_info=True,
        )
        return EMPTY_SCOPE

    if role is None:
        return EMPTY_SCOPE

    role_ids = [role.id]
    row = (
        await db.execute(
            select(DataScope).where(
                DataScope.role_id.in_(role_ids),
                DataScope.resource_key == resource_key,
            )
        )
    ).scalars().first()

    if row is None:
        # 未配置：按前端口径视为 none（配了才算数）
        return EMPTY_SCOPE

    if row.scope == SCOPE_ALL:
        return None
    if row.scope in ("self", "none"):
        return EMPTY_SCOPE

    try:
        own_dept = await resolve_user_dept(db, user_id)
    except Exception:  # noqa: BLE001 - 同上：失败关闭，不把读取带崩
        logger.warning(
            "解析用户部门失败，本次按「无可见部门」处理 user=%s", user_id, exc_info=True,
        )
        return EMPTY_SCOPE
    if row.scope == "custom":
        try:
            ids = json.loads(row.custom_dept_ids or "[]")
        except (json.JSONDecodeError, TypeError):
            logger.warning("自定义部门范围解析失败 role=%s，按空处理", row.role_id)
            return EMPTY_SCOPE
        return {str(i) for i in ids if i}

    if not own_dept:
        # dept / dept_and_children 但用户没有部门归属：不放行
        return EMPTY_SCOPE
    if row.scope == "dept":
        return {own_dept}
    if row.scope == "dept_and_children":
        return await dept_subtree(db, own_dept)

    logger.warning("未知的数据范围 %s（role=%s），按空处理", row.scope, row.role_id)
    return EMPTY_SCOPE


__all__ = [
    "SCOPE_ALL",
    "dept_ancestors",
    "dept_subtree",
    "resolve_dept_scope",
    "resolve_user_dept",
]
