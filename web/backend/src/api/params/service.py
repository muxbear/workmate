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

# ── 模型类型参数分组 ──────────────────────────────────────────────────────────
# 「模型」页面添加模型时的「模型类型」下拉，取值来自本分组的子参数：
#   param_value = 类型编码（写入 ai_models.type）
#   param_label = 下拉中展示的名称
# 管理员可在「参数配置」页面自由增删改，模型页面即时生效。
MODEL_TYPE_PARENT_CODE = "model_type"

#: 首次启动时的默认模型类型（仅在该分组不存在时写入，之后不再覆盖管理员的改动）
DEFAULT_MODEL_TYPES: list[tuple[str, str]] = [
    ("llm", "大语言模型"),
    ("vision", "视觉模型"),
    ("audio", "音频模型"),
    ("video", "视频模型"),
    ("embedding", "向量模型"),
    ("image-gen", "图像生成"),
    ("speech", "语音合成"),
    ("multimodal", "多模态"),
    ("rerank", "重排序模型"),
]


async def seed_builtin_params(db: AsyncSession) -> None:
    """初始化内置参数分组（幂等）。

    仅在分组缺失时创建默认项：分组一旦存在就不再补写，避免把管理员删掉的
    类型又"复活"。需要一个「已存在则补齐」的语义时应显式调用 backfill，
    而不是放宽这里的条件。
    """
    if await _get_by_code(db, MODEL_TYPE_PARENT_CODE) is not None:
        return

    db.add(
        SystemParam(
            param_code=MODEL_TYPE_PARENT_CODE,
            parent_code=None,
            param_label="模型类型",
            param_name="model_type",
            param_value=None,
            param_type=GROUP_TYPE,
            description="「模型」页面添加模型时可选用的模型类型（值写入模型的 type 字段）",
            sort_order=0,
        )
    )
    for index, (code, label) in enumerate(DEFAULT_MODEL_TYPES, start=1):
        db.add(
            SystemParam(
                param_code=f"{MODEL_TYPE_PARENT_CODE}_{code.replace('-', '_')}",
                parent_code=MODEL_TYPE_PARENT_CODE,
                param_label=label,
                param_name=code,
                param_value=code,
                param_type="string",
                description=f"{label}（{code}）",
                sort_order=index,
            )
        )
    logger.info("已初始化模型类型参数分组（%d 项）", len(DEFAULT_MODEL_TYPES))


async def list_model_types(db: AsyncSession) -> list[dict[str, str]]:
    """读取可选的模型类型，供「模型」页面渲染下拉。

    分组未配置或未填写任何有效值时回退到 :data:`DEFAULT_MODEL_TYPES`，
    保证模型页面始终可用（不因管理员清空配置而变成空下拉）。

    Returns:
        ``[{"value": 类型编码, "label": 展示名}, ...]``，按分组内排序。
    """
    result = await db.execute(
        select(SystemParam)
        .where(SystemParam.parent_code == MODEL_TYPE_PARENT_CODE)
        .order_by(SystemParam.sort_order, SystemParam.created_at)
    )
    options: list[dict[str, str]] = []
    seen: set[str] = set()
    for row in result.scalars().all():
        code = (row.param_value or row.param_name or "").strip()
        if not code or code in seen:
            continue
        seen.add(code)
        options.append({"value": code, "label": (row.param_label or code).strip()})

    if not options:
        return [{"value": code, "label": label} for code, label in DEFAULT_MODEL_TYPES]
    return options


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
