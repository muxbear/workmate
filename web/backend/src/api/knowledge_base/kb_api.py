"""知识库 API 路由——CRUD + 概览统计。"""

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user_id, get_db
from api.knowledge_base.schemas import (
    IndexConfigSchema,
    KBAssignGroupRequest,
    KBCopyRequest,
    KBCreateRequest,
    KBMoveRequest,
    KBPinRequest,
    KBUpdateRequest,
)
from api.knowledge_base.service import (
    SCOPE_PERSONAL,
    _get_kb_or_404,
    assign_kb_group,
    copy_kb,
    create_kb,
    delete_kb,
    export_kb_config,
    get_indexing_activity,
    get_kb,
    get_kb_stats,
    list_kbs,
    move_kb,
    purge_kb,
    reindex_kb,
    restore_kb,
    set_kb_pinned,
    update_kb,
)
from api.rbac.deps import RequirePermission
from core.audit import audit_scope
from core.decorators import handle_errors
from core.response import ok

router = APIRouter(prefix="/api/knowledge-bases", tags=["知识库"])


def _get_vector_store(request: Request):
    """从 app state 获取向量数据库实例。"""
    return getattr(request.app.state, "vector_store", None)


def _get_mediator(request: Request):
    """从 app state 获取知识库中介者。"""
    return getattr(request.app.state, "kb_mediator", None)


@router.get("")
@handle_errors
async def list_knowledge_bases(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=12, ge=1, le=100),
    search: str | None = Query(default=None),
    tag: str | None = Query(default=None, description="按标签筛选（精确匹配某一个标签）"),
    group_id: str | None = Query(default=None, description="按自定义分组筛选"),
    scope: str = Query(
        default=SCOPE_PERSONAL,
        description="personal 我创建的 | public 公共库 | shared_with_me 分享给我 | all 全部可见",
    ),
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user_id),
):
    """获取知识库列表（分页 + 模糊搜索 + 可见范围过滤）。"""
    result = await list_kbs(
        db, user_id, page=page, page_size=page_size, search=search, scope=scope,
        tag=tag, group_id=group_id,
    )
    return ok(result)


@router.get("/stats")
@handle_errors
async def get_stats(
    scope: str = Query(
        default=SCOPE_PERSONAL,
        description="personal 仅本人 | all 全部可见（概览用）",
    ),
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user_id),
):
    """获取知识库统计信息。"""
    result = await get_kb_stats(db, user_id, scope=scope)
    return ok(result)


@router.get("/available-models")
@handle_errors
async def get_available_models(
    model_type: str = "llm",
    provider_id: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    _user_id: str = Depends(get_current_user_id),
):
    """获取可用于知识库的模型列表，可按 provider 筛选。

    model_type: llm（实体/关系抽取）或 embedding（向量化）
    provider_id: 指定则只返回该提供商下的模型
    """
    from sqlalchemy import select

    from db.models.ai_model import AIModel

    conditions = [
        AIModel.type == model_type,
        AIModel.status == "active",
    ]
    if provider_id:
        conditions.append(AIModel.provider_id == provider_id)

    stmt = select(AIModel).where(*conditions)
    rows = (await db.execute(stmt)).scalars().all()

    models = [
        {
            "id": m.id,
            "name": m.name,
            "display_name": m.display_name,
            "type": m.type,
            "provider_id": m.provider_id,
        }
        for m in rows
    ]
    return ok(models)


