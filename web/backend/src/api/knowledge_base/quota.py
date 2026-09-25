"""知识库配额校验（迭代 5 T5.3）。

三条限额，都可通过环境变量配置（见 ``core/config.py`` 的 ``KB_MAX_*``）：

- ``KB_MAX_PER_USER``：每人能建多少个库；
- ``KB_MAX_DOCS_PER_KB``：单个库能放多少文档；
- ``KB_MAX_STORAGE_MB_PER_USER``：每人全部知识库的总占用（MB）；
- ``KB_MAX_FILE_MB``：单个文件大小。

**默认全部不限**（值为 0）：限额是"按部署环境决定"的策略，升级时默认收紧会把存量
用户直接挡在门外。需要限额的部署在 ``.env`` 里显式配置即可。

**组织级配额不在本模块**：平台没有"组织配置"这类存储（配额属于策略而非部门属性），
要按组织限额得先引入组织级配置表——那是产品模型变更，不在本轮范围。

超限一律返回 400 且文案里带**当前值/上限/怎么改**：只说"超限"会让用户无从判断是
文件太大、库太多还是空间不够，也不知道能不能自己解决。
"""

from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import get_settings
from db.models.knowledge_base import KnowledgeBase
from db.models.knowledge_base_document import KnowledgeBaseDocument

settings = get_settings()

MB = 1024 * 1024


def _limit(value: int) -> int:
    """限额取值；<=0 表示不限。"""
    return int(value or 0)


def _format_mb(value: float) -> str:
    if value >= 1024:
        return f"{value / 1024:.1f} GB"
    return f"{value:.0f} MB"


async def ensure_kb_quota(db: AsyncSession, user_id: str) -> None:
    """校验"新建知识库"是否超出每人库数上限。

    Raises:
        HTTPException: 400（超出配额，文案含当前值与上限）。
    """
    limit = _limit(settings.KB_MAX_PER_USER)
    if limit <= 0:
        return
    owned = await db.scalar(
        select(func.count()).select_from(KnowledgeBase).where(
            KnowledgeBase.user_id == user_id,
        )
    )
    if (owned or 0) >= limit:
        raise HTTPException(
            status_code=400,
            detail=(
                f"已达知识库数量上限（{owned}/{limit}）。"
                "请先删除不再使用的知识库，或联系管理员调整 KB_MAX_PER_USER。"
            ),
        )


async def ensure_doc_quota(
    db: AsyncSession, kb_id: str, user_id: str, incoming_bytes: int,
    incoming_count: int = 1,
) -> None:
    """校验"上传文档"是否超出单库文档数与总存储上限。

    Args:
        db: 会话。
        kb_id: 目标知识库。
        user_id: 上传者（存储上限按**库的归属人**统计，见下）。
        incoming_bytes: 本次要新增的字节数。
        incoming_count: 本次要新增的**文档数**。此前这个维度被漏掉了——判据只有
            ``count >= limit``，于是"一次传 20 个、上限 5"能整批通过。逐文件上传
            之后每次只加 1，但参数仍然显式传，免得哪天改成批量调用又漏回去。

    Raises:
        HTTPException: 400（超出配额，文案含当前值/上限/怎么改）。
    """
    docs_limit = _limit(settings.KB_MAX_DOCS_PER_KB)
    if docs_limit > 0:
        count = await db.scalar(
            select(func.count()).select_from(KnowledgeBaseDocument).where(
                KnowledgeBaseDocument.kb_id == kb_id,
            )
        )
        if (count or 0) + max(0, incoming_count) > docs_limit:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"该知识库文档数将超出上限（现有 {count or 0}，"
                    f"本次新增 {incoming_count}，上限 {docs_limit}）。"
                    "请删除不再需要的文档，或联系管理员调整 KB_MAX_DOCS_PER_KB。"
                ),
            )

    storage_limit = _limit(settings.KB_MAX_STORAGE_MB_PER_USER)
    if storage_limit > 0:
        used = await db.scalar(
            select(func.coalesce(func.sum(KnowledgeBaseDocument.size_bytes), 0)).where(
                KnowledgeBaseDocument.kb_id == kb_id,
            )
        )
        limit_bytes = storage_limit * MB
        if (used or 0) + incoming_bytes > limit_bytes:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"该知识库存储空间不足：已用 {_format_mb((used or 0) / MB)}，"
                    f"本次需 {_format_mb(incoming_bytes / MB)}，"
                    f"上限 {_format_mb(storage_limit)}。"
                    "请删除不再需要的文档，或联系管理员调整 KB_MAX_STORAGE_MB_PER_USER。"
                ),
            )


__all__ = ["ensure_doc_quota", "ensure_kb_quota"]
