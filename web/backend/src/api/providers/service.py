"""Business logic for provider and model CRUD operations."""
import logging

from fastapi import HTTPException
from pydantic import SecretStr
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from api.providers.schemas import (
    ModelCreateRequest,
    ModelResponse,
    ModelUpdateRequest,
    ProviderCreateRequest,
    ProviderReorderRequest,
    ProviderResponse,
    ProviderUpdateRequest,
)
from core.security import MASKED_API_KEY, decrypt_api_key, encrypt_api_key
from db.models.ai_model import AIModel
from db.models.provider import Provider

logger = logging.getLogger(__name__)


def _provider_to_response(p: Provider, models: list[AIModel]) -> ProviderResponse:
    """Convert Provider ORM object + its models to response schema."""
    return ProviderResponse(
        id=p.id,
        name=p.name,
        logo=p.logo,
        status=p.status,
        api_base=p.api_base,
        response_url=p.response_url,
        anthropic_url=p.anthropic_url,
        sort_order=p.sort_order,
        api_key=SecretStr(decrypt_api_key(p.api_key)),
        description=p.description,
        website=p.website,
        models=[_model_to_response(m) for m in models],
        created_at=p.created_at,
        updated_at=p.updated_at,
    )


def _model_to_response(m: AIModel) -> ModelResponse:
    """Convert AIModel ORM object to response schema."""
    return ModelResponse(
        id=m.id,
        name=m.name,
        display_name=m.display_name,
        type=m.type,
        status=m.status,
        context_window=m.context_window,
        call_count=m.call_count,
        description=m.description,
        release_date=m.release_date,
        params=m.params,
        created_at=m.created_at,
        updated_at=m.updated_at,
    )


async def _get_provider(db: AsyncSession, provider_id: str) -> Provider:
    """Fetch a provider by ID. Raises 404 if not found."""
    result = await db.execute(
        select(Provider).where(Provider.id == provider_id)
    )
    provider = result.scalar_one_or_none()
    if provider is None:
        raise HTTPException(status_code=404, detail="提供商不存在")
    return provider


async def _get_model(db: AsyncSession, model_id: str, provider_id: str) -> AIModel:
    """Fetch a model by ID and provider. Raises 404 if not found."""
    result = await db.execute(
        select(AIModel).where(
            AIModel.id == model_id,
            AIModel.provider_id == provider_id,
        )
    )
    model = result.scalar_one_or_none()
    if model is None:
        raise HTTPException(status_code=404, detail="模型不存在")
    return model


# ---- 提供商 CRUD ----

async def list_providers(db: AsyncSession) -> list[ProviderResponse]:
    """List all providers with their nested models."""
    result = await db.execute(
        select(Provider).order_by(Provider.sort_order, Provider.created_at)
    )
    providers = result.scalars().all()
    responses: list[ProviderResponse] = []
    for p in providers:
        models_result = await db.execute(
            select(AIModel).where(AIModel.provider_id == p.id).order_by(AIModel.created_at)
        )
        models = list(models_result.scalars().all())
        responses.append(_provider_to_response(p, models))
    return responses


async def create_provider(
    db: AsyncSession, req: ProviderCreateRequest, user_id: str
) -> ProviderResponse:
    """Create a new provider."""
    max_sort_result = await db.execute(select(func.max(Provider.sort_order)))
    next_sort_order = (max_sort_result.scalar() or 0) + 1

    provider = Provider(
        name=req.name,
        logo=req.logo,
        api_base=req.api_base or "",
        response_url=req.response_url,
        anthropic_url=req.anthropic_url,
        api_key=encrypt_api_key(req.api_key),
        description=req.description,
        website=req.website,
        sort_order=next_sort_order,
        user_id=user_id,
    )
    db.add(provider)
    await db.commit()
    await db.refresh(provider)
    return _provider_to_response(provider, [])


async def update_provider(
    db: AsyncSession, provider_id: str, req: ProviderUpdateRequest, user_id: str
) -> ProviderResponse:
    """Update an existing provider."""
    provider = await _get_provider(db, provider_id)
    provider.name = req.name
    provider.logo = req.logo
    provider.api_base = req.api_base
    provider.response_url = req.response_url
    provider.anthropic_url = req.anthropic_url
    provider.api_key = (
        provider.api_key if req.api_key == MASKED_API_KEY else encrypt_api_key(req.api_key)
    )
    provider.status = req.status
    provider.description = req.description
    provider.website = req.website
    await db.commit()
    await db.refresh(provider)
    models_result = await db.execute(
        select(AIModel).where(AIModel.provider_id == provider.id).order_by(AIModel.created_at)
    )
    models = list(models_result.scalars().all())
    return _provider_to_response(provider, models)


