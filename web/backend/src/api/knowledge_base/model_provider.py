"""知识库模型解析——从“模型”页面配置的提供商中加载 embedding/LLM 模型."""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from core.rag.embedding import get_embedding_model
from core.rag.reranker import RerankerClient
from db.model_lookup import select_usable_models

logger = logging.getLogger(__name__)


async def _load_model_row(
    db: AsyncSession,
    *,
    model_type: str,
    model_name: str | None = None,
    provider_id: str | None = None,
) -> tuple[Any, Any, str] | None:
    """Return the first usable (model, provider, api_key) row from the models page."""
    # 不要限制 limit=1：不可用候选由 select_usable_models 在 Python 侧跳过，
    # 只取 1 行会让「跳过缺密钥的提供商」失效。
    rows = await select_usable_models(
        db,
        types=(model_type,),
        model_name=model_name,
        provider_id=provider_id,
    )
    return rows[0] if rows else None


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


async def load_embedding_model_for_kb(
    db: AsyncSession, kb_id: str, fallback: Any = None,
) -> Any:
    """按知识库自身配置加载 embedding 模型，用于切片编辑等写入场景。

    必须使用知识库配置的模型：用错模型会产生与既有向量不同维度/不同语义空间的
    向量，导致后续检索召回失真甚至写入失败。

    Args:
        db: 数据库会话。
        kb_id: 知识库 ID。
        fallback: 知识库未配置或模型不可用时返回的默认实例。

    Returns:
        embedding 模型实例（或 ``fallback``）。
    """
    from sqlalchemy import select

    from db.models.knowledge_base import KnowledgeBase

    kb = (
        await db.execute(select(KnowledgeBase).where(KnowledgeBase.id == kb_id))
    ).scalar_one_or_none()
    config = dict(kb.config) if kb and isinstance(kb.config, dict) else {}
    model_name = config.get("embedding_model")
    if not model_name:
        return fallback

    try:
        return await load_embedding_model(
            db, model_name=model_name, provider_id=config.get("embedding_provider_id"),
        )
    except RuntimeError:
        logger.warning(
            "知识库 %s 配置的 embedding 模型 %s 不可用，回退默认实例", kb_id, model_name,
        )
        return fallback


async def load_reranker_model(
    db: AsyncSession,
    model_name: str | None = None,
    provider_id: str | None = None,
) -> Any:
    """加载知识库配置的 reranker 模型（type=rerank）。

    Raises:
        RuntimeError: 模型页未配置可用的 rerank 模型。
    """
    row = await _load_model_row(
        db, model_type="rerank", model_name=model_name, provider_id=provider_id
    )
    if row is None:
        raise RuntimeError(
            "知识库未找到可用的 reranker 模型，请在“模型”页面配置 type=rerank 的模型"
        )
    model, provider, api_key = row
    logger.info("知识库重排序使用模型 %s（提供商 %s）", model.name, provider.name)
    return RerankerClient(
        model=model.name,
        api_base=provider.api_base,
        api_key=api_key,
    )