@router.get("/available-providers")
@handle_errors
async def get_available_providers(
    model_type: str = Query(default="llm"),
    db: AsyncSession = Depends(get_db),
    _user_id: str = Depends(get_current_user_id),
):
    """获取拥有指定类型模型的提供商列表。

    model_type: llm（实体/关系抽取）或 embedding（向量化）
    返回的每个 provider 带有一个简化的 models 列表。
    """
    from sqlalchemy import select

    from db.models.ai_model import AIModel
    from db.models.provider import Provider

    # 找出有该类活跃模型的 provider_id
    sub_stmt = select(AIModel.provider_id).where(
        AIModel.type == model_type,
        AIModel.status == "active",
    ).distinct()
    provider_ids = (await db.execute(sub_stmt)).scalars().all()

    if not provider_ids:
        return ok([])

    # 查出这些 provider
    prov_stmt = select(Provider).where(Provider.id.in_(provider_ids))
    providers = (await db.execute(prov_stmt)).scalars().all()

    # 查出这些 provider 下所有该类活跃模型
    model_stmt = select(AIModel).where(
        AIModel.provider_id.in_(provider_ids),
        AIModel.type == model_type,
        AIModel.status == "active",
    )
    models = (await db.execute(model_stmt)).scalars().all()

    # 按 provider_id 分组
    models_by_provider: dict[str, list[dict]] = {}
    for m in models:
        models_by_provider.setdefault(m.provider_id, []).append({
            "id": m.id,
            "name": m.name,
            "display_name": m.display_name,
            "type": m.type,
        })

    result = [
        {
            "id": p.id,
            "name": p.name,
            "logo": p.logo,
            "models": models_by_provider.get(p.id, []),
        }
        for p in providers
    ]
    return ok(result)


@router.post("", status_code=201)
@handle_errors
async def create_knowledge_base(
    body: KBCreateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(RequirePermission("knowledge:create")),
):
    """创建知识库。"""
    vector_store = _get_vector_store(request)
    async with audit_scope("knowledge.create", user_id, request) as entry:
        result = await create_kb(db, user_id, body, vector_store)
        await db.commit()
        # 审计写在业务提交之后：失败时不会留下"记了成功但事务回滚"的假记录
        entry.target = result.id
        entry.detail["name"] = result.name
    return ok(result)


@router.get("/{kb_id}")
@handle_errors
async def get_knowledge_base(
    kb_id: str,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user_id),
):
    """获取知识库详情。"""
    result = await get_kb(db, kb_id, user_id)
    return ok(result)


@router.put("/{kb_id}")
@handle_errors
async def update_knowledge_base(
    kb_id: str,
    body: KBUpdateRequest,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(RequirePermission("knowledge:edit")),
):
    """更新知识库。"""
    async with audit_scope("knowledge.update", user_id, None, target=kb_id):
        result = await update_kb(db, kb_id, user_id, body)
        await db.commit()
    return ok(result)


@router.post("/{kb_id}/pin")
@handle_errors
async def pin_knowledge_base(
    kb_id: str,
    body: KBPinRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(RequirePermission("knowledge:edit")),
):
    """置顶 / 取消置顶（只影响本人的列表顺序）。"""
    async with audit_scope("knowledge.pin", user_id, request, target=kb_id) as entry:
        result = await set_kb_pinned(db, kb_id, user_id, body.pinned)
        await db.commit()
        entry.detail["pinned"] = body.pinned
    return ok(result)


@router.post("/{kb_id}/move")
@handle_errors
async def move_knowledge_base(
    kb_id: str,
    body: KBMoveRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(RequirePermission("knowledge:edit")),
):
    """在列表里上移 / 下移一位（只在同一置顶分组内交换）。"""
    async with audit_scope("knowledge.move", user_id, request, target=kb_id) as entry:
        result = await move_kb(db, kb_id, user_id, body.direction)
        await db.commit()
        entry.detail["direction"] = body.direction
    return ok(result)


@router.post("/{kb_id}/copy", status_code=201)
@handle_errors
async def copy_knowledge_base(
    kb_id: str,
    body: KBCopyRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    # 复制会**新建**一个知识库，用建库权限
    user_id: str = Depends(RequirePermission("knowledge:create")),
):
    """复制知识库（只复制定义与配置，不复制文档与向量）。"""
    async with audit_scope("knowledge.copy", user_id, request, target=kb_id) as entry:
        result = await copy_kb(db, kb_id, user_id, body.name)
        await db.commit()
        entry.detail["new_kb_id"] = result.id
        entry.detail["name"] = result.name
    return ok(result)


