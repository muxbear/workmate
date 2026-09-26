"""知识库组织能力：置顶 / 手工排序 / 分组 / 复制 / 导出（迭代 6 T6.2）。

要点：

1. **置顶与排序只在本人视图生效**——它们存在库行上是最省事的实现，但别人的列表
   不该被库主的偏好改变顺序（``list_kbs`` 只在 scope=personal 时按它排序）；
2. **上移/下移不跨置顶边界**——穿过边界会让一项"跳一大截"，要跨就显式切换置顶；
3. **删分组不删库**——库里是用户的数据资产；
4. **复制只复制定义与配置**，不复制文档与向量（否则一次复制就是一次全量重索引）。
"""

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from api.knowledge_base.service import (
    assign_kb_group,
    copy_kb,
    create_group,
    delete_group,
    export_kb_config,
    list_groups,
    list_kbs,
    move_kb,
    rename_group,
    set_kb_pinned,
)
from db.models.knowledge_base import KnowledgeBase
from db.models.knowledge_base_document import KnowledgeBaseDocument
from db.models.knowledge_base_entity import KnowledgeBaseEntity
from db.models.knowledge_base_group import KnowledgeBaseGroup
from db.models.knowledge_base_index_task import KnowledgeBaseIndexTask
from db.models.knowledge_base_relation import KnowledgeBaseRelation
from db.models.knowledge_base_share import KnowledgeBaseShare
from db.models.user import Account

pytestmark = pytest.mark.anyio

USER_A = "user-a"
USER_B = "user-b"
CONFIG = {"chunk_size": 512, "chunk_strategy": "recursive"}


@pytest.fixture
async def sessionmaker():
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        for model in (
            KnowledgeBase, KnowledgeBaseDocument, KnowledgeBaseEntity,
            KnowledgeBaseRelation, KnowledgeBaseIndexTask, KnowledgeBaseGroup,
            KnowledgeBaseShare,   # 访问判定会查分享记录
            Account,              # list_kbs 会查库主展示名
        ):
            await conn.run_sync(model.__table__.create)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    yield maker
    await engine.dispose()


async def seed_kb(
    sessionmaker, kb_id: str, name: str, *, user_id: str = USER_A,
    tags: list[str] | None = None, updated_at=None,
) -> None:
    from datetime import datetime

    async with sessionmaker() as db:
        db.add(KnowledgeBase(
            id=kb_id, name=name, user_id=user_id, status="ready",
            description=f"{name} 的说明", config=dict(CONFIG),
            tags=tags or [], visibility="private",
            created_at=updated_at or datetime(2026, 1, 1),
            updated_at=updated_at or datetime(2026, 1, 1),
        ))
        await db.commit()


async def ordered_names(sessionmaker, user_id: str = USER_A) -> list[str]:
    async with sessionmaker() as db:
        page = await list_kbs(db, user_id, page_size=50)
    return [kb.name for kb in page.items]


class TestPinningAndOrder:
    async def test_pinned_comes_first(self, sessionmaker):
        for i, kb_id in enumerate(("a", "b", "c")):
            await seed_kb(sessionmaker, kb_id, f"库{i}")

        async with sessionmaker() as db:
            await set_kb_pinned(db, "c", USER_A, True)
            await db.commit()

        assert await ordered_names(sessionmaker) == ["库2", "库0", "库1"]

    async def test_move_swaps_within_the_same_pin_group(self, sessionmaker):
        for i, kb_id in enumerate(("a", "b", "c")):
            await seed_kb(sessionmaker, kb_id, f"库{i}")

        async with sessionmaker() as db:
            await move_kb(db, "b", USER_A, "up")   # 库1 上移一位
            await db.commit()

        assert await ordered_names(sessionmaker) == ["库1", "库0", "库2"]

    async def test_move_does_not_cross_the_pin_boundary(self, sessionmaker):
        """把未置顶项"上移"穿过置顶边界会让它跳一大截——不做，返回原序。"""
        for i, kb_id in enumerate(("a", "b", "c")):
            await seed_kb(sessionmaker, kb_id, f"库{i}")

        async with sessionmaker() as db:
            await set_kb_pinned(db, "c", USER_A, True)
            await db.commit()
        async with sessionmaker() as db:
            await move_kb(db, "a", USER_A, "up")   # 库0 已在未置顶组的最前
            await db.commit()

        assert await ordered_names(sessionmaker) == ["库2", "库0", "库1"]

    async def test_invalid_direction_is_rejected(self, sessionmaker):
        await seed_kb(sessionmaker, "a", "库0")

        async with sessionmaker() as db:
            with pytest.raises(HTTPException) as exc:
                await move_kb(db, "a", USER_A, "left")

        assert exc.value.status_code == 400

    async def test_ordering_only_applies_to_personal_scope(self, sessionmaker):
        """排序只在 scope=personal 生效。

        is_pinned/sort_order 存在库行上（实现最省事），但它表达的是"我的视图偏好"。
        换成其它范围（"全部可见"的概览、公共库页签）时必须退回按更新时间排——
        否则库主的偏好会悄悄改变别人看到、或者自己在概览里看到的顺序。
        """
        from datetime import datetime

        await seed_kb(sessionmaker, "a", "甲库", updated_at=datetime(2026, 1, 2))
        await seed_kb(sessionmaker, "b", "乙库", updated_at=datetime(2026, 1, 1))
        async with sessionmaker() as db:
            await set_kb_pinned(db, "b", USER_A, True)
            await db.commit()

        # personal：置顶的在最前
        assert await ordered_names(sessionmaker) == ["乙库", "甲库"]

        # all（概览）：按更新时间，置顶不参与
        async with sessionmaker() as db:
            page = await list_kbs(db, USER_A, page_size=50, scope="all")
        assert [kb.name for kb in page.items] == ["甲库", "乙库"]


