"""知识库模型解析——从“模型”页面配置的提供商中加载 embedding/LLM 模型."""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from core.rag.embedding import get_embedding_model
from core.rag.reranker import RerankerClient
from core.rag.vision import VisionClient
from db.model_lookup import effective_api_base, select_usable_models

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
        api_base=effective_api_base(model, provider),
        api_key=api_key,
    )


async def resolve_embedding_dim(
    db: AsyncSession,
    model_name: str | None = None,
    provider_id: str | None = None,
) -> int | None:
    """解析 embedding 模型的**真实**向量维度。

    模型页可以显式填 ``dim``；没填时**首次调用探测一次并落库**——与其让用户在配置
    页手填一个从文档里翻出来的数字（填错要到写入向量库才炸，且报错与原因无关），
    不如问一次 API。

    Returns:
        维度；模型不可用或探测失败时返回 ``None``（调用方决定是拒绝还是放行）。

    Raises:
        RuntimeError: 模型页没有可用的 embedding 模型。
    """
    row = await _load_model_row(
        db, model_type="embedding", model_name=model_name, provider_id=provider_id
    )
    if row is None:
        raise RuntimeError("知识库未找到可用的 embedding 模型，请在“模型”页面配置 type=embedding 的模型")
    model, _provider, _api_key = row

    declared = getattr(model, "dim", None)
    if isinstance(declared, int) and declared > 0:
        return declared

    probed = await _probe_embedding_dim(db, model, model_name, provider_id)
    if probed is not None:
        try:
            model.dim = probed
            await db.commit()
            logger.info("已探测并记录 embedding 模型 %s 的维度：%d", model.name, probed)
        except Exception:  # noqa: BLE001 - 落库失败不影响本次使用
            await db.rollback()
            logger.warning("写入 embedding 模型维度失败（不影响本次调用）", exc_info=True)
    return probed


def config_value(config: object, *keys: str) -> Any:
    """从知识库配置里取值——对象（IndexConfigSchema）与 dict 两种形态都要认。"""
    for key in keys:
        if isinstance(config, dict):
            value = config.get(key)
        elif config is not None:
            value = getattr(config, key, None)
        else:
            value = None
        if value is not None:
            return value
    return None


async def check_embedding_dim(db: AsyncSession, config: object) -> str | None:
    """校验配置里的 embedding 维度与模型**真实输出**维度是否一致。

    此前维度完全靠用户手填且无处校验：填成 768 而模型输出 1024 时，建集合会按
    768 建，直到第一片向量写进去才报错——错误信息是向量库的维度断言，与"配置页
    填错了"这个真正的原因毫无关系。同一个 collection 里混入不同语义空间的向量
    也可以悄无声息地发生（文档级 config 覆盖模型）。

    Returns:
        不一致时返回**可直接展示给用户**的说明；一致或无法确定时返回 ``None``
        （模型不可用/探测失败时放行——不能因为探测不了就把功能锁死）。
    """
    configured = config_value(config, "embedding_dim", "embeddingDim")
    if not isinstance(configured, (int, float)) or configured <= 0:
        return None

    model_name = config_value(config, "embedding_model", "embeddingModel")
    provider_id = config_value(config, "embedding_provider_id", "embeddingProviderId")
    try:
        actual = await resolve_embedding_dim(
            db, model_name=model_name, provider_id=provider_id,
        )
    except RuntimeError:
        return None
    if actual is None or int(configured) == actual:
        return None

    return (
        f"embedding 维度不一致：知识库配置为 {int(configured)} 维，"
        f"但模型「{model_name or '默认 embedding 模型'}」实际输出 {actual} 维。"
        f"请把索引配置的维度改成 {actual} 后重建索引——"
        "维度不一致会让写入失败，或让库内混入不同语义空间的向量导致检索失真。"
    )


async def _probe_embedding_dim(
    db: AsyncSession,
    model: Any,
    model_name: str | None,
    provider_id: str | None,
) -> int | None:
    """调用一次 embedding 接口，用返回向量的长度确定维度。"""
    try:
        instance = await load_embedding_model(
            db, model_name=model_name, provider_id=provider_id,
        )
        vector = await instance.aembed_query("dimension probe")
    except Exception:  # noqa: BLE001 - 探测失败不该让调用方直接崩
        logger.warning("探测 embedding 维度失败：%s", model.name, exc_info=True)
        return None
    return len(vector) if vector else None


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
    return model.name, effective_api_base(model, provider), api_key


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
        api_base=effective_api_base(model, provider),
        api_key=api_key,
    )


async def load_vision_model(
    db: AsyncSession,
    model_name: str | None = None,
    provider_id: str | None = None,
) -> VisionClient:
    """加载知识库配置的视觉模型（type=vision），用于 OCR 与图片说明。

    ``model_name`` 留空时按模型页顺序取第一个可用的 ``vision`` 模型——与
    :func:`load_reranker_model` 同一套兜底逻辑（``select_usable_models`` 已负责跳过
    缺 api_base、密钥解不开的提供商）。

    Raises:
        RuntimeError: 模型页未配置可用的 vision 模型。
    """
    row = await _load_model_row(
        db, model_type="vision", model_name=model_name, provider_id=provider_id
    )
    if row is None:
        raise RuntimeError(
            "知识库未找到可用的视觉模型，请在“模型”页面配置 type=vision 的模型（用于 OCR）"
        )
    model, provider, api_key = row
    logger.info("知识库 OCR 使用视觉模型 %s（提供商 %s）", model.name, provider.name)
    return VisionClient(
        model=model.name,
        api_base=effective_api_base(model, provider),
        api_key=api_key,
    )