@router.put("/{kb_id}/group")
@handle_errors
async def assign_knowledge_base_group(
    kb_id: str,
    body: KBAssignGroupRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(RequirePermission("knowledge:edit")),
):
    """把知识库归入分组（``group_id=null`` 表示移出分组）。"""
    async with audit_scope("knowledge.assign_group", user_id, request, target=kb_id) as entry:
        result = await assign_kb_group(db, kb_id, user_id, body.group_id)
        await db.commit()
        entry.detail["group_id"] = body.group_id
    return ok(result)


@router.get("/{kb_id}/export")
@handle_errors
async def export_knowledge_base(
    kb_id: str,
    db: AsyncSession = Depends(get_db),
    # 导出的是配置与元信息（**不含文档内容**），给读权限就够——能看这个库的人
    # 本来就看得见这些字段
    user_id: str = Depends(get_current_user_id),
):
    """导出知识库的定义与配置（JSON）。

    返回 JSON 而不是直接下发文件：下载由前端生成（与文档下载同样的取舍——
    JWT 在请求头里，`<a href>` 带不上）。
    """
    return ok(await export_kb_config(db, kb_id, user_id))


@router.delete("/{kb_id}")
@handle_errors
async def delete_knowledge_base(
    kb_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(RequirePermission("knowledge:delete")),
):
    """删除知识库（同时取消在跑的索引任务、清理磁盘文件与分享记录）。"""
    from api.knowledge_base.doc_service import IndexingScheduler

    vector_store = _get_vector_store(request)
    mediator = _get_mediator(request)
    async with audit_scope("knowledge.delete", user_id, request, target=kb_id) as entry:
        entry.detail["kb_name"] = (
            await _get_kb_or_404(db, kb_id, user_id)
        ).name
        await delete_kb(
            db, kb_id, user_id, vector_store,
            mediator=mediator, scheduler=IndexingScheduler.instance(),
        )
        await db.commit()
    return ok(None)


@router.post("/{kb_id}/restore")
@handle_errors
async def restore_knowledge_base(
    kb_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(RequirePermission("knowledge:delete")),
):
    """恢复被删除的知识库（软删除后的反悔入口）。"""
    async with audit_scope("knowledge.restore", user_id, request, target=kb_id):
        await restore_kb(db, kb_id, user_id)
        await db.commit()
    return ok(None)


@router.post("/{kb_id}/purge")
@handle_errors
async def purge_knowledge_base(
    kb_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(RequirePermission("knowledge:delete")),
):
    """**彻底删除**知识库（清向量与磁盘，不可恢复）。

    与 `DELETE`（软删除）分开：软删除让误删可恢复，但需要一个显式动作释放空间，
    否则被删的库会永远占着向量集合与磁盘文件。
    """
    vector_store = _get_vector_store(request)
    mediator = _get_mediator(request)
    async with audit_scope("knowledge.purge", user_id, request, target=kb_id):
        await purge_kb(db, kb_id, user_id, vector_store, mediator)
        await db.commit()
    return ok(None)


@router.get("/{kb_id}/indexing-activity")
@handle_errors
async def get_index_activity(
    kb_id: str,
    limit: int = Query(default=5, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user_id),
):
    """获取最近索引活动。"""
    result = await get_indexing_activity(db, kb_id, user_id, limit)
    return ok(result)


@router.post("/{kb_id}/reindex")
@handle_errors
async def reindex_knowledge_base(
    kb_id: str,
    request: Request,
    body: IndexConfigSchema,
    db: AsyncSession = Depends(get_db),
    # 重建会按新配置重切全部切片：属于"改库"而不是"改某篇文档"
    user_id: str = Depends(RequirePermission("knowledge:edit")),
):
    """保存索引配置并重新索引知识库中的所有文档。

    事务与入队顺序由 ``reindex_kb`` 内部保证（先提交、后入队），此处不再重复提交。
    """
    vector_store = _get_vector_store(request)

    from api.knowledge_base.doc_service import IndexingScheduler
    scheduler = IndexingScheduler.instance()

    async with audit_scope("knowledge.reindex", user_id, request, target=kb_id):
        result = await reindex_kb(
            db, kb_id, user_id,
            config=body,
            vector_store=vector_store,
            scheduler=scheduler,
        )
    return ok(result)