class TestTagFilter:
    async def test_filters_by_exact_tag(self, sessionmaker):
        await seed_kb(sessionmaker, "a", "带 k8s 的", tags=["k8s", "运维"])
        await seed_kb(sessionmaker, "b", "带 k8s-prod 的", tags=["k8s-prod"])
        await seed_kb(sessionmaker, "c", "无标签")

        async with sessionmaker() as db:
            page = await list_kbs(db, USER_A, tag="k8s")

        # 子串不能误命中：查 "k8s" 不该带出 "k8s-prod"
        assert [kb.name for kb in page.items] == ["带 k8s 的"]

    async def test_no_match_returns_empty(self, sessionmaker):
        await seed_kb(sessionmaker, "a", "库", tags=["运维"])

        async with sessionmaker() as db:
            page = await list_kbs(db, USER_A, tag="不存在")

        assert page.items == []
        assert page.total == 0


class TestCopy:
    async def test_copies_definition_and_config(self, sessionmaker):
        await seed_kb(sessionmaker, "a", "原库", tags=["运维"])

        async with sessionmaker() as db:
            clone = await copy_kb(db, "a", USER_A)
            await db.commit()

        assert clone.name == "原库 副本"
        assert clone.id != "a"
        assert clone.tags == ["运维"]
        assert clone.config.chunk_size == CONFIG["chunk_size"]

    async def test_does_not_copy_documents(self, sessionmaker):
        await seed_kb(sessionmaker, "a", "原库")
        async with sessionmaker() as db:
            db.add(KnowledgeBaseDocument(
                id="d1", kb_id="a", name="文档.md", type="md", size_bytes=1,
                status="indexed", storage_path="/tmp/d.md",
            ))
            await db.commit()

        async with sessionmaker() as db:
            clone = await copy_kb(db, "a", USER_A)
            await db.commit()

        async with sessionmaker() as db:
            docs = (await db.execute(
                select(KnowledgeBaseDocument).where(KnowledgeBaseDocument.kb_id == clone.id)
            )).scalars().all()
        assert docs == [], "复制只复制定义，文档要用户自己再传"

    async def test_duplicate_names_are_numbered(self, sessionmaker):
        await seed_kb(sessionmaker, "a", "原库")
        await seed_kb(sessionmaker, "b", "原库 副本")

        async with sessionmaker() as db:
            clone = await copy_kb(db, "a", USER_A)
            await db.commit()

        assert clone.name == "原库 副本(2)"

    async def test_explicit_name_is_used(self, sessionmaker):
        await seed_kb(sessionmaker, "a", "原库")

        async with sessionmaker() as db:
            clone = await copy_kb(db, "a", USER_A, "新名字")

        assert clone.name == "新名字"

    async def test_other_users_kb_cannot_be_copied(self, sessionmaker):
        await seed_kb(sessionmaker, "a", "别人的库", user_id=USER_B)

        async with sessionmaker() as db:
            with pytest.raises(HTTPException) as exc:
                await copy_kb(db, "a", USER_A)

        assert exc.value.status_code == 404


