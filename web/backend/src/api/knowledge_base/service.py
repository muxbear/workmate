"""知识库业务逻辑——CRUD + 统计 + 访问权限解析。"""

from __future__ import annotations

import logging
import os
import shutil
from datetime import datetime
from enum import StrEnum
from typing import TYPE_CHECKING

from fastapi import HTTPException
from sqlalchemy import and_, false, func, or_, select, text, update
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
    """当前用户对某知识库的访问级别。"""

    OWNER = "owner"        # 自己创建：可读写
    GRANTEE = "grantee"    # 已接受的分享：只读
    PUBLIC = "public"      # 公共库：只读
    NONE = "none"          # 无权限


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


async def _readable_condition(
    db: AsyncSession, user_id: str, role_key: str | None = None,
):
    """构造「当前用户可读」的 SQL 条件。

    三个来源：**自己创建的 ∪ 已接受分享的 ∪ 部门范围内公开的**。

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
        KnowledgeBase.id.in_(
            select(KnowledgeBaseShare.kb_id).where(
                KnowledgeBaseShare.grantee_id == user_id,
                KnowledgeBaseShare.status == SHARE_STATUS_ACCEPTED,
            )
        ),
    )


def _like_pattern(search: str) -> str:
    """把用户输入转成安全的 LIKE 模式串（转义 ``%`` / ``_`` / ``\\``）。

    配合 ``ilike(pattern, escape="\\\\")`` 使用：用户搜索 "a_b" 时应当只匹配字面
    下划线，而不是把它当成单字符通配符。
    """
    escaped = (
        search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    )
    return f"%{escaped}%"


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
) -> KBResponse:
    """ORM 模型 → 响应对象。

    ``viewer_id`` 用于标记 ``is_owner``——前端据此切换到只读态；
    为空时按所有者视角处理（创建/更新的返回值）。
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
        is_owner=viewer_id is None or kb.user_id == viewer_id,
        owner_name=owner_name,
    )


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
) -> KBListResponse:
    """获取知识库列表（分页 + 模糊搜索 + 可见范围过滤）。

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
        scope_condition = KnowledgeBase.id.in_(
            select(KnowledgeBaseShare.kb_id).where(
                KnowledgeBaseShare.grantee_id == user_id,
                KnowledgeBaseShare.status == SHARE_STATUS_ACCEPTED,
            )
        )
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

    # Total count
    total_stmt = select(func.count()).select_from(KnowledgeBase).where(*conditions)
    total = (await db.execute(total_stmt)).scalar() or 0

    # Items
    stmt = (
        select(KnowledgeBase)
        .where(*conditions)
        .order_by(KnowledgeBase.updated_at.desc())
        .offset(offset)
        .limit(page_size)
    )
    rows = (await db.execute(stmt)).scalars().all()

    owner_names = await _load_owner_names(db, [r.user_id for r in rows])

    return KBListResponse(
        items=[
            _kb_to_response(r, viewer_id=user_id, owner_name=owner_names.get(r.user_id))
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
    kb, _access = await require_kb_readable(db, kb_id, user_id)
    owner_names = await _load_owner_names(db, [kb.user_id])
    return _kb_to_response(
        kb, viewer_id=user_id, owner_name=owner_names.get(kb.user_id)
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

    # 子表：软删除期间保留了这些行，彻底删除时一并清掉
    for table in (
        "knowledge_base_documents",
        "knowledge_base_entities",
        "knowledge_base_relations",
        "knowledge_base_shares",
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
    share = (
        await db.execute(
            select(KnowledgeBaseShare).where(
                KnowledgeBaseShare.kb_id == kb_id,
                KnowledgeBaseShare.grantee_id == user_id,
                KnowledgeBaseShare.status == SHARE_STATUS_ACCEPTED,
            )
        )
    ).scalar_one_or_none()
    if share is not None:
        return kb, KBAccess.GRANTEE
    if kb.visibility == VISIBILITY_PUBLIC:
        # 公开库还要落在数据范围内才算可读（复用同一条条件，避免两套口径）
        in_scope = await db.scalar(
            select(KnowledgeBase.id).where(
                KnowledgeBase.id == kb_id,
                await _public_scope_condition(db, user_id, role_key),
            )
        )
        if in_scope:
            return kb, KBAccess.PUBLIC
    return kb, KBAccess.NONE


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