async def delete_provider(db: AsyncSession, provider_id: str, user_id: str) -> None:
    """Delete a provider and cascade-delete all its models."""
    provider = await _get_provider(db, provider_id)
    await db.execute(
        delete(AIModel).where(AIModel.provider_id == provider_id)
    )
    await db.delete(provider)
    await db.commit()


async def reorder_providers(
    db: AsyncSession, req: ProviderReorderRequest, user_id: str
) -> None:
    """Persist the provider display order."""
    if len(set(req.provider_ids)) != len(req.provider_ids):
        raise HTTPException(status_code=400, detail="提供商 ID 不能重复")

    result = await db.execute(select(Provider).where(Provider.id.in_(req.provider_ids)))
    providers = list(result.scalars().all())
    by_id = {p.id: p for p in providers}
    if len(by_id) != len(req.provider_ids):
        raise HTTPException(status_code=404, detail="部分提供商不存在")

    for index, provider_id in enumerate(req.provider_ids):
        by_id[provider_id].sort_order = index
    await db.commit()


# ---- 模型 CRUD ----

async def create_model(
    db: AsyncSession, provider_id: str, req: ModelCreateRequest, user_id: str
) -> ModelResponse:
    """Create a new model under a provider."""
    await _get_provider(db, provider_id)
    model = AIModel(
        provider_id=provider_id,
        name=req.name,
        display_name=req.display_name,
        type=req.type,
        status=req.status,
        context_window=req.context_window,
        description=req.description,
        release_date=req.release_date,
        params=[p.model_dump() for p in req.params],
    )
    db.add(model)
    await db.commit()
    await db.refresh(model)
    return _model_to_response(model)


async def update_model(
    db: AsyncSession, provider_id: str, model_id: str, req: ModelUpdateRequest, user_id: str
) -> ModelResponse:
    """Update an existing model."""
    await _get_provider(db, provider_id)
    model = await _get_model(db, model_id, provider_id)
    model.name = req.name
    model.display_name = req.display_name
    model.type = req.type
    model.status = req.status
    model.context_window = req.context_window
    model.call_count = req.call_count
    model.description = req.description
    model.release_date = req.release_date
    model.params = [p.model_dump() for p in req.params]
    await db.commit()
    await db.refresh(model)
    return _model_to_response(model)


async def delete_model(
    db: AsyncSession, provider_id: str, model_id: str, user_id: str
) -> None:
    """Delete a model under a provider."""
    await _get_provider(db, provider_id)
    model = await _get_model(db, model_id, provider_id)
    await db.delete(model)
    await db.commit()


async def clone_model(
    db: AsyncSession, provider_id: str, model_id: str, user_id: str
) -> ModelResponse:
    """Clone a model — copies all fields with a new ID and modified display name."""
    await _get_provider(db, provider_id)
    original = await _get_model(db, model_id, provider_id)
    cloned = AIModel(
        provider_id=provider_id,
        name=original.name + "-clone",
        display_name=original.display_name + " (副本)",
        type=original.type,
        status=original.status,
        context_window=original.context_window,
        call_count=0,
        description=original.description,
        release_date=original.release_date,
        params=original.params,
    )
    db.add(cloned)
    await db.commit()
    await db.refresh(cloned)
    return _model_to_response(cloned)


async def toggle_model_status(
    db: AsyncSession, provider_id: str, model_id: str, user_id: str
) -> ModelResponse:
    """Toggle model status between active and inactive."""
    await _get_provider(db, provider_id)
    model = await _get_model(db, model_id, provider_id)
    model.status = "inactive" if model.status == "active" else "active"
    await db.commit()
    await db.refresh(model)
    return _model_to_response(model)


# ---- 已有明文密钥自动升级 ----

_FERNET_PREFIX = "gAAAAAB"


async def migrate_plaintext_api_keys(db: AsyncSession) -> int:
    """Upgrade any plaintext api_key values to encrypted form.

    Returns the number of keys that were upgraded.
    """
    result = await db.execute(select(Provider))
    providers = result.scalars().all()

    upgraded = 0
    for p in providers:
        if p.api_key and not p.api_key.startswith(_FERNET_PREFIX):
            try:
                p.api_key = encrypt_api_key(p.api_key)
                upgraded += 1
                logger.info(
                    "Migrated api_key for provider '%s' (%s)", p.name, p.id,
                )
            except Exception:
                logger.exception(
                    "Failed to migrate api_key for provider '%s' (%s)", p.name, p.id,
                )

    if upgraded:
        await db.commit()
        logger.info("Migrated %d plaintext api_key(s) to encrypted", upgraded)

    return upgraded
