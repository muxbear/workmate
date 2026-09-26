"""知识库业务逻辑——CRUD + 统计 + 访问权限解析。"""

from __future__ import annotations

import logging
import os
import shutil
from datetime import datetime
from enum import StrEnum
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException
from sqlalchemy import String, and_, cast, false, func, or_, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from api.knowledge_base.model_provider import check_embedding_dim
from api.knowledge_base.schemas import (
    IndexConfigSchema,
    KBCreateRequest,
    KBListResponse,
    KBResponse,
    KBStatsResponse,
    KBUpdateRequest,
)
from core.rag.vector_store import BaseVectorStore
from db.models.knowledge_base import KnowledgeBase
from db.models.knowledge_base_grant import (
    GRANT_TARGET_DEPT,
    GRANT_TARGET_ROLE,
    KnowledgeBaseGrant,
)
from db.models.knowledge_base_share import (
    SHARE_STATUS_ACCEPTED,
    KnowledgeBaseShare,
)
from db.models.user import Account

if TYPE_CHECKING:
    from api.knowledge_base.mediator import KnowledgeBaseMediator

logger = logging.getLogger(__name__)

# 说明：阶段名与状态口径统一在 doc_service（STAGE_NAMES / STAGE_STATUS_ORDER /
# compute_stages）。本文件曾有一份 8 项的重复常量（"BM25 倒排 / 实体抽取 / 关系抽取
# / 入库"），与实现不符且无调用方，已删除以免继续误导。

# 知识库可见范围
VISIBILITY_PRIVATE = "private"
VISIBILITY_PUBLIC = "public"

# 列表 scope 取值
SCOPE_PERSONAL = "personal"        # 我创建的（保持历史默认行为）
SCOPE_PUBLIC = "public"            # 全站公共库
SCOPE_SHARED_WITH_ME = "shared_with_me"  # 别人分享给我且我已接受
SCOPE_ALL = "all"                  # 概览：自己 + 公共 + 分享给我


class KBAccess(StrEnum):
    """当前用户对某知识库的访问级别（顺序即强弱：OWNER > WRITE > GRANTEE > PUBLIC > NONE）。"""

    OWNER = "owner"        # 自己创建：可读写、可管理（改配置/分享/删库）
    WRITE = "write"        # 被授予写权限（用户分享 / 链接 / 部门或角色授权）：可改内容
    GRANTEE = "grantee"    # 被授予读权限：只读
    PUBLIC = "public"      # 公共库：只读
    NONE = "none"          # 无权限


#: KBAccess 的强弱序（取"多来源里最强的一档"用）
_ACCESS_ORDER = {
    KBAccess.NONE: 0,
    KBAccess.PUBLIC: 1,
    KBAccess.GRANTEE: 2,
    KBAccess.WRITE: 3,
    KBAccess.OWNER: 4,
}


def access_rank(access: KBAccess) -> int:
    """访问级别的强弱值（同一用户可能同时命中多条授权，取最大）。"""
    return _ACCESS_ORDER.get(access, 0)


def _level_for_permission(permission: str | None) -> KBAccess:
    """分享/授权的 permission 字段 → 访问级别。"""
    return KBAccess.WRITE if permission == "write" else KBAccess.GRANTEE


def access_str(access: KBAccess) -> str:
    """访问级别 → 给客户端的三个值（owner / write / read）。"""
    if access is KBAccess.OWNER:
        return "owner"
    if access is KBAccess.WRITE:
        return "write"
    return "read"


async def _public_scope_condition(
    db: AsyncSession, user_id: str, role_key: str | None = None,
):
    """构造「公开库可见」的条件（按数据范围收敛到本部门/子树/custom）。

    抽出来是因为**两条读路径**都要用它：列表页的"可见性并集"与"公共库"页签。
    此前公共库页签只按 ``visibility == public`` 过滤，与列表页是两套判定——
    只收紧一处会留下另一条漏出范围外公开库的通道。

    Returns:
        条件表达式；范围为空时返回恒假条件（公开不构成额外可见性）。
    """
    from api.rbac.data_scope import resolve_dept_scope

    visible_depts = await resolve_dept_scope(db, user_id, "knowledge", role_key)
    if visible_depts is None:
        return KnowledgeBase.visibility == VISIBILITY_PUBLIC  # 范围 = all
    if not visible_depts:
        return false()
    return and_(
        KnowledgeBase.visibility == VISIBILITY_PUBLIC,
        KnowledgeBase.dept_id.in_(visible_depts),
    )


def _accepted_share_condition(user_id: str):
    """「有效的」已接受分享：状态已接受、**且未过期**。

    过期是**派生态**（刻意不写 ``status='expired'``），所以判定必须现算。时钟统一
    用 Python 侧的 ``datetime.utcnow()`` 绑定参数——PG 的 ``func.now()`` 是服务器
    本地时间，与本仓业务时间戳（全部 utcnow）混用会在非 UTC 部署上产生漂移。
    """
    now = datetime.utcnow()
    return and_(
        KnowledgeBaseShare.grantee_id == user_id,
        KnowledgeBaseShare.status == SHARE_STATUS_ACCEPTED,
        or_(
            KnowledgeBaseShare.expires_at.is_(None),
            KnowledgeBaseShare.expires_at > now,
        ),
    )


def _accepted_share_kb_ids(user_id: str):
    """上面那条条件的 ``kb_id`` 子查询（供 ``KnowledgeBase.id.in_()`` 复用）。"""
    return select(KnowledgeBaseShare.kb_id).where(_accepted_share_condition(user_id))


async def _grant_subject_conditions(db: AsyncSession, user_id: str) -> list:
    """「我属于哪些授权对象」的条件：部门祖先链 / 我持有的有效角色。

    整表过滤与"按 id 判定"共用它——两份实现正是"列表藏起来、按 id 仍能打开"的老坑。

    - **部门**：授权挂在某部门上时，``include_subtree`` 决定是否覆盖其子孙。所以
      分两支：命中**本部门**（含不含子树都覆盖）、命中**祖先部门且该授权含子树**。
    - **角色**：匹配用户**持有的任一有效角色**（不是"当前活动角色"）——授权是
      "这个角色的人可以看"的客观事实，不该随用户今天把哪个角色设为活动而变。
    """
    from api.rbac.data_scope import dept_ancestors, resolve_user_dept
    from api.rbac.role_utils import list_active_user_roles

    branches: list = []
    own_dept = await resolve_user_dept(db, user_id)
    if own_dept:
        ancestors = await dept_ancestors(db, own_dept)
        branches.append(and_(
            KnowledgeBaseGrant.target_type == GRANT_TARGET_DEPT,
            or_(
                KnowledgeBaseGrant.target_id == own_dept,
                and_(
                    KnowledgeBaseGrant.include_subtree.is_(True),
                    KnowledgeBaseGrant.target_id.in_(ancestors - {own_dept}),
                ),
            ),
        ))

    role_keys = {r.key for r in await list_active_user_roles(db, user_id)}
    if role_keys:
        branches.append(and_(
            KnowledgeBaseGrant.target_type == GRANT_TARGET_ROLE,
            KnowledgeBaseGrant.target_id.in_(role_keys),
        ))

    return branches


