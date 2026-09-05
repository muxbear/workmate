"""知识库模型解析——从“模型”页面配置的提供商中加载 embedding/LLM 模型.""" 

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.rag.embedding import get_embedding_model
from core.security import decrypt_api_key
from db.models.ai_model import AIModel
from db.models.provider import Provider

logger = logging.getLogger(__name__)


async def _load_model_row(
    db: AsyncSession,
    *,
    model_type: str,
    model_name: str | None = None,
    provider_id: str | None = None,
) -> tuple[Any, Any, str] | None:
    """Return the first usable (model, provider, api_key) row from the models page."""
    conditions = [
        AIModel.type == model_type,
        AIModel.status == "active",
    ]
    if model_name:
        conditions.append(AIModel.name == model_name)
    if provider_id:
        conditions.append(AIModel.provider_id == provider_id)

    stmt = (
        select(AIModel, Provider)
        .join(Provider, Provider.id == AIModel.provider_id)
        .where(*conditions)
        .order_by(Provider.sort_order, AIModel.sort_order, AIModel.created_at)
        .limit(50)
    )
    rows = (await db.execute(stmt)).all()
    for model, provider in rows:
        try:
            api_key = decrypt_api_key(provider.api_key)
        except Exception:
            logger.warning("提供商 %s 的 api_key 解密失败，跳过", provider.name)
            continue
        if not api_key:
            logger.warning("提供商 %s 未配置 api_key，跳过", provider.name)
            continue
        return model, provider, api_key
    return None


async def load_embedding_model(
    db: AsyncSession,
    model_name: str | None = None,
    provider_id: str | None = None,
) -> Any:
    """Load the embedding model configured on the models page."""
    row = await _load_model_row(
        db, model_type="embedding", model_name=model_name, provider_id=provider_id
    )
    if row is None:
        raise RuntimeError("知识库未找到可用的 embedding 模型，请在“模型”页面配置 type=embedding 的模型")
    model, provider, api_key = row
    logger.info("知识库使用 embedding 模型 %s（提供商 %s）", model.name, provider.name)
    return get_embedding_model(
        model_name=model.name,
        api_base=provider.api_base,
        api_key=api_key,
    )


async def load_llm_model(
    db: AsyncSession,
    model_name: str | None = None,
    provider_id: str | None = None,
) -> tuple[str, str, str]:
    """Load the LLM config (name, api_base, api_key) configured on the models page."""
    row = await _load_model_row(
        db, model_type="llm", model_name=model_name, provider_id=provider_id
    )
    if row is None:
        raise RuntimeError("知识库未找到可用的 LLM 模型，请在“模型”页面配置 type=llm 的模型")
    model, provider, api_key = row
    logger.info("知识库图谱抽取使用 LLM 模型 %s（提供商 %s）", model.name, provider.name)
    return model.name, provider.api_base, api_key
