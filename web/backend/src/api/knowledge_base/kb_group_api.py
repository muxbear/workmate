"""知识库分组 API（迭代 6 T6.2）。

**刻意另起一个前缀**（``/api/knowledge-base-groups``）而不是挂在
``/api/knowledge-bases/groups``：后者会被更早注册的 ``/{kb_id}`` 吃掉（T0.4 的
路由遮蔽就是这么来的）。换前缀是从根本上消除歧义，而不是靠注册顺序。

权限用 ``knowledge:edit``：分组是对知识库的组织方式，属于"编辑"范畴；且这些接口
只作用于**本人**的分组（每个查询都带 user_id），不涉及他人的数据。
"""

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_db
from api.knowledge_base.schemas import (
    KBGroupCreateRequest,
    KBGroupResponse,
    KBGroupUpdateRequest,
)
from api.knowledge_base.service import (
    create_group,
    delete_group,
    list_groups,
    rename_group,
)
from api.rbac.deps import RequirePermission
from core.audit import audit_scope

router = APIRouter(prefix="/api/knowledge-base-groups", tags=["知识库-分组"])


@router.get("", response_model=dict)
async def list_kb_groups(
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(RequirePermission("knowledge:edit")),
):
    """本人的分组列表（含每组的知识库数量）。"""
    groups = await list_groups(db, user_id)
    return {
        "code": 0,
        "data": [KBGroupResponse(**g).model_dump(mode="json") for g in groups],
        "message": "ok",
    }


@router.post("", response_model=dict)
async def create_kb_group(
    body: KBGroupCreateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(RequirePermission("knowledge:edit")),
):
    """新建分组（同一用户下重名 → 409）。"""
    async with audit_scope("knowledge.group.create", user_id, request) as entry:
        group = await create_group(db, user_id, body.name)
        await db.commit()
        entry.target = group["id"]
        entry.detail["name"] = group["name"]
    return {"code": 0, "data": KBGroupResponse(**group).model_dump(mode="json"), "message": "ok"}


@router.put("/{group_id}", response_model=dict)
async def rename_kb_group(
    group_id: str,
    body: KBGroupUpdateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(RequirePermission("knowledge:edit")),
):
    """重命名分组。"""
    async with audit_scope("knowledge.group.rename", user_id, request, target=group_id) as entry:
        group = await rename_group(db, user_id, group_id, body.name)
        await db.commit()
        entry.detail["name"] = group["name"]
    return {"code": 0, "data": KBGroupResponse(**group).model_dump(mode="json"), "message": "ok"}


@router.delete("/{group_id}", response_model=dict)
async def delete_kb_group(
    group_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(RequirePermission("knowledge:edit")),
):
    """删除分组——**只解除归属，不删知识库**。"""
    async with audit_scope("knowledge.group.delete", user_id, request, target=group_id):
        await delete_group(db, user_id, group_id)
        await db.commit()
    return {"code": 0, "data": None, "message": "ok"}
