"""构建桌面端模型同步快照."""

import logging
import time

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.model_sync.schemas import (
    ModelSyncModel,
    ModelSyncPlan,
    ModelSyncProvider,
    ModelSyncResponse,
)
from core.security import decrypt_api_key
from db.models.ai_model import AIModel
from db.models.provider import Provider

logger = logging.getLogger(__name__)

MODELS_FILE_VERSION = 1
SYNCABLE_MODEL_TYPES = {'llm', 'vision', 'multimodal'}
SKIPPED_MODEL_STATUSES = {'deprecated', 'inactive'}


def _supports_tool_call(model_type: str) -> bool:
    return model_type in {'llm', 'multimodal'}


def _supports_images(model_type: str) -> bool:
    return model_type in {'vision', 'multimodal'}


async def build_model_sync_payload(db: AsyncSession) -> ModelSyncResponse:
    """构建桌面端模型同步快照."""
    providers_result = await db.execute(
        select(Provider).order_by(Provider.sort_order, Provider.created_at)
    )
    providers = list(providers_result.scalars().all())

    models_by_provider: dict[str, list[AIModel]] = {p.id: [] for p in providers}
    if providers:
        models_result = await db.execute(
            select(AIModel)
            .where(AIModel.provider_id.in_(list(models_by_provider.keys())))
            .order_by(AIModel.created_at)
        )
        for model in models_result.scalars().all():
            models_by_provider.setdefault(model.provider_id, []).append(model)

    provider_records: list[ModelSyncProvider] = []
    model_records: list[ModelSyncModel] = []
    seen_model_ids: set[str] = set()

    for provider in providers:
        api_base = provider.api_base.strip()
        api_key = decrypt_api_key(provider.api_key) if provider.api_key else ''
        if not api_base or not api_key:
            logger.debug(
                'Skip provider %s because it has no OpenAI API base or key',
                provider.id,
            )
            continue

        provider_model_ids: list[str] = []
        seen_provider_model_ids: set[str] = set()
        for model in models_by_provider.get(provider.id, []):
            if model.type not in SYNCABLE_MODEL_TYPES:
                continue
            if model.status in SKIPPED_MODEL_STATUSES:
                continue

            model_id = (model.name or model.id).strip()
            if not model_id or model_id in seen_model_ids:
                continue
            if model_id in seen_provider_model_ids:
                continue

            seen_model_ids.add(model_id)
            seen_provider_model_ids.add(model_id)
            provider_model_ids.append(model_id)
            model_records.append(
                ModelSyncModel(
                    id=model_id,
                    name=model.display_name or model.name,
                    vendor=provider.name,
                    url=api_base,
                    api_key=api_key,
                    protocol='openai-chat',
                    supports_tool_call=_supports_tool_call(model.type),
                    supports_images=_supports_images(model.type),
                    supports_reasoning=False,
                )
            )

        provider_records.append(
            ModelSyncProvider(
                id=provider.id,
                name=provider.name,
                logo=provider.logo or (provider.name[:1] if provider.name else 'custom'),
                default_url=api_base,
                response_url=provider.response_url,
                anthropic_url=provider.anthropic_url,
                plans=[ModelSyncPlan(type='自定义 API')],
                models=provider_model_ids,
            )
        )

    return ModelSyncResponse(
        version=MODELS_FILE_VERSION,
        providers=provider_records,
        models=model_records,
        synced_at=int(time.time() * 1000),
    )
