"""模型类型参数分组测试。

「模型」页面添加模型时的「模型类型」下拉，取值来自「参数配置」页面的
``model_type`` 分组。这里守护三件事：

1. 首次启动种子化默认类型，且**幂等**；
2. 种子化**不覆盖**管理员在参数配置页面的改动（删掉的类型不会被"复活"）；
3. 分组为空/缺失时回退到内置默认值，模型页面不会出现空下拉。
"""

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from api.params.schemas import ParamCreateRequest
from api.params.service import (
    DEFAULT_MODEL_TYPES,
    MODEL_TYPE_PARENT_CODE,
    create_param,
    delete_param,
    list_model_types,
    seed_builtin_params,
)
from db.base import Base
from db.models.system_param import SystemParam

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


async def _children(session: AsyncSession) -> list[SystemParam]:
    result = await session.execute(
        select(SystemParam)
        .where(SystemParam.parent_code == MODEL_TYPE_PARENT_CODE)
        .order_by(SystemParam.sort_order)
    )
    return list(result.scalars().all())


class TestSeeding:
    async def test_creates_group_and_children(self, db_session: AsyncSession):
        await seed_builtin_params(db_session)
        await db_session.commit()

        group = (
            await db_session.execute(
                select(SystemParam).where(SystemParam.param_code == MODEL_TYPE_PARENT_CODE)
            )
        ).scalar_one()
        assert group.parent_code is None
        assert group.param_type == "group"
        assert group.param_label == "模型类型"

        children = await _children(db_session)
        assert len(children) == len(DEFAULT_MODEL_TYPES)
        assert [c.param_value for c in children] == [code for code, _ in DEFAULT_MODEL_TYPES]

    async def test_values_match_current_type_codes(self, db_session: AsyncSession):
        """默认类型编码必须覆盖代码里已支持的类型（含 rerank）。"""
        await seed_builtin_params(db_session)
        await db_session.commit()

        codes = {c.param_value for c in await _children(db_session)}
        assert {"llm", "embedding", "rerank"} <= codes

    async def test_idempotent(self, db_session: AsyncSession):
        """重复调用不得产生重复行（每次启动都会执行）。"""
        await seed_builtin_params(db_session)
        await db_session.commit()
        before = len(await _children(db_session))

        await seed_builtin_params(db_session)
        await db_session.commit()

        assert len(await _children(db_session)) == before

    async def test_does_not_resurrect_deleted_types(self, db_session: AsyncSession):
        """管理员删掉的类型不应被下次启动重新补回来。"""
        await seed_builtin_params(db_session)
        await db_session.commit()

        victim = (await _children(db_session))[0]
        await delete_param(db_session, victim.id)
        await db_session.commit()

        await seed_builtin_params(db_session)
        await db_session.commit()

        codes = {c.param_value for c in await _children(db_session)}
        assert victim.param_value not in codes

    async def test_does_not_override_admin_label(self, db_session: AsyncSession):
        """管理员改过的展示名必须保留。"""
        await seed_builtin_params(db_session)
        await db_session.commit()

        child = (await _children(db_session))[0]
        child.param_label = "自定义名称"
        await db_session.commit()

        await seed_builtin_params(db_session)
        await db_session.commit()

        refreshed = (
            await db_session.execute(
                select(SystemParam).where(SystemParam.id == child.id)
            )
        ).scalar_one()
        assert refreshed.param_label == "自定义名称"


class TestListModelTypes:
    async def test_returns_seeded_options_in_order(self, db_session: AsyncSession):
        await seed_builtin_params(db_session)
        await db_session.commit()

        options = await list_model_types(db_session)

        assert options[0] == {"value": "llm", "label": "大语言模型"}
        assert {"value": "rerank", "label": "重排序模型"} in options
        assert len(options) == len(DEFAULT_MODEL_TYPES)

    async def test_reflects_admin_added_type(self, db_session: AsyncSession):
        """参数配置页新增的类型应立即出现在下拉里。"""
        await seed_builtin_params(db_session)
        await db_session.commit()

        await create_param(
            db_session,
            ParamCreateRequest(
                paramCode="model_type_voice_clone",
                parentCode=MODEL_TYPE_PARENT_CODE,
                paramLabel="声音克隆",
                paramName="voice-clone",
                paramValue="voice-clone",
                paramType="string",
            ),
        )
        await db_session.commit()

        options = await list_model_types(db_session)

        assert {"value": "voice-clone", "label": "声音克隆"} in options

    async def test_falls_back_when_group_missing(self, db_session: AsyncSession):
        """未种子化（或管理员清空）时回退默认值，不能返回空下拉。"""
        options = await list_model_types(db_session)

        assert [o["value"] for o in options] == [code for code, _ in DEFAULT_MODEL_TYPES]

    async def test_falls_back_when_children_have_blank_values(self, db_session: AsyncSession):
        await seed_builtin_params(db_session)
        await db_session.commit()
        for child in await _children(db_session):
            child.param_value = ""
            child.param_name = ""
        await db_session.commit()

        options = await list_model_types(db_session)

        assert [o["value"] for o in options] == [code for code, _ in DEFAULT_MODEL_TYPES]

    async def test_uses_param_name_when_value_blank(self, db_session: AsyncSession):
        """param_value 留空时用 param_name 兜底（参数配置表单允许只填名称）。"""
        await seed_builtin_params(db_session)
        await db_session.commit()
        child = (await _children(db_session))[0]
        child.param_value = None
        await db_session.commit()

        options = await list_model_types(db_session)

        assert options[0]["value"] == "llm"

    async def test_duplicate_values_are_deduplicated(self, db_session: AsyncSession):
        await seed_builtin_params(db_session)
        await db_session.commit()
        await create_param(
            db_session,
            ParamCreateRequest(
                paramCode="model_type_llm_dup",
                parentCode=MODEL_TYPE_PARENT_CODE,
                paramLabel="重复的 LLM",
                paramName="llm",
                paramValue="llm",
                paramType="string",
            ),
        )
        await db_session.commit()

        values = [o["value"] for o in await list_model_types(db_session)]

        assert values.count("llm") == 1

    async def test_label_falls_back_to_code(self, db_session: AsyncSession):
        await seed_builtin_params(db_session)
        await db_session.commit()
        child = (await _children(db_session))[0]
        child.param_label = ""
        await db_session.commit()

        option = (await list_model_types(db_session))[0]

        assert option == {"value": "llm", "label": "llm"}

    async def test_option_shape_is_value_label(self, db_session: AsyncSession):
        """前端契约：每项只有 value/label 两个键。"""
        await seed_builtin_params(db_session)
        await db_session.commit()

        for option in await list_model_types(db_session):
            assert set(option) == {"value", "label"}
