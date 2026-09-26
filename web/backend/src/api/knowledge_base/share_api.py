"""知识库分享 API 路由——邀请 / 接受 / 拒绝 / 撤销 / 可见范围切换。

写权限一律仅所有者；被邀请人只能接受或拒绝自己收到的邀请。

**路径命名约束**：本文件里所有「不需要 kb_id」的接口都必须带 ``shares/`` 前缀
（如 ``/shares/candidates``）。此前候选用户接口写作 ``/share-candidates``——单段
路径与 ``kb_api`` 的 ``GET /{kb_id}`` 段数相同，而 ``kb_router`` 先于本模块注册，
于是该请求被 ``GET /{kb_id}`` 吃掉（kb_id="share-candidates"）并返回 404，
分享弹窗的候选用户列表**永远为空**。新增接口时请保持 ``shares/`` 前缀，并跑
``tests/unit_tests/test_kb_routes.py`` 的路由遮蔽检查。
"""

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user_id, get_db
from api.knowledge_base.schemas import (
    KBShareCreateRequest,
    KBShareLinkCreateRequest,
    KBVisibilityUpdateRequest,
)
from api.knowledge_base.share_link_service import (
    accept_share_link as accept_share_link_service,
)
from api.knowledge_base.share_link_service import (
    create_share_link as create_share_link_service,
)
from api.knowledge_base.share_link_service import (
    list_share_links as list_share_links_service,
)
from api.knowledge_base.share_link_service import (
    preview_share_link as preview_share_link_service,
)
from api.knowledge_base.share_link_service import (
    revoke_share_link as revoke_share_link_service,
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
from core.decorators import handle_errors, rate_limit
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



# ─── 链接式分享（迭代 6 T6.3）──────────────────────────────────────────────
#
# 路径约束沿用本文件的既有约定：不带 kb_id 的接口必须以两段式 `shares/*` 开头，
# 否则会被更早注册的 `GET /{kb_id}` 吃掉（有 test_kb_routes.py 守着）。


@router.post("/{kb_id}/share-links", status_code=201, response_model=dict)
async def create_share_link(
    kb_id: str,
    body: KBShareLinkCreateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(RequirePermission("knowledge:edit")),
):
    """创建一条链接分享。**明文 token 只在这里出现一次**（库里只存 sha256 摘要）。"""
    async with audit_scope("knowledge.share.link_create", user_id, request, target=kb_id) as entry:
        result = await create_share_link_service(
            db, kb_id, user_id,
            permission=body.permission, expires_in=body.expires_in,
        )
        await db.commit()
        entry.detail["permission"] = body.permission
        entry.detail["expires_in"] = body.expires_in
    return {"code": 0, "data": result, "message": "ok"}


@router.get("/{kb_id}/share-links", response_model=dict)
async def list_share_links(
    kb_id: str,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(RequirePermission("knowledge:edit")),
):
    """列出该库的链接（**不含 token 与摘要**——丢了明文只能重建）。"""
    return {
        "code": 0,
        "data": await list_share_links_service(db, kb_id, user_id),
        "message": "ok",
    }


@router.delete("/{kb_id}/share-links/{link_id}", response_model=dict)
async def revoke_share_link(
    kb_id: str,
    link_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(RequirePermission("knowledge:edit")),
):
    """撤销一条链接——**只关闭"再拉新人"的入口**，已接受的人保留访问权。"""
    async with audit_scope("knowledge.share.link_revoke", user_id, request, target=kb_id):
        await revoke_share_link_service(db, kb_id, link_id, user_id)
        await db.commit()
    return {"code": 0, "data": {"revoked": True}, "message": "ok"}


@router.get("/shares/links/{token}/preview", response_model=dict)
# 出网面上唯一的新增匿名端点：限流 + 不缓存（避免中间层把"某 token 的库名"存下来）
@rate_limit(max_calls=30, period_seconds=60, key_prefix="kb_share_preview")
async def preview_share_link(
    token: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """免登录预览：只回元信息（库名/描述/计数/权限/有效期），**不含 kb_id 与任何正文**。

    "不存在 / 已撤销 / 已过期 / 库已删除"返回完全一致的 404——区分它们等于给出一个
    "这个 token 曾经有效"的预言机。
    """
    data = await preview_share_link_service(db, token)
    response = ok(data)
    # 分享链接是凭证：中间缓存会把"某 token 对应的库名"留在缓存里
    response.headers["Cache-Control"] = "no-store"
    return response


@router.post("/shares/links/{token}/accept", response_model=dict)
@rate_limit(max_calls=20, period_seconds=60, key_prefix="kb_share_accept")
async def accept_share_link(
    token: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user_id),
):
    """登录后接受链接（幂等）：落成一条普通的已接受分享行，于是读路径零改动。

    权限来自 **token 本身**（链接就是库主的授权），所以这里不挂 `RequirePermission`——
    与「接受/拒绝邀请」同类：被授权的动作不该再要求"能编辑这个库"。
    """
    async with audit_scope("knowledge.share.link_accept", user_id, request) as entry:
        result = await accept_share_link_service(db, token, user_id)
        await db.commit()
        entry.detail["permission"] = result.get("permission")
        entry.detail["already"] = result.get("already")
    return {"code": 0, "data": result, "message": "ok"}

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