async def _grant_condition(db: AsyncSession, user_id: str):
    """部门 / 角色维度授权的可读条件（立即生效、无需接受）。"""
    branches = await _grant_subject_conditions(db, user_id)
    if not branches:
        return false()
    return KnowledgeBase.id.in_(
        select(KnowledgeBaseGrant.kb_id).where(
            KnowledgeBaseGrant.revoked_at.is_(None),
            or_(*branches),
        )
    )


async def _readable_condition(
    db: AsyncSession, user_id: str, role_key: str | None = None,
):
    """构造「当前用户可读」的 SQL 条件。

    四个来源：**自己创建的 ∪ 部门范围内公开的 ∪ 已接受且未过期的分享 ∪ 部门/角色授权**。

    **消费方有三处，必须共用这一条**：``list_kbs``（列表）、``get_kb_stats``（统计）、
    以及 agent 工具 ``agent/tools/kb_search.py``（智能体检索）。任何一处自己拼条件，
    就会出现"网页里搜不到、智能体却搜得到"（或反过来）的越权/漏检——
    有测试 `test_kb_tenant_isolation.TestListPathsAgree` 守这条。

    公开库此前等于"全站可见"，与部门无关；接入 RBAC 的数据范围后收敛为
    "**数据范围内**公开"（迭代 5 T5.2）。这里只**收紧**、不放宽：
    - 别人的**私有库**仍然只对本人与被分享人可见——数据范围不构成读私有库的理由；
    - 范围未配置 / 用户没有部门归属 / 库没有归属部门（创建者无人员档案）时，
      该库**不因"公开"而额外可见**，只对本人与被分享人可见。

    Args:
        db: 会话（用于解析部门归属与数据范围）。
        user_id: 当前用户。
        role_key: 活动角色键；有请求上下文时传入，与接口鉴权的活动角色同源。

    Returns:
        SQLAlchemy 条件表达式。所有放宽可见性的查询都必须复用它——
        各处自行拼条件正是越权的来源。
    """
    return or_(
        KnowledgeBase.user_id == user_id,
        await _public_scope_condition(db, user_id, role_key),
        # 已接受且**未过期**的用户分享（过期在 SQL 里排除，不靠逐行过滤）
        KnowledgeBase.id.in_(_accepted_share_kb_ids(user_id)),
        # 部门 / 角色维度授权（立即生效）
        await _grant_condition(db, user_id),
    )


def _escape_like(value: str) -> str:
    """转义 LIKE 的特殊字符（``%`` / ``_`` / ``\\``）。"""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _like_pattern(search: str) -> str:
    """把用户输入转成安全的 LIKE 模式串。

    配合 ``ilike(pattern, escape="\\\\")`` 使用：用户搜索 "a_b" 时应当只匹配字面
    下划线，而不是把它当成单字符通配符。
    """
    return f"%{_escape_like(search)}%"


def _format_bytes(size_bytes: int) -> str:
    """将字节数格式化为人类可读字符串。"""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    s: float = size_bytes
    for unit in ["KB", "MB", "GB", "TB"]:
        s /= 1024
        if s < 1024:
            return f"{s:.1f} {unit}"
    return f"{s:.1f} PB"


def _sparse_index_params(config: object) -> dict[str, float]:
    """从知识库配置里取出 BM25 索引参数（k1/b）。

    这两个值要传给向量库**建集合**——Milvus 的原生 BM25 把 k1/b 固化在稀疏索引里，
    建完再改配置只有重建索引才能生效。配置可能是 ``IndexConfigSchema``（对象）或
    落库的 dict（历史配置键名还可能是 camelCase），两种都要认。
    """
    def pick(name: str, camel: str) -> float | None:
        for key in (name, camel):
            if isinstance(config, dict):
                value = config.get(key)
            elif config is not None:
                value = getattr(config, key, None)
            else:
                value = None
            # bool 是 int 的子类，但不是合法参数（配置里不该出现，出现也当没填）
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return float(value)
        return None

    params: dict[str, float] = {}
    k1 = pick("bm25_k1", "bm25K1")
    b = pick("bm25_b", "bm25B")
    if k1 is not None:
        params["bm25_k1"] = k1
    if b is not None:
        params["bm25_b"] = b
    return params


def _kb_to_response(
    kb: KnowledgeBase,
    *,
    viewer_id: str | None = None,
    owner_name: str | None = None,
    access: str | None = None,
) -> KBResponse:
    """ORM 模型 → 响应对象。

    ``viewer_id`` 用于标记 ``is_owner``——前端据此切换到只读态；
    为空时按所有者视角处理（创建/更新的返回值）。

    ``access`` 是访问级别（owner/write/read，迭代 6 T6.3）。不传时按归属推断：
    自己的库是 owner，其余保守地按 read（"宁可少给"——写操作在后端另有判定，
    前端只是显隐）。
    """
    return KBResponse(
        id=kb.id,
        name=kb.name,
        description=kb.description,
        status=kb.status,
        docs_count=kb.docs_count,
        chunks_count=kb.chunks_count,
        entities_count=kb.entities_count,
        relations_count=kb.relations_count,
        size_bytes=kb.size_bytes,
        size_display=_format_bytes(kb.size_bytes),
        tags=kb.tags,
        config=IndexConfigSchema(**kb.config) if kb.config else IndexConfigSchema(),
        created_at=kb.created_at,
        updated_at=kb.updated_at,
        visibility=kb.visibility or VISIBILITY_PRIVATE,
        is_owner=(access == "owner") if access is not None
        else (viewer_id is None or kb.user_id == viewer_id),
        owner_name=owner_name,
        access=access or ("owner" if viewer_id is None or kb.user_id == viewer_id else "read"),
        is_pinned=bool(kb.is_pinned),
        sort_order=int(kb.sort_order or 0),
        group_id=kb.group_id,
    )


