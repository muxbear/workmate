"""知识库业务逻辑——CRUD + 统计 + 访问权限解析。"""

from __future__ import annotations

import logging
from datetime import datetime
from enum import StrEnum
from typing import TYPE_CHECKING

from fastapi import HTTPException
from sqlalchemy import func, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

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

STAGE_NAMES = ["排队", "解析", "切片", "向量化", "BM25 倒排", "实体抽取", "关系抽取", "入库"]

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


def _readable_condition(user_id: str):
    """构造「当前用户可读」的 SQL 条件（自己 ∪ 已接受分享 ∪ 公共库）。

    所有放宽可见性的查询都必须复用本函数，避免各处自行拼条件导致越权。
    """
    return or_(
        KnowledgeBase.user_id == user_id,
        KnowledgeBase.visibility == VISIBILITY_PUBLIC,
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
) -> KBListResponse:
    """获取知识库列表（分页 + 模糊搜索 + 可见范围过滤）。

    scope 取值见 ``SCOPE_*`` 常量；默认 ``personal`` 保持历史行为（只返回本人创建）。
    """
    page = max(1, page)
    page_size = max(1, min(page_size, 100))
    offset = (page - 1) * page_size

    if scope == SCOPE_PUBLIC:
        # 公共库：只展示别人的（自己的公共库已归入「个人知识库」）
        scope_condition = KnowledgeBase.visibility == VISIBILITY_PUBLIC
    elif scope == SCOPE_SHARED_WITH_ME:
        scope_condition = KnowledgeBase.id.in_(
            select(KnowledgeBaseShare.kb_id).where(
                KnowledgeBaseShare.grantee_id == user_id,
                KnowledgeBaseShare.status == SHARE_STATUS_ACCEPTED,
            )
        )
    elif scope == SCOPE_ALL:
        scope_condition = _readable_condition(user_id)
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
) -> KBStatsResponse:
    """获取知识库统计信息（默认只统计本人创建，scope=all 时统计全部可见库）。"""
    scope_condition = (
        _readable_condition(user_id)
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

    kb = KnowledgeBase(
        name=req.name,
        description=req.description,
        tags=req.tags,
        config=req.config.model_dump(),
        user_id=user_id,
        status="draft",
        visibility=req.visibility or VISIBILITY_PRIVATE,
    )
    db.add(kb)
    await db.flush()

    # Create vector DB collection
    if vector_store:
        dim = req.config.embedding_dim
        try:
            await vector_store.create_collection(kb.id, dim)
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
    await db.flush()
    return _kb_to_response(kb)


async def delete_kb(
    db: AsyncSession,
    kb_id: str,
    user_id: str,
    vector_store: BaseVectorStore | None = None,
    mediator: KnowledgeBaseMediator | None = None,
) -> None:
    """删除知识库——级联删除文档、实体、关系和向量数据。"""
    kb = await _get_kb_or_404(db, kb_id, user_id)

    # 向量库清理（优先使用中介者）
    if mediator:
        await mediator.on_knowledge_base_deleted(kb_id)
    elif vector_store:
        try:
            await vector_store.delete_collection(kb_id)
        except Exception as e:
            logger.error("Failed to delete vector collection kb=%s: %s", kb_id, e)

    # Delete related records
    for table in ["knowledge_base_documents", "knowledge_base_entities", "knowledge_base_relations"]:
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
    2. 清空向量库集合
    3. 重置所有文档为 queued 状态
    4. 重新入队所有文档
    """
    kb = await _get_kb_or_404(db, kb_id, user_id)

    # Update config if provided
    if config is not None:
        kb.config = config.model_dump()
        kb.updated_at = datetime.utcnow()

    # Recreate vector collection
    if vector_store:
        try:
            await vector_store.delete_collection(kb_id)
        except Exception as e:
            logger.warning("Failed to delete vector collection for reindex kb=%s: %s", kb_id, e)
        try:
            dim = (config.embedding_dim if config else kb.config.get("embedding_dim", 1024))
            await vector_store.create_collection(kb_id, dim)
        except Exception as e:
            logger.error("Failed to create vector collection for reindex kb=%s: %s", kb_id, e)

    # Reset all documents to queued
    from db.models.knowledge_base_document import KnowledgeBaseDocument

    await db.execute(
        update(KnowledgeBaseDocument)
        .where(KnowledgeBaseDocument.kb_id == kb_id)
        .values(status="queued", progress=0, error_message=None, indexed_at=None)
    )

    # Re-enqueue all documents
    docs = (
        await db.execute(
            select(KnowledgeBaseDocument)
            .where(KnowledgeBaseDocument.kb_id == kb_id)
        )
    ).scalars().all()

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
            ))
            enqueued += 1

    # Reset KB counters and set status to indexing
    kb.status = "indexing"
    kb.chunks_count = 0
    kb.entities_count = 0
    kb.relations_count = 0
    kb.updated_at = datetime.utcnow()

    logger.info(
        "Reindex kb=%s: %d docs enqueued, config updated", kb_id, enqueued
    )

    return {"kb_id": kb_id, "docs_enqueued": enqueued, "status": "indexing"}


async def resolve_kb_access(
    db: AsyncSession, kb_id: str, user_id: str
) -> tuple[KnowledgeBase | None, KBAccess]:
    """解析当前用户对指定知识库的访问级别。

    判定顺序：所有者 → 已接受的分享接收人 → 公共库 → 无权限。
    知识库不存在时返回 ``(None, KBAccess.NONE)``。
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
