"""提供商 / 模型管理服务测试。

重点覆盖「默认对话模型」相关行为：
- ``set_default_model`` 的单默认不变式与校验；
- ``clone_model`` 不得复制默认标记、也不得插队到排序最前（否则会悄悄改掉默认模型）；
- 所有会影响默认模型解析的写操作都要让已缓存的 Graph 失效。
"""

from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from api.providers.schemas import ModelCreateRequest, ModelReorderRequest
from api.providers.service import (
    clone_model,
    create_model,
    reorder_models,
    set_default_model,
    toggle_model_status,
)
from core.security import encrypt_api_key
from db.base import Base
from db.models.ai_model import AIModel
from db.models.provider import Provider

pytestmark = pytest.mark.anyio


@pytest.fixture
async def db_session():
    """内存 SQLite 会话。"""
    engine = create_async_engine("sqlite+aiosqlite://", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as session:
        yield session
    await engine.dispose()


@pytest.fixture(autouse=True)
def _no_graph_invalidation(monkeypatch):
    """默认把 invalidate_graph 换成 AsyncMock，避免触碰真实 GraphManager。

    需要断言调用次数的用例再自行取回该 mock。
    """
    mock = AsyncMock()
    monkeypatch.setattr("api.providers.service.invalidate_graph", mock)
    return mock


@pytest.fixture
async def seeded(db_session: AsyncSession) -> AsyncSession:
    """两家提供商、各若干模型的初始数据。"""
    db_session.add_all([
        Provider(
            id="p1", name="ProviderOne", api_base="https://one.example.com/v1",
            api_key=encrypt_api_key("sk-one"), sort_order=0, user_id="u1",
        ),
        Provider(
            id="p2", name="ProviderTwo", api_base="https://two.example.com/v1",
            api_key=encrypt_api_key("sk-two"), sort_order=1, user_id="u1",
        ),
    ])
    await db_session.flush()
    db_session.add_all([
        AIModel(id="m1", provider_id="p1", name="one-chat", display_name="One Chat",
                type="llm", status="active", sort_order=0),
        AIModel(id="m2", provider_id="p2", name="two-chat", display_name="Two Chat",
                type="multimodal", status="active", sort_order=0),
        AIModel(id="m3", provider_id="p2", name="two-image", display_name="Two Image",
                type="image-gen", status="active", sort_order=1),
        AIModel(id="m4", provider_id="p2", name="two-off", display_name="Two Off",
                type="llm", status="inactive", sort_order=2),
    ])
    await db_session.commit()
    return db_session


async def _defaults(session: AsyncSession) -> list[str]:
    rows = (
        await session.execute(select(AIModel).where(AIModel.is_default.is_(True)))
    ).scalars().all()
    return sorted(m.name for m in rows)


# ---- set_default_model ----


async def test_set_default_marks_only_target(seeded: AsyncSession):
    """设置默认模型后，有且仅有一个模型被标记。"""
    await set_default_model(seeded, "p1", "m1", "u1")

    assert await _defaults(seeded) == ["one-chat"]


async def test_set_default_is_single_globally(seeded: AsyncSession):
    """跨提供商连续设置：旧标记被清空，只剩最后一个。"""
    await set_default_model(seeded, "p1", "m1", "u1")
    await set_default_model(seeded, "p2", "m2", "u1")

    assert await _defaults(seeded) == ["two-chat"]


async def test_set_default_is_idempotent(seeded: AsyncSession):
    """重复设置同一个模型不报错，且仍只有一个默认。"""
    await set_default_model(seeded, "p1", "m1", "u1")
    await set_default_model(seeded, "p1", "m1", "u1")

    assert await _defaults(seeded) == ["one-chat"]


async def test_set_default_rejects_non_chat_type(seeded: AsyncSession):
    """image-gen 等非对话类型不可设为默认（400）。"""
    with pytest.raises(HTTPException) as excinfo:
        await set_default_model(seeded, "p2", "m3", "u1")

    assert excinfo.value.status_code == 400
    assert "image-gen" in excinfo.value.detail


async def test_set_default_rejects_inactive_model(seeded: AsyncSession):
    """已禁用的模型不可设为默认（400）。"""
    with pytest.raises(HTTPException) as excinfo:
        await set_default_model(seeded, "p2", "m4", "u1")

    assert excinfo.value.status_code == 400
    assert "inactive" in excinfo.value.detail


async def test_set_default_rejects_unknown_model(seeded: AsyncSession):
    """模型不存在时 404。"""
    with pytest.raises(HTTPException) as excinfo:
        await set_default_model(seeded, "p1", "nope", "u1")

    assert excinfo.value.status_code == 404


async def test_set_default_rejects_unknown_provider(seeded: AsyncSession):
    """提供商不存在时 404。"""
    with pytest.raises(HTTPException) as excinfo:
        await set_default_model(seeded, "nope", "m1", "u1")

    assert excinfo.value.status_code == 404


async def test_set_default_invalidates_graph(seeded: AsyncSession, _no_graph_invalidation):
    """默认模型变了必须重建已缓存的 Graph。"""
    await set_default_model(seeded, "p1", "m1", "u1")

    _no_graph_invalidation.assert_awaited_once()


# ---- clone_model ----


async def test_clone_does_not_inherit_default_flag(seeded: AsyncSession):
    """克隆默认模型后，原模型仍是唯一默认，克隆体没有被标记。"""
    await set_default_model(seeded, "p1", "m1", "u1")

    cloned = await clone_model(seeded, "p1", "m1", "u1")

    assert cloned.is_default is False
    assert await _defaults(seeded) == ["one-chat"]


async def test_clone_sorts_last_not_first(seeded: AsyncSession):
    """克隆体排在末尾，不得靠 sort_order=0 插队（否则会悄悄成为默认模型）。"""
    cloned = await clone_model(seeded, "p1", "m1", "u1")

    assert cloned.sort_order > 0
    max_original = (
        await seeded.execute(
            select(func.max(AIModel.sort_order)).where(
                AIModel.provider_id == "p1", AIModel.id != cloned.id
            )
        )
    ).scalar()
    assert cloned.sort_order > max_original


# ---- 其它写操作让 Graph 失效 ----


async def test_create_model_invalidates_graph(seeded: AsyncSession, _no_graph_invalidation):
    """新增模型可能改变默认模型解析结果。"""
    await create_model(
        seeded,
        "p1",
        ModelCreateRequest(name="new-chat", display_name="New Chat", type="llm"),
        "u1",
    )

    _no_graph_invalidation.assert_awaited_once()


async def test_reorder_models_invalidates_graph(seeded: AsyncSession, _no_graph_invalidation):
    """sort_order 是默认模型的兜底依据，重排必须让图失效。"""
    await reorder_models(seeded, "p1", ModelReorderRequest(model_ids=["m1"]), "u1")

    _no_graph_invalidation.assert_awaited_once()


# ---- 禁用模型时清理默认标记 ----


async def test_disabling_default_model_clears_flag(seeded: AsyncSession):
    """禁用默认模型时同步清掉标记，避免页面残留「默认」徽标。"""
    await set_default_model(seeded, "p1", "m1", "u1")

    result = await toggle_model_status(seeded, "p1", "m1", "u1")

    assert result.status == "inactive"
    assert result.is_default is False
    assert await _defaults(seeded) == []