async def _load_access_map(
    db: AsyncSession, user_id: str, kb_ids: list[str],
) -> dict[str, str]:
    """批量算出这些库对该用户的访问级别（供列表用）。

    **必须与 ``resolve_kb_access`` 同源**（复用同一批条件）：两边算法不一致就会出现
    "列表里显示可写、点进去不能写"（或反过来）这种最难解释的错。调用方只需对
    **不属于自己的**行调用它——自己的库一律 owner。
    """
    if not kb_ids:
        return {}

    levels: dict[str, KBAccess] = {}

    def raise_to(kb_id: str, level: KBAccess) -> None:
        current = levels.get(kb_id, KBAccess.NONE)
        if access_rank(level) > access_rank(current):
            levels[kb_id] = level

    rows = (
        await db.execute(
            select(KnowledgeBaseShare.kb_id, KnowledgeBaseShare.permission).where(
                KnowledgeBaseShare.kb_id.in_(kb_ids),
                _accepted_share_condition(user_id),
            )
        )
    ).all()
    for kb_id, permission in rows:
        raise_to(kb_id, _level_for_permission(permission))

    branches = await _grant_subject_conditions(db, user_id)
    if branches:
        rows = (
            await db.execute(
                select(KnowledgeBaseGrant.kb_id, KnowledgeBaseGrant.permission).where(
                    KnowledgeBaseGrant.kb_id.in_(kb_ids),
                    KnowledgeBaseGrant.revoked_at.is_(None),
                    or_(*branches),
                )
            )
        ).all()
        for kb_id, permission in rows:
            raise_to(kb_id, _level_for_permission(permission))

    public_ids = (
        await db.execute(
            select(KnowledgeBase.id).where(
                KnowledgeBase.id.in_(kb_ids),
                await _public_scope_condition(db, user_id),
            )
        )
    ).scalars().all()
    for kb_id in public_ids:
        raise_to(kb_id, KBAccess.PUBLIC)

    return {kb_id: access_str(level) for kb_id, level in levels.items()}


async def _load_owner_names(db: AsyncSession, user_ids: list[str]) -> dict[str, str]:
    """按用户 ID 批量加载展示名（昵称优先，其次用户名）。"""
    ids = [uid for uid in dict.fromkeys(user_ids) if uid]
    if not ids:
        return {}
    rows = (await db.execute(select(Account).where(Account.id.in_(ids)))).scalars().all()
    return {
        a.id: (a.nickname or a.username or a.id)
        for a in rows
    }


async def list_kbs(
    db: AsyncSession,
    user_id: str,
    page: int = 1,
    page_size: int = 12,
    search: str | None = None,
    scope: str = SCOPE_PERSONAL,
    role_key: str | None = None,
    tag: str | None = None,
    group_id: str | None = None,
) -> KBListResponse:
    """获取知识库列表（分页 + 模糊搜索 + 标签筛选 + 可见范围过滤）。

    scope 取值见 ``SCOPE_*`` 常量；默认 ``personal`` 保持历史行为（只返回本人创建）。
    """
    page = max(1, page)
    page_size = max(1, min(page_size, 100))
    offset = (page - 1) * page_size

    if scope == SCOPE_PUBLIC:
        # 公共库：只展示别人的（自己的公共库已归入「个人知识库」）。
        # **必须叠加数据范围**：只按 visibility 过滤会让范围外的公开库从"公共库"
        # 页签漏出去（与列表页走了两条不同的可见性判定）
        scope_condition = and_(
            KnowledgeBase.visibility == VISIBILITY_PUBLIC,
            KnowledgeBase.user_id != user_id,
            await _public_scope_condition(db, user_id, role_key),
        )
    elif scope == SCOPE_SHARED_WITH_ME:
        # 与列表/按 id 判定共用同一条条件：否则"共享给我的"页签里还挂着**已过期**的库
        scope_condition = KnowledgeBase.id.in_(_accepted_share_kb_ids(user_id))
    elif scope == SCOPE_ALL:
        scope_condition = await _readable_condition(db, user_id, role_key)
    else:
        scope_condition = KnowledgeBase.user_id == user_id

    conditions: list = [scope_condition]
    if search:
        # 必须用 or_() 显式包裹：此前用 text("name ILIKE :q OR description ILIKE :q")
        # 与 scope 条件平铺进 where()，SQL 的 AND 优先级高于 OR，实际语义变成
        # (scope AND name LIKE) OR (description LIKE)——后半个分支没有任何权限
        # 过滤，任何人只要带 search 参数就能搜出他人私有知识库。
        pattern = _like_pattern(search)
        conditions.append(
            or_(
                KnowledgeBase.name.ilike(pattern, escape="\\"),
                KnowledgeBase.description.ilike(pattern, escape="\\"),
            )
        )

    if tag:
        # tags 是 JSON 列，PG 的 ``@>`` 只对 JSONB 生效、SQLite 更是没有——用
        # "把 JSON 转成文本再匹配带引号的标签"这种两库都认的写法。带引号是为了
        # 避免子串误命中（"k8s" 不该匹配到 "k8s-prod"）。
        conditions.append(
            cast(KnowledgeBase.tags, String).like(f'%"{_escape_like(tag)}"%')
        )

    if group_id:
        # 分组筛选不需要额外校验归属：作用域条件已经把结果限制在"我可见的库"里，
        # 传别人的分组 id 只会筛出空列表
        conditions.append(KnowledgeBase.group_id == group_id)

    # Total count
    total_stmt = select(func.count()).select_from(KnowledgeBase).where(*conditions)
    total = (await db.execute(total_stmt)).scalar() or 0

    # 排序：置顶 → 手工顺序 → 最近更新。
    # **只对「我创建的」生效**：is_pinned/sort_order 是本人列表视图偏好（存在库行上
    # 是最省事的实现），别人的视图不该被库主的偏好改变顺序。
    order_by: tuple[Any, ...] = (
        (
            KnowledgeBase.is_pinned.desc(),
            KnowledgeBase.sort_order.asc(),
            KnowledgeBase.updated_at.desc(),
        )
        if scope == SCOPE_PERSONAL
        else (KnowledgeBase.updated_at.desc(),)
    )

    # Items
    stmt = (
        select(KnowledgeBase)
        .where(*conditions)
        .order_by(*order_by)
        .offset(offset)
        .limit(page_size)
    )
    rows = (await db.execute(stmt)).scalars().all()

    owner_names = await _load_owner_names(db, [r.user_id for r in rows])
    # personal 范围内全是自己的库（owner），不必多查两次；其余范围要算出每行的级别，
    # 否则前端分不清"别人的公共库"和"被授予可写的库"——两者都要显示，但能不能写不同
    access_map = {} if scope == SCOPE_PERSONAL else await _load_access_map(
        db, user_id, [r.id for r in rows if r.user_id != user_id],
    )

    return KBListResponse(
        items=[
            _kb_to_response(
                r, viewer_id=user_id, owner_name=owner_names.get(r.user_id),
                access=access_map.get(r.id),
            )
            for r in rows
        ],
        total=total,
        page=page,
        page_size=page_size,
    )


