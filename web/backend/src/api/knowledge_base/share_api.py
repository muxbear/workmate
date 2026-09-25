"""知识库分享 API 路由——邀请 / 接受 / 拒绝 / 撤销 / 可见范围切换。

写权限一律仅所有者；被邀请人只能接受或拒绝自己收到的邀请。

**路径命名约束**：本文件里所有「不需要 kb_id」的接口都必须带 ``shares/`` 前缀
（如 ``/shares/candidates``）。此前候选用户接口写作 ``/share-candidates``——单段
路径与 ``kb_api`` 的 ``GET /{kb_id}`` 段数相同，而 ``kb_router`` 先于本模块注册，
于是该请求被 ``GET /{kb_id}`` 吃掉（kb_id="share-candidates"）并返回 404，
分享弹窗的候选用户列表**永远为空**。新增接口时请保持 ``shares/`` 前缀，并跑
``tests/unit_tests/test_kb_routes.py`` 的路由遮蔽检查。
"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user_id, get_db
from api.knowledge_base.schemas import (
    KBShareCreateRequest,
    KBVisibilityUpdateRequest,
)
from api.knowledge_base.share_service import (
    cancel_shares,
    delete_share,
    invite_shares,
    list_invitations,
    list_shares,
    list_shares_by_owner,
    respond_share,
    search_share_candidates,
    set_visibility,
)
from api.rbac.deps import RequirePermission
from core.audit import audit_scope
from core.decorators import handle_errors
from core.response import ok

router = APIRouter(prefix="/api/knowledge-bases", tags=["知识库分享"])


# ─── 被邀请人视角（不需要 kb_id）────────────────────────────────────────────

@router.get("/shares/candidates")
@handle_errors
async def get_share_candidates(
    search: str = Query(default="", description="按用户名 / 昵称模糊匹配"),
    limit: int = Query(default=20, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user_id),
) -> object:
    """搜索可分享的用户（仅返回展示所需的最小字段）。"""
    return ok(await search_share_candidates(db, user_id, search, limit))


@router.get("/shares/invitations")
@handle_errors
async def get_invitations(
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user_id),
) -> object:
    """获取「共享给我的」邀请与已授权记录。"""
    return ok(await list_invitations(db, user_id))


@router.get("/shares/by-me")
@handle_errors
async def get_shares_by_me(
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user_id),
) -> object:
    """获取「我分享出去的」全部记录（跨知识库，供左栏栏目使用）。"""
    return ok(await list_shares_by_owner(db, user_id))


@router.post("/shares/{share_id}/accept")
@handle_errors
async def accept_share(
    share_id: str,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user_id),
) -> object:
    """接受分享邀请。"""
    return ok(await respond_share(db, share_id, user_id, accept=True))


@router.post("/shares/{share_id}/reject")
@handle_errors
async def reject_share(
    share_id: str,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user_id),
) -> object:
    """拒绝分享邀请。"""
    return ok(await respond_share(db, share_id, user_id, accept=False))


# ─── 所有者视角 ─────────────────────────────────────────────────────────────

@router.get("/{kb_id}/shares")
@handle_errors
async def get_shares(
    kb_id: str,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user_id),
) -> object:
    """列出某知识库的分享记录（仅所有者）。"""
    return ok(await list_shares(db, kb_id, user_id))


@router.post("/{kb_id}/shares")
@handle_errors
async def create_shares(
    kb_id: str,
    req: KBShareCreateRequest,
    db: AsyncSession = Depends(get_db),
    # 分享范围是库级配置，属于"编辑知识库"（被邀请人的接受/拒绝不在此列——
    # 那是"我的收件箱"操作，按参与者身份鉴权，与库的编辑权无关）
    user_id: str = Depends(RequirePermission("knowledge:edit")),
) -> object:
    """邀请用户浏览知识库（仅所有者，只读授权）。"""
    async with audit_scope(
        "knowledge.share.invite", user_id, None, target=kb_id,
        count=len(req.user_ids),
    ):
        result = await invite_shares(db, kb_id, user_id, req.user_ids)
    return ok(result)


@router.post("/{kb_id}/shares/cancel")
@handle_errors
async def cancel_all_shares(
    kb_id: str,
    db: AsyncSession = Depends(get_db),
    # 分享范围是库级配置，属于"编辑知识库"（被邀请人的接受/拒绝不在此列——
    # 那是"我的收件箱"操作，按参与者身份鉴权，与库的编辑权无关）
    user_id: str = Depends(RequirePermission("knowledge:edit")),
) -> object:
    """取消该知识库的全部分享（仅所有者）。"""
    async with audit_scope("knowledge.share.cancel_all", user_id, None, target=kb_id):
        result = {"revoked": await cancel_shares(db, kb_id, user_id)}
    return ok(result)


@router.delete("/{kb_id}/shares/{share_id}")
@handle_errors
async def remove_share(
    kb_id: str,
    share_id: str,
    db: AsyncSession = Depends(get_db),
    # 分享范围是库级配置，属于"编辑知识库"（被邀请人的接受/拒绝不在此列——
    # 那是"我的收件箱"操作，按参与者身份鉴权，与库的编辑权无关）
    user_id: str = Depends(RequirePermission("knowledge:edit")),
) -> object:
    """删除某个被分享用户（仅所有者）。"""
    async with audit_scope("knowledge.share.revoke", user_id, None, target=kb_id):
        await delete_share(db, kb_id, share_id, user_id)
    return ok({"deleted": True})


@router.patch("/{kb_id}/visibility")
@handle_errors
async def update_visibility(
    kb_id: str,
    req: KBVisibilityUpdateRequest,
    db: AsyncSession = Depends(get_db),
    # 分享范围与公开可见性是库级配置，属于"编辑知识库"
    user_id: str = Depends(RequirePermission("knowledge:edit")),
) -> object:
    """发布 / 取消发布公共知识库（仅所有者）。"""
    async with audit_scope(
        "knowledge.publish", user_id, None, target=kb_id,
        visibility=req.visibility,
    ):
        result = await set_visibility(db, kb_id, user_id, req.visibility)
    return ok(result)
