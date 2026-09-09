"""System parameter business logic layer."""

import json
import logging
from typing import Any

from fastapi import HTTPException
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from api.params.schemas import (
    ParamCreateRequest,
    ParamReorderRequest,
    ParamResponse,
    ParamUpdateRequest,
)
from db.models.system_param import SystemParam

logger = logging.getLogger(__name__)

GROUP_TYPE = "group"
PARENTS_SCOPE = "parents"
CHILDREN_SCOPE = "children"


async def _get_by_id(db: AsyncSession, param_id: str) -> SystemParam | None:
    """Get a parameter row by id."""
    result = await db.execute(select(SystemParam).where(SystemParam.id == param_id))
    return result.scalar_one_or_none()


async def _get_by_code(db: AsyncSession, param_code: str) -> SystemParam | None:
    """Get a parameter row by param_code."""
    result = await db.execute(
        select(SystemParam).where(SystemParam.param_code == param_code)
    )
    return result.scalar_one_or_none()


def _to_response(row: SystemParam, child_count: int = 0) -> ParamResponse:
    """Build a response projection from a row."""
    return ParamResponse(
        id=row.id,
        param_code=row.param_code,
        parent_code=row.parent_code,
        param_label=row.param_label,
        param_name=row.param_name,
        param_value=row.param_value,
        param_type=row.param_type,
        description=row.description or "",
        child_count=child_count,
        sort_order=row.sort_order,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _validate_value(param_type: str, value: str | None) -> None:
    """Validate a param value against its declared type."""
    if param_type == GROUP_TYPE:
        return
    if value is None:
        raise HTTPException(status_code=400, detail="参数值不能为空")
    if param_type == "number":
        try:
            float(value)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="参数值必须是数字") from exc
    elif param_type == "boolean":
        if value not in ("true", "false"):
            raise HTTPException(
                status_code=400, detail="布尔参数值只能为 true 或 false"
            )
    elif param_type == "json":
        try:
            json.loads(value)
        except ValueError as exc:
            raise HTTPException(
                status_code=400, detail="参数值必须是合法的 JSON"
            ) from exc


async def _child_count(db: AsyncSession, parent_code: str) -> int:
    """Count children under the given parent code."""
    result = await db.execute(
        select(func.count(SystemParam.id)).where(SystemParam.parent_code == parent_code)
    )
    return int(result.scalar() or 0)


async def list_parents(
    db: AsyncSession, keyword: str | None = None
) -> list[ParamResponse]:
    """List top-level parent parameters ordered by sort_order."""
    conditions: list[Any] = [SystemParam.parent_code.is_(None)]
    if keyword:
        like = f"%{keyword}%"
        conditions.append(
            or_(
                SystemParam.param_code.ilike(like),
                SystemParam.param_label.ilike(like),
                SystemParam.param_name.ilike(like),
            )
        )
    result = await db.execute(
        select(SystemParam)
        .where(*conditions)
        .order_by(SystemParam.sort_order, SystemParam.created_at)
    )
    rows = list(result.scalars().all())
    if not rows:
        return []
    codes = [row.param_code for row in rows]
    count_result = await db.execute(
        select(SystemParam.parent_code, func.count(SystemParam.id))
        .where(SystemParam.parent_code.in_(codes))
        .group_by(SystemParam.parent_code)
    )
    counts = {row[0]: int(row[1]) for row in count_result.all()}
    return [_to_response(row, counts.get(row.param_code, 0)) for row in rows]


async def list_children(db: AsyncSession, parent_code: str) -> list[ParamResponse]:
    """List child parameters under a parent code."""
    parent = await _get_by_code(db, parent_code)
    if parent is None:
        raise HTTPException(status_code=404, detail="父级参数不存在")
    if parent.parent_code is not None:
        raise HTTPException(status_code=400, detail="子参数不能作为父级参数")
    result = await db.execute(
        select(SystemParam)
        .where(SystemParam.parent_code == parent_code)
        .order_by(SystemParam.sort_order, SystemParam.created_at)
    )
    return [_to_response(row) for row in result.scalars().all()]


async def create_param(db: AsyncSession, req: ParamCreateRequest) -> ParamResponse:
    """Create a parent or child parameter with validation."""
    existing = await _get_by_code(db, req.param_code)
    if existing is not None:
        raise HTTPException(status_code=409, detail=f"参数编码 {req.param_code} 已存在")

    if req.parent_code:
        parent = await _get_by_code(db, req.parent_code)
        if parent is None:
            raise HTTPException(status_code=404, detail="父级参数不存在")
        if parent.parent_code is not None:
            raise HTTPException(status_code=400, detail="子参数不能作为父级参数")
        if req.param_type == GROUP_TYPE:
            raise HTTPException(status_code=400, detail="子参数类型不能为 group")
        _validate_value(req.param_type, req.param_value)
        sort_order = await _child_count(db, req.parent_code) + 1
        row = SystemParam(
            param_code=req.param_code,
            parent_code=req.parent_code,
            param_label=req.param_label,
            param_name=req.param_name,
            param_value=req.param_value,
            param_type=req.param_type,
            description=req.description or None,
            sort_order=sort_order,
        )
    else:
        parent_total = await db.execute(
            select(func.count(SystemParam.id)).where(SystemParam.parent_code.is_(None))
        )
        row = SystemParam(
            param_code=req.param_code,
            parent_code=None,
            param_label=req.param_label,
            param_name=req.param_name,
            param_value=None,
            param_type=req.param_type,
            description=req.description or None,
            sort_order=int(parent_total.scalar() or 0) + 1,
        )

    db.add(row)
    await db.flush()
    await db.refresh(row)
    return _to_response(row)