async def get_kb_stats(
    db: AsyncSession, user_id: str, scope: str = SCOPE_PERSONAL,
    role_key: str | None = None,
) -> KBStatsResponse:
    """获取知识库统计信息（默认只统计本人创建，scope=all 时统计全部可见库）。"""
    scope_condition = (
        await _readable_condition(db, user_id, role_key)
        if scope == SCOPE_ALL
        else KnowledgeBase.user_id == user_id
    )
    base = select(
        func.coalesce(func.sum(KnowledgeBase.docs_count), 0),
        func.coalesce(func.sum(KnowledgeBase.chunks_count), 0),
        func.coalesce(func.sum(KnowledgeBase.entities_count), 0),
        func.count(KnowledgeBase.id),
    ).where(scope_condition)
    result = (await db.execute(base)).one()
    total_docs, total_chunks, total_entities, total_kbs = result

    indexing_count = (
        await db.execute(
            select(func.count())
            .select_from(KnowledgeBase)
            .where(
                scope_condition,
                KnowledgeBase.status == "indexing",
            )
        )
    ).scalar() or 0

    return KBStatsResponse(
        total_kbs=total_kbs,
        total_docs=total_docs,
        total_chunks=total_chunks,
        total_entities=total_entities,
        total_indexing=indexing_count,
    )


async def _flush_or_name_conflict(db: AsyncSession, name: str) -> None:
    """落库，并把"撞唯一索引"翻译成可读的 409（迭代 5 T5.6）。

    应用层的"先查后插"在并发下会漏：两个请求同时查不到、同时插入。真正的把关是数据库的
    部分唯一索引 ``uq_kb_user_name``（见 ``migrations/0001``）。约束生效后，并发重名以
    ``IntegrityError`` 的形式爆出来——不翻译它就是一个 500，用户只看到"服务器错误"，
    而正确的答复是"该名字已存在"。

    撞约束后**必须先回滚**：事务此时已中止，不回滚的话依赖注入收尾时的 commit 会再炸一次，
    把 409 变成 500。

    这里的 IntegrityError 一律按重名处理：本函数只用于知识库行的写入，``user_id``/``name``
    等非空列由应用侧保证，其余能撞的约束只有这一个。真实数据库报错记进日志备查。
    """
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        logger.warning("知识库重名冲突（唯一索引拦截）name=%s: %s", name, exc)
        raise HTTPException(status_code=409, detail=f"知识库 '{name}' 已存在") from exc


async def create_kb(
    db: AsyncSession,
    user_id: str,
    req: KBCreateRequest,
    vector_store: BaseVectorStore | None = None,
) -> KBResponse:
    """创建知识库。"""
    # Check name uniqueness
    existing = (
        await db.execute(
            select(KnowledgeBase).where(
                KnowledgeBase.user_id == user_id,
                KnowledgeBase.name == req.name,
            )
        )
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail=f"知识库 '{req.name}' 已存在")

    # 配额（T5.3）：先查库数上限，再谈建库——超限时不该留下半成品
    from api.knowledge_base.quota import ensure_kb_quota

    await ensure_kb_quota(db, user_id)

    # 维度校验（T4.4）：配置维度与模型真实维度不一致时**先拒绝**，不要等写向量才炸。
    # 放在建行/建集合之前——校验失败时不留半成品（否则会出现"库建好了但永远写不进去"）。
    mismatch = await check_embedding_dim(db, req.config)
    if mismatch:
        raise HTTPException(status_code=400, detail=mismatch)

    # 归属部门取自创建者的人员档案：它是"公开库可见范围"的判定依据（T5.2）。
    # 没有档案（如平台管理员账号没建人员）时留空——留空只会**收紧**公开范围，
    # 不会放行（见 _public_scope_condition）。
    from api.rbac.data_scope import resolve_user_dept

    kb = KnowledgeBase(
        name=req.name,
        description=req.description,
        tags=req.tags,
        config=req.config.model_dump(),
        user_id=user_id,
        status="draft",
        visibility=req.visibility or VISIBILITY_PRIVATE,
        dept_id=await resolve_user_dept(db, user_id),
    )
    db.add(kb)
    await _flush_or_name_conflict(db, req.name)

    # Create vector DB collection
    if vector_store:
        dim = req.config.embedding_dim
        try:
            # BM25 的 k1/b 固化在稀疏索引里，必须在建集合时就带上知识库的配置
            await vector_store.create_collection(
                kb.id, dim, sparse_params=_sparse_index_params(req.config),
            )
        except Exception as e:
            logger.error("Failed to create vector collection for kb=%s: %s", kb.id, e)

    return _kb_to_response(kb)


async def get_kb(db: AsyncSession, kb_id: str, user_id: str) -> KBResponse:
    """获取知识库详情（本人所有 / 已接受分享 / 公共库均可读）。"""
    kb, access = await require_kb_readable(db, kb_id, user_id)
    owner_names = await _load_owner_names(db, [kb.user_id])
    return _kb_to_response(
        kb, viewer_id=user_id, owner_name=owner_names.get(kb.user_id),
        access=access_str(access),
    )


async def update_kb(
    db: AsyncSession, kb_id: str, user_id: str, req: KBUpdateRequest,
) -> KBResponse:
    """更新知识库。"""
    kb = await _get_kb_or_404(db, kb_id, user_id)

    update_data = req.model_dump(exclude_none=True)

    for key, value in update_data.items():
        if value is not None:
            setattr(kb, key, value)

    kb.updated_at = datetime.utcnow()
    # 改名同样会撞唯一索引——重命名成已存在的库名，此前是一个 500
    await _flush_or_name_conflict(db, kb.name)
    return _kb_to_response(kb)


