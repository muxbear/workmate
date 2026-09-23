"""默认对话模型解析测试（「模型」页面 → LLM）。

覆盖 ``agent.models.resolver`` 的选取规则：
``ai_models.is_default`` 显式标记优先，否则按
``Provider.sort_order → AIModel.sort_order → created_at`` 兜底；
不可用的候选（缺 api_key、api_base 为空、已禁用、非对话类型）会被跳过；
全不可用时抛出可执行的 ``ModelNotConfiguredError``。
"""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from agent.models.resolver import (
    CHAT_MODEL_TYPES,
    ModelNotConfiguredError,
    resolve_default_llm,
    resolve_llm,
)
from core.security import encrypt_api_key
from db.base import Base
from db.models.ai_model import AIModel
from db.models.provider import Provider

pytestmark = pytest.mark.anyio


@pytest.fixture
async def db_session():
    """内存 SQLite 会话（与 test_agent_service.py 的夹具保持一致）。"""
    engine = create_async_engine("sqlite+aiosqlite://", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as session:
        yield session
    await engine.dispose()


def _provider(
    *,
    pid: str,
    name: str,
    sort_order: int,
    api_base: str = "https://api.example.com/v1",
    api_key: str | None = "sk-test",
) -> Provider:
    """构造提供商行；api_key=None 表示留空，原始明文会被加密存储。"""
    return Provider(
        id=pid,
        name=name,
        api_base=api_base,
        api_key=encrypt_api_key(api_key) if api_key else "",
        sort_order=sort_order,
        user_id="test-user",
    )


def _model(
    *,
    mid: str,
    pid: str,
    name: str,
    sort_order: int = 0,
    type_: str = "llm",
    status: str = "active",
    is_default: bool = False,
) -> AIModel:
    """构造模型行。"""
    return AIModel(
        id=mid,
        provider_id=pid,
        name=name,
        display_name=name,
        type=type_,
        status=status,
        sort_order=sort_order,
        is_default=is_default,
    )


async def _add(session: AsyncSession, *rows: object) -> None:
    for row in rows:
        session.add(row)
    await session.commit()


# ---- 选取规则 ----


async def test_picks_first_by_page_order_when_no_default(db_session: AsyncSession):
    """无显式默认时，按「提供商顺序 → 模型顺序」取第一个。"""
    await _add(
        db_session,
        _provider(pid="p1", name="ProviderOne", sort_order=0),
        _provider(pid="p2", name="ProviderTwo", sort_order=1),
        _model(mid="m1", pid="p1", name="first-model", sort_order=0),
        _model(mid="m2", pid="p1", name="second-model", sort_order=1),
        _model(mid="m3", pid="p2", name="other-provider-model", sort_order=0),
    )

    resolved = await resolve_default_llm(db_session)

    assert resolved.model_name == "first-model"
    assert resolved.openai_api_base == "https://api.example.com/v1"


async def test_provider_order_dominates_model_order(db_session: AsyncSession):
    """提供商顺序优先于模型顺序。"""
    await _add(
        db_session,
        _provider(pid="p1", name="ProviderOne", sort_order=0),
        _provider(pid="p2", name="ProviderTwo", sort_order=1),
        _model(mid="m1", pid="p1", name="a-low", sort_order=5),
        _model(mid="m2", pid="p2", name="b-high", sort_order=0),
    )

    resolved = await resolve_default_llm(db_session)

    assert resolved.model_name == "a-low"


async def test_explicit_default_beats_page_order(db_session: AsyncSession):
    """is_default=True 的模型压过拖拽顺序。"""
    await _add(
        db_session,
        _provider(pid="p1", name="ProviderOne", sort_order=0),
        _provider(pid="p2", name="ProviderTwo", sort_order=1),
        _model(mid="m1", pid="p1", name="ranked-first", sort_order=0),
        _model(mid="m2", pid="p2", name="marked-default", sort_order=9, is_default=True),
    )

    resolved = await resolve_default_llm(db_session)

    assert resolved.model_name == "marked-default"


async def test_default_provider_base_url_is_used(db_session: AsyncSession):
    """解析结果使用所属提供商的 api_base。"""
    await _add(
        db_session,
        _provider(pid="p1", name="ProviderOne", sort_order=0, api_base="https://custom.example.cn/v1"),
        _model(mid="m1", pid="p1", name="m", sort_order=0),
    )

    resolved = await resolve_default_llm(db_session)

    assert resolved.openai_api_base == "https://custom.example.cn/v1"


# ---- 跳过不可用候选 ----


async def test_marked_default_that_is_inactive_falls_through(db_session: AsyncSession):
    """被标记但已禁用的模型顺延到下一个可用模型。"""
    await _add(
        db_session,
        _provider(pid="p1", name="ProviderOne", sort_order=0),
        _model(mid="m1", pid="p1", name="disabled-default", sort_order=0, status="inactive", is_default=True),
        _model(mid="m2", pid="p1", name="usable", sort_order=1),
    )

    resolved = await resolve_default_llm(db_session)

    assert resolved.model_name == "usable"


async def test_marked_default_of_non_chat_type_falls_through(db_session: AsyncSession):
    """被标记但不是对话类型（如 image-gen）的模型顺延。"""
    await _add(
        db_session,
        _provider(pid="p1", name="ProviderOne", sort_order=0),
        _model(mid="m1", pid="p1", name="an-image-model", sort_order=0, type_="image-gen", is_default=True),
        _model(mid="m2", pid="p1", name="a-chat-model", sort_order=1),
    )

    resolved = await resolve_default_llm(db_session)

    assert resolved.model_name == "a-chat-model"


async def test_provider_without_api_key_is_skipped(db_session: AsyncSession):
    """提供商未配置 api_key 时跳过，顺延到下一个可用提供商。"""
    await _add(
        db_session,
        _provider(pid="p1", name="NoKeyProvider", sort_order=0, api_key=None),
        _provider(pid="p2", name="WithKeyProvider", sort_order=1),
        _model(mid="m1", pid="p1", name="unusable", sort_order=0),
        _model(mid="m2", pid="p2", name="usable", sort_order=0),
    )

    resolved = await resolve_default_llm(db_session)

    assert resolved.model_name == "usable"


async def test_provider_with_blank_api_base_is_skipped(db_session: AsyncSession):
    """api_base 为空时必须跳过：否则 SDK 会把密钥发往 api.openai.com。"""
    await _add(
        db_session,
        _provider(pid="p1", name="BlankBaseProvider", sort_order=0, api_base=""),
        _provider(pid="p2", name="GoodProvider", sort_order=1),
        _model(mid="m1", pid="p1", name="unusable", sort_order=0),
        _model(mid="m2", pid="p2", name="usable", sort_order=0),
    )

    resolved = await resolve_default_llm(db_session)

    assert resolved.model_name == "usable"


async def test_undecryptable_api_key_is_skipped(db_session: AsyncSession):
    """api_key 无法解密（历史明文等）时跳过。"""
    await _add(
        db_session,
        _provider(pid="p1", name="BadKeyProvider", sort_order=0),
        _provider(pid="p2", name="GoodProvider", sort_order=1),
        _model(mid="m1", pid="p1", name="unusable", sort_order=0),
        _model(mid="m2", pid="p2", name="usable", sort_order=0),
    )
    # 直接把密文换成非 Fernet 内容，模拟解密失败
    from sqlalchemy import update

    await db_session.execute(
        update(Provider).where(Provider.id == "p1").values(api_key="plain-text-not-fernet")
    )
    await db_session.commit()

    resolved = await resolve_default_llm(db_session)

    assert resolved.model_name == "usable"


# ---- 无可用模型 ----


async def test_raises_when_no_models(db_session: AsyncSession):
    """「模型」页面为空时抛出可执行提示。"""
    with pytest.raises(ModelNotConfiguredError) as excinfo:
        await resolve_default_llm(db_session)

    message = str(excinfo.value)
    assert "模型" in message
    assert "llm" in message


async def test_raises_when_all_models_unusable(db_session: AsyncSession):
    """有模型但全部不可用（禁用 / 缺密钥）时同样抛出。"""
    await _add(
        db_session,
        _provider(pid="p1", name="NoKeyProvider", sort_order=0, api_key=None),
        _model(mid="m1", pid="p1", name="disabled", sort_order=0, status="inactive"),
    )

    with pytest.raises(ModelNotConfiguredError):
        await resolve_default_llm(db_session)


def test_error_is_a_runtime_error():
    """保持「解析失败抛 RuntimeError」的既有约定。"""
    assert issubclass(ModelNotConfiguredError, RuntimeError)


def test_chat_model_types_match_frontend_selector():
    """可对话类型必须与前端 ModelSelector 的过滤保持一致。"""
    assert CHAT_MODEL_TYPES == ("llm", "multimodal")


# ---- 显式 provider/model 路径（保持既有语义） ----


async def test_resolve_llm_explicit_pair(db_session: AsyncSession):
    """显式 provider_id + model_id 直接解析该模型（不受默认标记影响）。"""
    await _add(
        db_session,
        _provider(pid="p1", name="ProviderOne", sort_order=0, api_base="https://explicit.example.com/v1"),
        _model(mid="m1", pid="p1", name="explicit-model", sort_order=0),
        _model(mid="m2", pid="p1", name="marked", sort_order=1, is_default=True),
    )

    resolved = await resolve_llm("p1", "m1", db_session)

    assert resolved.model_name == "explicit-model"
    assert resolved.openai_api_base == "https://explicit.example.com/v1"


async def test_resolve_llm_explicit_pair_rejects_blank_api_base(db_session: AsyncSession):
    """显式路径同样拦截空 api_base，避免密钥被发往默认的 api.openai.com。"""
    await _add(
        db_session,
        _provider(pid="p1", name="BlankBaseProvider", sort_order=0, api_base=""),
        _model(mid="m1", pid="p1", name="m", sort_order=0),
    )

    with pytest.raises(ModelNotConfiguredError, match="api_base"):
        await resolve_llm("p1", "m1", db_session)


async def test_resolve_llm_raises_for_unknown_provider(db_session: AsyncSession):
    """提供商不存在时抛出可读错误。"""
    with pytest.raises(RuntimeError, match="未找到"):
        await resolve_llm("missing-provider", "missing-model", db_session)


async def test_resolve_llm_raises_for_unknown_model(db_session: AsyncSession):
    """模型不属于该提供商时抛出可读错误。"""
    await _add(
        db_session,
        _provider(pid="p1", name="ProviderOne", sort_order=0),
        _model(mid="m1", pid="p1", name="m", sort_order=0),
    )

    with pytest.raises(RuntimeError, match="未找到模型"):
        await resolve_llm("p1", "other-model", db_session)


async def test_resolve_llm_raises_when_provider_has_no_key(db_session: AsyncSession):
    """提供商未配置密钥时抛出可读错误。"""
    await _add(
        db_session,
        _provider(pid="p1", name="NoKeyProvider", sort_order=0, api_key=None),
        _model(mid="m1", pid="p1", name="m", sort_order=0),
    )

    with pytest.raises(RuntimeError, match="api_key"):
        await resolve_llm("p1", "m1", db_session)