async def update_param(
    db: AsyncSession, param_id: str, req: ParamUpdateRequest
) -> ParamResponse:
    """Update a parameter row with structure-aware validation."""
    row = await _get_by_id(db, param_id)
    if row is None:
        raise HTTPException(status_code=404, detail="参数不存在")

    is_parent = row.parent_code is None
    updates: dict[str, object] = {}
    old_code = row.param_code

    if req.param_code is not None and req.param_code != row.param_code:
        duplicate = await _get_by_code(db, req.param_code)
        if duplicate is not None:
            raise HTTPException(
                status_code=409, detail=f"参数编码 {req.param_code} 已存在"
            )
        updates["param_code"] = req.param_code

    if req.param_label is not None:
        updates["param_label"] = req.param_label
    if req.param_name is not None:
        updates["param_name"] = req.param_name

    final_type = row.param_type
    if req.param_type is not None:
        if not is_parent and req.param_type == GROUP_TYPE:
            raise HTTPException(status_code=400, detail="子参数类型不能为 group")
        final_type = req.param_type
        updates["param_type"] = req.param_type

    if "param_value" in req.model_fields_set:
        if is_parent:
            updates["param_value"] = None
        else:
            _validate_value(final_type, req.param_value)
            updates["param_value"] = req.param_value
    if "description" in req.model_fields_set:
        updates["description"] = req.description or None

    if req.parent_code is not None:
        if is_parent:
            raise HTTPException(status_code=400, detail="父级参数不能挂到其他参数下")
        if req.parent_code != row.parent_code:
            raise HTTPException(
                status_code=400, detail="子参数不允许变更所属父级，请删除后重建"
            )
    elif not is_parent:
        raise HTTPException(status_code=400, detail="子参数必须指定 parentCode")

    if not updates:
        return _to_response(row)

    await db.execute(
        update(SystemParam).where(SystemParam.id == param_id).values(**updates)
    )
    if is_parent and "param_code" in updates:
        await db.execute(
            update(SystemParam)
            .where(SystemParam.parent_code == old_code)
            .values(parent_code=updates["param_code"])
        )
    await db.flush()
    await db.refresh(row)
    if is_parent:
        child_count = await _child_count(db, row.param_code)
    else:
        child_count = 0
    return _to_response(row, child_count)


async def delete_param(db: AsyncSession, param_id: str) -> dict[str, int]:
    """Delete a parameter; parent deletion cascades to children."""
    row = await _get_by_id(db, param_id)
    if row is None:
        raise HTTPException(status_code=404, detail="参数不存在")

    is_parent = row.parent_code is None
    child_count = 0
    if is_parent:
        child_count = await _child_count(db, row.param_code)
        await db.execute(
            delete(SystemParam).where(SystemParam.parent_code == row.param_code)
        )
    await db.execute(delete(SystemParam).where(SystemParam.id == param_id))
    await db.flush()
    return {"deleted": child_count + 1}


async def reorder_params(
    db: AsyncSession, req: ParamReorderRequest
) -> list[ParamResponse]:
    """Reorder sibling parameters and persist sort_order."""
    if len(req.ids) != len(set(req.ids)):
        raise HTTPException(status_code=400, detail="排序列表包含重复参数")

    result = await db.execute(select(SystemParam).where(SystemParam.id.in_(req.ids)))
    rows = list(result.scalars().all())
    if len(rows) != len(req.ids):
        raise HTTPException(status_code=400, detail="排序列表包含不存在的参数")

    if req.scope == PARENTS_SCOPE:
        if any(row.parent_code is not None for row in rows):
            raise HTTPException(status_code=400, detail="父级排序列表只能包含父级参数")
    elif req.scope == CHILDREN_SCOPE:
        if not req.parent_code:
            raise HTTPException(status_code=400, detail="子参数排序需要指定父级编码")
        parent = await _get_by_code(db, req.parent_code)
        if parent is None or parent.parent_code is not None:
            raise HTTPException(status_code=400, detail="父级参数不存在或不是父级参数")
        if any(row.parent_code != req.parent_code for row in rows):
            raise HTTPException(
                status_code=400, detail="子参数排序列表必须属于同一父级"
            )
    else:
        raise HTTPException(status_code=400, detail="未知的排序范围")

    for index, param_id in enumerate(req.ids):
        await db.execute(
            update(SystemParam)
            .where(SystemParam.id == param_id)
            .values(sort_order=(index + 1) * 10)
        )
    await db.flush()
    if req.scope == PARENTS_SCOPE:
        return await list_parents(db)
    return await list_children(db, str(req.parent_code))