async def delete_kb(
    db: AsyncSession,
    kb_id: str,
    user_id: str,
    vector_store: BaseVectorStore | None = None,
    mediator: KnowledgeBaseMediator | None = None,
    scheduler=None,
) -> None:
    """删除知识库——**软删除**：标记 ``deleted_at``，内容暂留以便误删恢复。

    为什么改成软删除：删库会清空向量集合与磁盘原始文件，误删**不可逆**——用户点错一次
    就永久失去整个库。现在删除只是标记，内容（向量/文件/文档行/分享）都保留；
    查询侧由 `db.soft_delete` 的全局过滤器统一排除，因此删掉的库对**所有**入口都不可见
    （包括按 id 直接访问与智能体检索）。

    真正释放空间/彻底删除是另一个动作：:func:`purge_kb`（管理动作，不可恢复）。

    删除前仍会取消该库所有在跑的索引任务——否则任务会继续往向量库写入，
    与"已删除"的状态自相矛盾（恢复后还会多出一批来源不明的切片）。
    """
    kb = await _get_kb_or_404(db, kb_id, user_id)

    # 取消所有在跑/排队中的索引任务（内容保留，但不能再写入）
    if scheduler is not None:
        from db.models.knowledge_base_document import KnowledgeBaseDocument

        doc_ids = list(
            (
                await db.execute(
                    select(KnowledgeBaseDocument.id).where(
                        KnowledgeBaseDocument.kb_id == kb_id
                    )
                )
            ).scalars().all()
        )
        for doc_id in doc_ids:
            await scheduler.cancel(doc_id)

    kb.deleted_at = datetime.utcnow()
    kb.updated_at = datetime.utcnow()


async def restore_kb(db: AsyncSession, kb_id: str, user_id: str) -> None:
    """恢复被软删除的知识库（只有库主可恢复）。

    在 ``include_deleted()`` 作用域内查询：全局过滤器默认把已删除行藏起来，
    恢复与彻底删除必须显式"看得见它们"。
    """
    from db.soft_delete import include_deleted

    with include_deleted():
        kb = (
            await db.execute(
                select(KnowledgeBase).where(
                    KnowledgeBase.id == kb_id,
                    KnowledgeBase.user_id == user_id,
                )
            )
        ).scalar_one_or_none()
    if kb is None:
        raise HTTPException(status_code=404, detail="知识库不存在")
    if kb.deleted_at is None:
        raise HTTPException(status_code=400, detail="该知识库未被删除，无需恢复")

    # 同名库可能已在删除后被重建：恢复会撞唯一索引
    conflict = (
        await db.execute(
            select(KnowledgeBase).where(
                KnowledgeBase.user_id == user_id,
                KnowledgeBase.name == kb.name,
            )
        )
    ).scalar_one_or_none()
    if conflict is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"无法恢复：已存在同名知识库「{kb.name}」。"
                "请先重命名或删除那个库，再恢复。"
            ),
        )

    kb.deleted_at = None
    kb.updated_at = datetime.utcnow()


async def purge_kb(
    db: AsyncSession,
    kb_id: str,
    user_id: str,
    vector_store: BaseVectorStore | None = None,
    mediator: KnowledgeBaseMediator | None = None,
) -> None:
    """**彻底删除**（不可恢复）：清向量、清磁盘、删子表、删主行。

    这是此前 `delete_kb` 的行为，现在单独成一个显式动作：软删除之后需要一个
    "确实要释放空间"的出口，否则被删的库会永远占着向量与磁盘。
    """
    from core.config import get_settings
    from db.soft_delete import include_deleted

    with include_deleted():
        kb = (
            await db.execute(
                select(KnowledgeBase).where(
                    KnowledgeBase.id == kb_id,
                    KnowledgeBase.user_id == user_id,
                )
            )
        ).scalar_one_or_none()
    if kb is None:
        raise HTTPException(status_code=404, detail="知识库不存在")

    # 向量库清理（优先使用中介者）
    if mediator:
        await mediator.on_knowledge_base_deleted(kb_id)
    elif vector_store:
        try:
            await vector_store.delete_collection(kb_id)
        except Exception as e:
            logger.error("Failed to delete vector collection kb=%s: %s", kb_id, e)

    # 磁盘上的原始文件（整库目录）
    kb_upload_dir = os.path.join(get_settings().doc_upload_dir, kb_id)
    if os.path.isdir(kb_upload_dir):
        shutil.rmtree(kb_upload_dir, ignore_errors=True)

    # 子表：软删除期间保留了这些行，彻底删除时一并清掉。
    # 注：PG 侧有新表的外键 ON DELETE CASCADE 兜底，但 **SQLite 上外键不生效**，
    # 而 `test_purge_removes_everything` 正是查残留——逐表删是两条路都成立的写法。
    for table in (
        "knowledge_base_documents",
        "knowledge_base_entities",
        "knowledge_base_relations",
        "knowledge_base_shares",
        "knowledge_base_share_links",
        "knowledge_base_grants",
        "knowledge_base_index_tasks",
    ):
        await db.execute(text(f"DELETE FROM {table} WHERE kb_id = :kb_id"), {"kb_id": kb_id})

    await db.delete(kb)


async def get_indexing_activity(
    db: AsyncSession, kb_id: str, user_id: str, limit: int = 5,
) -> list:
    """获取最近索引活动（可读即可查看）。"""
    from db.models.knowledge_base_document import KnowledgeBaseDocument

    await require_kb_readable(db, kb_id, user_id)
    stmt = (
        select(KnowledgeBaseDocument)
        .where(KnowledgeBaseDocument.kb_id == kb_id)
        .order_by(KnowledgeBaseDocument.uploaded_at.desc())
        .limit(limit)
    )
    rows = (await db.execute(stmt)).scalars().all()
    return [
        {
            "id": r.id, "name": r.name, "status": r.status,
            "progress": r.progress, "uploaded_at": r.uploaded_at.isoformat(),
        }
        for r in rows
    ]


# 阶段计算统一由 doc_service.compute_stages 提供——此处曾有一份重复实现，
# 两份代码的兜底行为不一致（另一份把「关系抽取」映射到已不存在的阶段索引 6），
# 且无任何调用方，故删除以避免继续漂移。