class TestExport:
    async def test_export_carries_format_and_config(self, sessionmaker):
        await seed_kb(sessionmaker, "a", "导出的库", tags=["运维"])

        async with sessionmaker() as db:
            payload = await export_kb_config(db, "a", USER_A)

        assert payload["format"] == "ke-hermes.knowledge-base.config"
        assert payload["version"] == 1
        assert payload["knowledge_base"]["name"] == "导出的库"
        assert payload["knowledge_base"]["tags"] == ["运维"]
        assert payload["knowledge_base"]["config"]["chunk_size"] == CONFIG["chunk_size"]
        assert "exported_at" in payload

    async def test_export_needs_read_access(self, sessionmaker):
        await seed_kb(sessionmaker, "a", "别人的库", user_id=USER_B)

        async with sessionmaker() as db:
            with pytest.raises(HTTPException) as exc:
                await export_kb_config(db, "a", USER_A)

        assert exc.value.status_code == 404


class TestGroups:
    async def test_create_and_list(self, sessionmaker):
        async with sessionmaker() as db:
            group = await create_group(db, USER_A, "产品资料")
            await db.commit()

        assert group["name"] == "产品资料"
        async with sessionmaker() as db:
            groups = await list_groups(db, USER_A)
        assert [g["name"] for g in groups] == ["产品资料"]

    async def test_duplicate_name_is_rejected(self, sessionmaker):
        async with sessionmaker() as db:
            await create_group(db, USER_A, "产品资料")
            await db.commit()

        async with sessionmaker() as db:
            with pytest.raises(HTTPException) as exc:
                await create_group(db, USER_A, "产品资料")

        assert exc.value.status_code == 409

    async def test_same_name_allowed_for_another_user(self, sessionmaker):
        async with sessionmaker() as db:
            await create_group(db, USER_A, "产品资料")
            await db.commit()
        async with sessionmaker() as db:
            group = await create_group(db, USER_B, "产品资料")
            await db.commit()

        assert group["name"] == "产品资料"

    async def test_assign_and_count(self, sessionmaker):
        await seed_kb(sessionmaker, "a", "库")
        async with sessionmaker() as db:
            group = await create_group(db, USER_A, "产品资料")
            await db.commit()
        async with sessionmaker() as db:
            kb = await assign_kb_group(db, "a", USER_A, group["id"])
            await db.commit()

        assert kb.group_id == group["id"]
        async with sessionmaker() as db:
            groups = await list_groups(db, USER_A)
        assert groups[0]["kb_count"] == 1

    async def test_cannot_assign_to_another_users_group(self, sessionmaker):
        await seed_kb(sessionmaker, "a", "库")
        async with sessionmaker() as db:
            group = await create_group(db, USER_B, "别人的分组")
            await db.commit()

        async with sessionmaker() as db:
            with pytest.raises(HTTPException) as exc:
                await assign_kb_group(db, "a", USER_A, group["id"])

        assert exc.value.status_code == 404

    async def test_filter_list_by_group(self, sessionmaker):
        await seed_kb(sessionmaker, "a", "甲库")
        await seed_kb(sessionmaker, "b", "乙库")
        async with sessionmaker() as db:
            group = await create_group(db, USER_A, "产品资料")
            await db.commit()
        async with sessionmaker() as db:
            await assign_kb_group(db, "a", USER_A, group["id"])
            await db.commit()

        async with sessionmaker() as db:
            page = await list_kbs(db, USER_A, group_id=group["id"])
        assert [kb.name for kb in page.items] == ["甲库"]

        # 未归组的库不会被这个筛选带出来
        async with sessionmaker() as db:
            page_all = await list_kbs(db, USER_A)
        assert len(page_all.items) == 2

    async def test_delete_group_keeps_the_knowledge_base(self, sessionmaker):
        """删分组只解除归属——库里是用户的数据资产。"""
        await seed_kb(sessionmaker, "a", "库")
        async with sessionmaker() as db:
            group = await create_group(db, USER_A, "产品资料")
            await db.commit()
        async with sessionmaker() as db:
            await assign_kb_group(db, "a", USER_A, group["id"])
            await db.commit()

        async with sessionmaker() as db:
            await delete_group(db, USER_A, group["id"])
            await db.commit()

        async with sessionmaker() as db:
            kb = (await db.execute(
                select(KnowledgeBase).where(KnowledgeBase.id == "a")
            )).scalar_one()
            groups = await list_groups(db, USER_A)
        assert kb is not None, "删分组不能把库删了"
        assert kb.group_id is None
        assert groups == []

    async def test_rename_group(self, sessionmaker):
        async with sessionmaker() as db:
            group = await create_group(db, USER_A, "旧名")
            await db.commit()
        async with sessionmaker() as db:
            renamed = await rename_group(db, USER_A, group["id"], "新名")
            await db.commit()

        assert renamed["name"] == "新名"
