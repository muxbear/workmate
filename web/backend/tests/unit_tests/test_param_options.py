"""「类型」参数分组测试（api/params/service.py）.

各页面的筛选下拉统一从「参数配置」的对应分组取值，这里锁住三件事：
种子幂等、排序与「值/标签」的取值口径、以及**未配置时不回退**的行为
（「以参数配置为唯一来源」的既定口径：管理员清空即筛选为空）。
"""

from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from api.params.service import (
    DEFAULT_TOOL_TYPES,
    EXPERT_TYPE_PARENT_CODE,
    MCP_TYPE_PARENT_CODE,
    MODEL_TYPE_PARENT_CODE,
    SCHEDULE_TEMPLATE_TYPE_PARENT_CODE,
    SKILL_TYPE_PARENT_CODE,
    TOOL_TYPE_PARENT_CODE,
    _BUILTIN_TYPE_GROUPS,
    list_model_types,
    list_param_options,
    seed_builtin_params,
)
from db.base import Base
from db.models.system_param import SystemParam

pytestmark = pytest.mark.anyio


@pytest_asyncio.fixture
async def session() -> AsyncGenerator[AsyncSession, None]:
    """内存库会话（已建表）."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        yield db
    await engine.dispose()


EXPECTED_DEFAULT_COUNTS = {
    MODEL_TYPE_PARENT_CODE: 9,
    SCHEDULE_TEMPLATE_TYPE_PARENT_CODE: 5,
    EXPERT_TYPE_PARENT_CODE: 9,
    TOOL_TYPE_PARENT_CODE: 8,
    SKILL_TYPE_PARENT_CODE: 6,
    MCP_TYPE_PARENT_CODE: 9,
}


async def test_seed_creates_every_type_group(session: AsyncSession) -> None:
    """首次种子把 6 个分组连同默认项一起建出来."""
    await seed_builtin_params(session)
    await session.commit()

    for parent_code, expected in EXPECTED_DEFAULT_COUNTS.items():
        options = await list_param_options(session, parent_code)
        assert len(options) == expected, parent_code


async def test_seed_is_idempotent(session: AsyncSession) -> None:
    """重复种子不会翻倍（启动时每次都会调用）."""
    await seed_builtin_params(session)
    await session.commit()
    await seed_builtin_params(session)
    await session.commit()

    for parent_code, expected in EXPECTED_DEFAULT_COUNTS.items():
        assert len(await list_param_options(session, parent_code)) == expected


async def test_deleted_group_is_not_resurrected(session: AsyncSession) -> None:
    """管理员删掉分组后不会被下次启动「复活」."""
    await seed_builtin_params(session)
    await session.commit()

    from sqlalchemy import delete

    await session.execute(
        delete(SystemParam).where(SystemParam.parent_code == TOOL_TYPE_PARENT_CODE)
    )
    await session.commit()

    await seed_builtin_params(session)
    await session.commit()
    assert await list_param_options(session, TOOL_TYPE_PARENT_CODE) == []


async def test_options_are_ordered_and_deduped(session: AsyncSession) -> None:
    """按 sort_order 排序，重复的取值只保留第一次出现."""
    session.add(
        SystemParam(
            param_code=TOOL_TYPE_PARENT_CODE,
            parent_code=None,
            param_label="工具类型",
            param_name=TOOL_TYPE_PARENT_CODE,
            param_type="group",
            description="",
            sort_order=0,
        )
    )
    for index, (code, label) in enumerate(
        [("b", "乙"), ("a", "甲"), ("a", "甲（重复）")], start=1
    ):
        session.add(
            SystemParam(
                param_code=f"tool_type_{code}_{index}",
                parent_code=TOOL_TYPE_PARENT_CODE,
                param_label=label,
                param_name=code,
                param_value=code,
                param_type="string",
                description="",
                sort_order=index,
            )
        )
    await session.commit()

    assert await list_param_options(session, TOOL_TYPE_PARENT_CODE) == [
        {"value": "b", "label": "乙"},
        {"value": "a", "label": "甲"},
    ]


async def test_value_falls_back_to_param_name(session: AsyncSession) -> None:
    """param_value 为空时取 param_name（与模型类型分组的历史写法一致）."""
    session.add(
        SystemParam(
            param_code="expert_type",
            parent_code=None,
            param_label="专家类型",
            param_name="expert_type",
            param_type="group",
            description="",
            sort_order=0,
        )
    )
    session.add(
        SystemParam(
            param_code="expert_type_legacy",
            parent_code=EXPERT_TYPE_PARENT_CODE,
            param_label="历史写法",
            param_name="legacy",
            param_value=None,
            param_type="string",
            description="",
            sort_order=1,
        )
    )
    await session.commit()

    assert await list_param_options(session, EXPERT_TYPE_PARENT_CODE) == [
        {"value": "legacy", "label": "历史写法"}
    ]


async def test_unconfigured_group_returns_empty_without_default(
    session: AsyncSession,
) -> None:
    """未配置且未给兜底时返回空列表——页面筛选为空是预期行为，不是异常."""
    assert await list_param_options(session, "never_configured") == []


async def test_default_is_used_only_when_group_is_empty(
    session: AsyncSession,
) -> None:
    """给了兜底才回退；分组一旦配了值就以配置为准."""
    fallback = [("x", "兜底")]
    assert await list_param_options(session, TOOL_TYPE_PARENT_CODE, fallback) == [
        {"value": "x", "label": "兜底"}
    ]

    await seed_builtin_params(session)
    await session.commit()
    options = await list_param_options(session, TOOL_TYPE_PARENT_CODE, fallback)
    assert len(options) == len(DEFAULT_TOOL_TYPES)
    assert "x" not in [item["value"] for item in options]


async def test_model_types_keeps_its_fallback(session: AsyncSession) -> None:
    """模型类型分组保留兜底（模型页面对所有登录用户开放，不能变成空下拉）."""
    assert len(await list_model_types(session)) == EXPECTED_DEFAULT_COUNTS[
        MODEL_TYPE_PARENT_CODE
    ]


def test_schedule_template_types_are_the_expected_five() -> None:
    """模板类型的默认项（12 条内置模板按这 5 类归类）."""
    _, _, defaults, _ = _BUILTIN_TYPE_GROUPS[SCHEDULE_TEMPLATE_TYPE_PARENT_CODE]
    assert [code for code, _ in defaults] == [
        "news",
        "learning",
        "life",
        "work",
        "fun",
    ]