async def reindex_kb(
    db: AsyncSession,
    kb_id: str,
    user_id: str,
    config: IndexConfigSchema | None = None,
    vector_store: BaseVectorStore | None = None,
    scheduler=None,
) -> dict:
    """保存索引配置并重新索引所有文档。

    1. 更新 KB 配置
    2. 清空向量库集合（保留旧集合直到新建成功）
    3. 重置所有文档为 queued 状态
    4. **提交事务**后重新入队所有文档

    Returns:
        ``{"reindexed": int, "collection_ready": bool}``——调用方负责提交事务；
        入队已完成（入队前已提交，见下）。
    """
    kb = await _get_kb_or_404(db, kb_id, user_id)

    # 预检：重建会**先清空向量与图谱**，因此必须确认所有源文件都还在。
    # 此前不做校验：源文件缺失时（例如换了机器 / 清了上传目录）会先把旧向量
    # 删掉、再在解析阶段逐个失败——数据没了且不可恢复。
    from db.models.knowledge_base_document import KnowledgeBaseDocument

    docs = list(
        (
            await db.execute(
                select(KnowledgeBaseDocument).where(
                    KnowledgeBaseDocument.kb_id == kb_id
                )
            )
        ).scalars().all()
    )
    missing = [d.name for d in docs if not d.storage_path or not os.path.exists(d.storage_path)]
    if missing:
        raise HTTPException(
            status_code=409,
            detail=(
                f"重建已中止：{len(missing)} 个源文件在当前服务器上不存在"
                f"（{', '.join(missing[:3])}{'…' if len(missing) > 3 else ''}）。"
                "请先重新上传这些文档，或确认服务器上的上传目录未被清理。"
                "重建会先清空现有索引，因此在校验通过前不会执行。"
            ),
        )

    # 维度校验（T4.4）：重建是**换 embedding 模型/维度的唯一正确入口**，
    # 因此必须在这里拦住不一致的配置——否则会按错误的维度重建集合，
    # 而清空之后才发现写不进去。
    dim_mismatch = await check_embedding_dim(db, config if config is not None else kb.config)
    if dim_mismatch:
        raise HTTPException(status_code=400, detail=dim_mismatch)

    # Update config if provided
    if config is not None:
        kb.config = config.model_dump()
        kb.updated_at = datetime.utcnow()

    # 建**临时**集合（不换名）：重建期间写入走它，读路径继续指向正式集合——
    # 因此整个重建过程中用户都能检索到**完整**的旧数据，不会经历"库空了"的窗口。
    # 全部文档索引完成后由调度器换名提交（见 IndexingScheduler.maybe_commit_rebuild）。
    # 建失败时旧集合原封不动，如实上报 collection_ready。
    collection_ready = True
    staging_collection: str | None = None
    if vector_store:
        dim = int(
            (config.embedding_dim if config else kb.config.get("embedding_dim")) or 1024
        )
        # 重建正是"改了 BM25 参数后生效"的唯一途径：稀疏索引上的 k1/b 跟着重建更新
        params = _sparse_index_params(config if config is not None else kb.config)
        try:
            if hasattr(vector_store, "stage_collection"):
                staging_collection = await vector_store.stage_collection(
                    kb_id, dim, sparse_params=params,
                )
            else:
                # Chroma 等没有"临时集合 + 换名"机制的实现：退回直接重建
                await vector_store.create_collection(kb_id, dim, sparse_params=params)
        except Exception as e:
            collection_ready = False
            logger.error("重建向量集合失败 kb=%s: %s", kb_id, e)

    # Reset all documents to queued
    from db.models.knowledge_base_document import KnowledgeBaseDocument

    await db.execute(
        update(KnowledgeBaseDocument)
        .where(KnowledgeBaseDocument.kb_id == kb_id)
        .values(
            status="queued", progress=0, error_message=None,
            graph_error=None, indexed_at=None,
            chunks_count=0, entities_count=0, relations_count=0,
        )
    )

    # 清空旧的图谱数据（重建后由抽取阶段重新写入）
    await db.execute(
        text("DELETE FROM knowledge_base_entities WHERE kb_id = :kb_id"), {"kb_id": kb_id}
    )
    await db.execute(
        text("DELETE FROM knowledge_base_relations WHERE kb_id = :kb_id"), {"kb_id": kb_id}
    )

    # docs 已在预检阶段取出（同一事务内，状态未被并发修改）

    kb.status = "indexing"
    kb.chunks_count = 0
    kb.entities_count = 0
    kb.relations_count = 0
    kb.updated_at = datetime.utcnow()

    # **先提交再入队**：进度观察者用独立 session 更新文档行，未提交时会更新到 0 行，
    # 随后还可能被本事务的重置语句覆盖回 queued（进度丢失）。
    await db.commit()

    from api.knowledge_base.doc_service import IndexingTask

    enqueued = 0
    if scheduler:
        for doc in docs:
            await scheduler.enqueue(IndexingTask(
                kb_id=kb_id,
                doc_id=doc.id,
                file_path=doc.storage_path,
                file_type=doc.type,
                config=kb.config,
                target_collection=staging_collection,
            ))
            enqueued += 1
    elif docs:
        logger.warning("reindex 未提供调度器，%d 个文档停留在 queued", len(docs))

    # 空库重建：没有任务完成回调来触发提交，这里直接收口（否则临时集合永远挂着）
    if staging_collection and not docs:
        await vector_store.commit_staged_collection(kb_id)
        collection_ready = True

    logger.info(
        "Reindex kb=%s: %d docs enqueued, collection_ready=%s",
        kb_id, enqueued, collection_ready,
    )
    return {"reindexed": enqueued, "collection_ready": collection_ready}

    return {"kb_id": kb_id, "docs_enqueued": enqueued, "status": "indexing"}


async def resolve_kb_access(
    db: AsyncSession, kb_id: str, user_id: str, role_key: str | None = None,
) -> tuple[KnowledgeBase | None, KBAccess]:
    """解析当前用户对指定知识库的访问级别。

    判定顺序：所有者 → 已接受的分享接收人 → **数据范围内的**公共库 → 无权限。
    知识库不存在时返回 ``(None, KBAccess.NONE)``。

    这里必须与列表用**同一条**公开库判定：列表藏起来、按 id 仍能直接打开的话，
    收敛就只是"看不见"而不是"访问不到"——那不算隔离。
    """
    kb = (
        await db.execute(select(KnowledgeBase).where(KnowledgeBase.id == kb_id))
    ).scalar_one_or_none()
    if kb is None:
        return None, KBAccess.NONE
    if kb.user_id == user_id:
        return kb, KBAccess.OWNER

    # **四路来源各判一次、取最强的一档**：同一用户可能既有只读分享、又落在某条可写
    # 授权里（取"先命中先返回"会让人莫名其妙地只有只读）。各分支都复用上面那几条
    # 共用条件，不另写布尔逻辑——两份实现就是"列表藏起来、按 id 仍能打开"的来源。
    levels: list[KBAccess] = []

    share_permission = await db.scalar(
        select(KnowledgeBaseShare.permission)
        .where(KnowledgeBaseShare.kb_id == kb_id, _accepted_share_condition(user_id))
        .limit(1)
    )
    if share_permission is not None:
        levels.append(_level_for_permission(share_permission))

    grant_branches = await _grant_subject_conditions(db, user_id)
    if grant_branches:
        grant_permission = await db.scalar(
            select(KnowledgeBaseGrant.permission)
            .where(
                KnowledgeBaseGrant.kb_id == kb_id,
                KnowledgeBaseGrant.revoked_at.is_(None),
                or_(*grant_branches),
            )
            .limit(1)
        )
        if grant_permission is not None:
            levels.append(_level_for_permission(grant_permission))

    if kb.visibility == VISIBILITY_PUBLIC:
        # 公开库还要落在数据范围内才算可读（复用同一条条件，避免两套口径）
        in_scope = await db.scalar(
            select(KnowledgeBase.id).where(
                KnowledgeBase.id == kb_id,
                await _public_scope_condition(db, user_id, role_key),
            )
        )
        if in_scope:
            levels.append(KBAccess.PUBLIC)

    if not levels:
        return kb, KBAccess.NONE
    return kb, max(levels, key=access_rank)


async def _get_kb_or_404(db: AsyncSession, kb_id: str, user_id: str) -> KnowledgeBase:
    """获取「本人所有」的知识库或抛出 404——**写路径专用**。

    读路径请改用 ``require_kb_readable``，它会额外放行已接受的分享与公共库。
    """
    kb, access = await resolve_kb_access(db, kb_id, user_id)
    if kb is None or access is not KBAccess.OWNER:
        raise HTTPException(status_code=404, detail="知识库不存在")
    return kb


async def require_kb_readable(
    db: AsyncSession, kb_id: str, user_id: str
) -> tuple[KnowledgeBase, KBAccess]:
    """获取「当前用户可读」的知识库或抛出 404——**读路径专用**。

    返回访问级别，调用方可用它决定是否展示写操作（GRANTEE / PUBLIC 为只读）。
    """
    kb, access = await resolve_kb_access(db, kb_id, user_id)
    if kb is None or access is KBAccess.NONE:
        raise HTTPException(status_code=404, detail="知识库不存在")
    return kb, access


# ─── 组织：置顶 / 手工排序 / 分组 / 复制 / 导出（迭代 6 T6.2）───────────────
#
# 置顶与手工排序是**本人列表视图偏好**，存在库行上（is_pinned/sort_order）是最省事
# 的实现；为免"库主的偏好改变了别人看到的顺序"，排序只在 scope=personal 时生效
# （见 list_kbs），且这些写接口只对库主开放。


async def _update_view_preference(
    db: AsyncSession, kb_ids: list[str], values: dict[str, Any],
) -> None:
    """更新"视图偏好"字段，**不刷新 updated_at**。

    置顶 / 手工顺序 / 归组表达的是"我的列表怎么排"，不是库内容变更。但模型的
    ``updated_at`` 带 ``onupdate=func.now()``，任何一次 UPDATE 都会把它推到当下：
    于是列表里"更新时间"变成今天、"按更新时间排序"的视图被顶到最前，用户会以为
    内容刚被改过。显式把 ``updated_at`` 赋成它自己即可绕过 onupdate。
    """
    if not kb_ids:
        return
    await db.execute(
        update(KnowledgeBase)
        .where(KnowledgeBase.id.in_(kb_ids))
        .values(**values, updated_at=KnowledgeBase.updated_at)
    )


async def _owned_kb_rows(db: AsyncSession, user_id: str) -> list[KnowledgeBase]:
    """本人创建的知识库，按列表的显示顺序取回。"""
    rows = await db.execute(
        select(KnowledgeBase)
        .where(KnowledgeBase.user_id == user_id)
        .order_by(
            KnowledgeBase.is_pinned.desc(),
            KnowledgeBase.sort_order.asc(),
            KnowledgeBase.updated_at.desc(),
        )
    )
    return list(rows.scalars().all())


async def set_kb_pinned(
    db: AsyncSession, kb_id: str, user_id: str, pinned: bool,
) -> KBResponse:
    """置顶 / 取消置顶（仅库主）。"""
    kb = await _get_kb_or_404(db, kb_id, user_id)
    await _update_view_preference(db, [kb.id], {"is_pinned": bool(pinned)})
    await db.refresh(kb)
    return _kb_to_response(kb)


async def move_kb(
    db: AsyncSession, kb_id: str, user_id: str, direction: str,
) -> KBResponse:
    """在列表里上移 / 下移一位。

    **只在同一个置顶分组内交换**：置顶项永远在最前，把一项"下移"穿过置顶边界会
    让它看起来"跳了一大截"。要跨过去就显式切换置顶。

    交换后把该分组的 sort_order 重新编号（0..n-1）：手工顺序值会被反复交换弄乱
    （0/0/0 之类的并列），每次移动顺手归一一次，成本是几条 UPDATE，换来顺序永远
    可预测。
    """
    kb = await _get_kb_or_404(db, kb_id, user_id)
    if direction not in ("up", "down"):
        raise HTTPException(status_code=400, detail="移动方向只能是 up 或 down")

    rows = await _owned_kb_rows(db, user_id)
    group = [r for r in rows if bool(r.is_pinned) == bool(kb.is_pinned)]
    index = next((i for i, r in enumerate(group) if r.id == kb.id), None)
    if index is None:  # 理论上不会发生（kb 就在本人的列表里）
        return _kb_to_response(kb)

    target = index - 1 if direction == "up" else index + 1
    if 0 <= target < len(group):
        group[index], group[target] = group[target], group[index]
        # 每行的新值不同，只能逐行写；条数就是"本人的知识库数"，量级很小
        for order, row in enumerate(group):
            await _update_view_preference(db, [row.id], {"sort_order": order})
        await db.refresh(kb)
    return _kb_to_response(kb)


async def copy_kb(
    db: AsyncSession, kb_id: str, user_id: str, name: str | None = None,
) -> KBResponse:
    """复制知识库——**只复制定义与配置，不复制文档与向量**。

    连文档一起复制意味着重新解析、重新向量化（真金白银的 embedding 调用），
    而且"复制一个 2000 篇的库"会让接口挂住几分钟。要文档就复制完再上传——两步
    动作，但每一步都在用户的预期内。
    """
    from api.knowledge_base.quota import ensure_kb_quota

    source = await _get_kb_or_404(db, kb_id, user_id)
    await ensure_kb_quota(db, user_id)

    base = (name or f"{source.name} 副本").strip() or f"{source.name} 副本"
    taken = {
        row[0] for row in await db.execute(
            select(KnowledgeBase.name).where(KnowledgeBase.user_id == user_id)
        )
    }
    final_name = base
    index = 1
    while final_name in taken:
        index += 1
        final_name = f"{base}({index})"

    now = datetime.utcnow()
    clone = KnowledgeBase(
        name=final_name[:128],
        description=source.description,
        tags=list(source.tags or []),
        config=dict(source.config or {}),
        user_id=user_id,
        status="draft",
        visibility=source.visibility or VISIBILITY_PRIVATE,
        dept_id=source.dept_id,     # 与来源同归属，公开范围判定保持一致
        created_at=now,
        updated_at=now,
    )
    db.add(clone)
    try:
        await db.flush()
    except IntegrityError as exc:   # 与并发复制撞 uq_kb_user_name
        await db.rollback()
        raise HTTPException(
            status_code=409, detail=f"知识库 {final_name} 已存在",
        ) from exc
    return _kb_to_response(clone)


async def export_kb_config(
    db: AsyncSession, kb_id: str, user_id: str,
) -> dict[str, Any]:
    """导出知识库的**定义与配置**（不含文档内容）。

    带 ``format`` 与 ``version``：这份 JSON 迟早会被别处导入（新环境重建、交接、
    排错对照），没有格式标识的话，过半年没人敢确定它是什么。
    """
    kb, access = await resolve_kb_access(db, kb_id, user_id)
    if kb is None or access is KBAccess.NONE:
        raise HTTPException(status_code=404, detail="知识库不存在")

    return {
        "format": "ke-hermes.knowledge-base.config",
        "version": 1,
        "exported_at": datetime.utcnow().isoformat() + "Z",
        "knowledge_base": {
            "name": kb.name,
            "description": kb.description,
            "tags": list(kb.tags or []),
            "visibility": kb.visibility or VISIBILITY_PRIVATE,
            "config": dict(kb.config or {}),
        },
        # 只读的统计信息：导入方对不上时用来判断"导出时是什么状态"
        "stats": {
            "docs_count": kb.docs_count,
            "chunks_count": kb.chunks_count,
            "entities_count": kb.entities_count,
            "relations_count": kb.relations_count,
        },
    }


# ─── 分组 ──────────────────────────────────────────────────────────────────


async def _get_group_or_404(
    db: AsyncSession, user_id: str, group_id: str,
) -> Any:
    """取本人的分组或 404。"""
    from db.models.knowledge_base_group import KnowledgeBaseGroup

    group = (
        await db.execute(
            select(KnowledgeBaseGroup).where(
                KnowledgeBaseGroup.id == group_id,
                KnowledgeBaseGroup.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    if group is None:
        raise HTTPException(status_code=404, detail="分组不存在")
    return group


async def list_groups(db: AsyncSession, user_id: str) -> list[dict[str, Any]]:
    """本人的分组 + 每组的知识库数量。"""
    from db.models.knowledge_base_group import KnowledgeBaseGroup

    rows = await db.execute(
        select(KnowledgeBaseGroup)
        .where(KnowledgeBaseGroup.user_id == user_id)
        .order_by(KnowledgeBaseGroup.sort_order.asc(), KnowledgeBaseGroup.created_at.asc())
    )
    groups = list(rows.scalars().all())
    counts = dict(
        (row[0], row[1]) for row in await db.execute(
            select(KnowledgeBase.group_id, func.count())
            .where(
                KnowledgeBase.user_id == user_id,
                KnowledgeBase.group_id.is_not(None),
            )
            .group_by(KnowledgeBase.group_id)
        )
    )
    return [
        {
            "id": g.id, "name": g.name, "sort_order": g.sort_order,
            "kb_count": counts.get(g.id, 0),
        }
        for g in groups
    ]


async def create_group(db: AsyncSession, user_id: str, name: str) -> dict[str, Any]:
    """新建分组（同一用户下重名 → 409）。"""
    from db.models.knowledge_base_group import KnowledgeBaseGroup

    clean = (name or "").strip()
    if not clean:
        raise HTTPException(status_code=400, detail="分组名不能为空")
    exists = (
        await db.execute(
            select(KnowledgeBaseGroup).where(
                KnowledgeBaseGroup.user_id == user_id,
                KnowledgeBaseGroup.name == clean,
            )
        )
    ).scalar_one_or_none()
    if exists is not None:
        raise HTTPException(status_code=409, detail=f"分组 {clean} 已存在")

    max_order = await db.scalar(
        select(func.coalesce(func.max(KnowledgeBaseGroup.sort_order), -1)).where(
            KnowledgeBaseGroup.user_id == user_id,
        )
    )
    group = KnowledgeBaseGroup(
        user_id=user_id, name=clean[:64], sort_order=int(max_order or 0) + 1,
    )
    db.add(group)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status_code=409, detail=f"分组 {clean} 已存在") from exc
    return {"id": group.id, "name": group.name, "sort_order": group.sort_order, "kb_count": 0}


async def rename_group(
    db: AsyncSession, user_id: str, group_id: str, name: str,
) -> dict[str, Any]:
    """重命名分组。"""
    clean = (name or "").strip()
    if not clean:
        raise HTTPException(status_code=400, detail="分组名不能为空")
    group = await _get_group_or_404(db, user_id, group_id)
    group.name = clean[:64]
    group.updated_at = datetime.utcnow()
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status_code=409, detail=f"分组 {clean} 已存在") from exc
    return {
        "id": group.id, "name": group.name,
        "sort_order": group.sort_order, "kb_count": 0,
    }


async def delete_group(db: AsyncSession, user_id: str, group_id: str) -> None:
    """删除分组——**只解除归属，不删库**。

    库里是用户的数据资产，不能因为整理分组就丢。数据库层有 ON DELETE SET NULL
    兜底，这里显式更新一次是为了在 SQLite（测试）上也成立。
    """
    group = await _get_group_or_404(db, user_id, group_id)
    await db.execute(
        update(KnowledgeBase)
        .where(KnowledgeBase.group_id == group.id)
        .values(group_id=None)
    )
    await db.delete(group)
    await db.flush()


async def assign_kb_group(
    db: AsyncSession, kb_id: str, user_id: str, group_id: str | None,
) -> KBResponse:
    """把知识库归入分组；``group_id=None`` 表示移出分组。"""
    kb = await _get_kb_or_404(db, kb_id, user_id)
    if group_id is not None:
        await _get_group_or_404(db, user_id, group_id)   # 只能归到自己的分组
    await _update_view_preference(db, [kb.id], {"group_id": group_id})
    await db.refresh(kb)
    return _kb_to_response(kb)
