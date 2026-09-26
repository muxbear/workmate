"""图谱查询层：归一后的分组、稳定节点身份与实体详情（迭代 6 T6.5）。

**这个文件是 `graph_service` 查询层的首次覆盖**——此前该模块的读函数、`_persist`
与三个 `/graph` 路由全无后端用例，只有 `test_indexing_pipeline.py` 里的状态级 stub。

要盯住的是三件实测出来的事：

1. `LangChain` 与 `langchain` 各占一个节点（归一后应合成一个）；
2. `mentions` 恒为 1，而界面按它显示「N 次」并决定节点大小——改为"多少篇文档提到"；
3. 节点 id 与详情接口的入参口径不同，"点节点看详情"在构造上就是断的——两边统一
   到归一键。
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from api.knowledge_base.entity_norm import (
    ENTITY_TYPES,
    LEGACY_TYPE_MAP,
    normalize_name,
)
from api.knowledge_base.graph_service import (
    _EXTRACTION_EXAMPLES,
    _EXTRACTION_PROMPT,
    get_entity_detail,
    get_graph_data,
)
from db.models.knowledge_base import KnowledgeBase
from db.models.knowledge_base_document import KnowledgeBaseDocument
from db.models.knowledge_base_entity import KnowledgeBaseEntity
from db.models.knowledge_base_relation import KnowledgeBaseRelation

pytestmark = pytest.mark.anyio

KB = "kb-a"


@pytest.fixture
async def maker():
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        for model in (
            KnowledgeBase,
            KnowledgeBaseDocument,
            KnowledgeBaseEntity,
            KnowledgeBaseRelation,
        ):
            await conn.run_sync(model.__table__.create)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


def _entity(
    name: str,
    *,
    doc_id: str,
    type_: str = "概念",
    mentions: int = 1,
    id_: str | None = None,
) -> KnowledgeBaseEntity:
    """造一行实体。``name_key`` 按写侧同一函数算——测试不该手写键。"""
    return KnowledgeBaseEntity(
        id=id_ or f"e-{abs(hash((name, doc_id, type_))) % 10**8}",
        kb_id=KB,
        doc_id=doc_id,
        name=name,
        name_key=normalize_name(name),
        type=type_,
        mentions=mentions,
    )


def _relation(
    from_name: str,
    to_name: str,
    *,
    doc_id: str,
    label: str = "使用",
    weight: float = 1.0,
) -> KnowledgeBaseRelation:
    return KnowledgeBaseRelation(
        id=f"r-{abs(hash((from_name, to_name, label, doc_id))) % 10**8}",
        kb_id=KB,
        doc_id=doc_id,
        from_entity=from_name,
        to_entity=to_name,
        from_key=normalize_name(from_name),
        to_key=normalize_name(to_name),
        label=label,
        weight=weight,
    )


class TestVocabularyWiring:
    """提示词与词表必须同源——此前三处各写一份（提示词 12 类、设计文档 8 类、前端 5 类）。"""

    def test_prompt_whitelist_is_derived_from_the_vocabulary(self):
        assert "、".join(ENTITY_TYPES) in _EXTRACTION_PROMPT

    def test_whitelist_line_offers_exactly_the_vocabulary(self):
        """白名单那一行只能给出 8 类。

        注意**不能**用"提示词里不出现旧类型名"来断言：提示词里有一行归类指引
        （"软件框架、模型…归产品"）会正当提到那些词——它是在说它们**归属于**哪一类，
        不是在把它们列为合法类型。所以要精确断言白名单那一行。
        """
        whitelist_lines = [
            line
            for line in _EXTRACTION_PROMPT.splitlines()
            if "实体类型必须是以下之一" in line
        ]
        assert len(whitelist_lines) == 1, "白名单行应当只有一条"

        offered = {
            part.strip()
            for part in whitelist_lines[0]
            .split(":", 1)[1]
            .replace("。", "")
            .split("、")
        }
        assert offered == set(ENTITY_TYPES), f"白名单与词表不一致: {sorted(offered)}"
        for legacy in LEGACY_TYPE_MAP:
            assert legacy not in offered, f"白名单仍提供已废弃的类型 {legacy}"

    def test_few_shot_examples_only_use_vocabulary_types(self):
        """示例是模型真正模仿的东西——示例越界，白名单形同虚设。"""
        used = {
            e["attributes"]["type"]
            for example in _EXTRACTION_EXAMPLES
            for e in example["extractions"]
            if e["extraction_class"] == "entity"
        }
        assert used <= set(ENTITY_TYPES), (
            f"示例里出现越界类型: {sorted(used - set(ENTITY_TYPES))}"
        )


class TestEntityGrouping:
    async def test_case_variants_merge_into_one_node(self, maker):
        """实测缺陷的直接回归：`LangChain` 与 `langchain` 此前是两个节点。"""
        async with maker() as db:
            db.add_all(
                [
                    _entity("LangChain", doc_id="doc-1"),
                    _entity("langchain", doc_id="doc-2"),
                    _entity("OpenAI", doc_id="doc-1"),
                ]
            )
            await db.commit()
            data = await get_graph_data(db, KB)

        names = sorted(e["name"] for e in data["entities"])
        assert len(data["entities"]) == 2, f"大小写变体未合并: {names}"
        assert normalize_name("LangChain") in {e["id"] for e in data["entities"]}

    async def test_node_id_is_the_normalized_key(self, maker):
        """节点 id 必须是归一键——它是"点节点取详情"能对上的前提。"""
        async with maker() as db:
            db.add(_entity("  LangChain  ", doc_id="doc-1"))
            await db.commit()
            data = await get_graph_data(db, KB)

        assert [e["id"] for e in data["entities"]] == ["langchain"]

    async def test_display_name_keeps_original_casing(self, maker):
        """展示名不归一，否则 `LangChain` 会显示成 `langchain`。"""
        async with maker() as db:
            db.add(_entity("LangChain", doc_id="doc-1"))
            await db.commit()
            data = await get_graph_data(db, KB)

        assert data["entities"][0]["name"] == "LangChain"

    async def test_same_name_in_two_docs_is_one_node(self, maker):
        """跨文档的同一实体合并成一个节点，文档数计入 mentions。"""
        async with maker() as db:
            db.add_all(
                [
                    _entity("Milvus", doc_id="doc-1"),
                    _entity("Milvus", doc_id="doc-2"),
                ]
            )
            await db.commit()
            data = await get_graph_data(db, KB)

        assert len(data["entities"]) == 1
        assert data["entities"][0]["mentions"] == 2

    async def test_rows_without_name_key_still_group(self, maker):
        """兜底路径：迁移前写入的行（name_key 为空）也不能丢。

        兜底只折大小写与两端空白（可移植的 `lower(trim())`），不折内部空白——它不是
        归一规则的第二份实现，只是不让那几行落进同一个空键节点。
        """
        async with maker() as db:
            db.add(
                KnowledgeBaseEntity(
                    id="legacy-1",
                    kb_id=KB,
                    doc_id="doc-1",
                    name="Legacy",
                    name_key=None,
                    type="概念",
                    mentions=1,
                )
            )
            await db.commit()
            data = await get_graph_data(db, KB)

        assert [e["id"] for e in data["entities"]] == ["legacy"]
        assert data["entities"][0]["name"] == "Legacy"


class TestMentions:
    async def test_mentions_counts_documents_not_rows(self, maker):
        """`mentions` = 多少篇文档提到它。

        行是按 (库, 文档, 名) 存的，所以"文档数"是这份数据真正能支撑的语义。
        此前是 sum(mentions)，而那个值恒为 1（写侧同文档内去重 + 每次重抽先删行）。
        """
        async with maker() as db:
            db.add_all(
                [
                    _entity("RAG", doc_id="doc-1", mentions=1),
                    _entity("RAG", doc_id="doc-2", mentions=1),
                    _entity("RAG", doc_id="doc-3", mentions=1),
                ]
            )
            await db.commit()
            data = await get_graph_data(db, KB)

        assert data["entities"][0]["mentions"] == 3

    async def test_same_document_twice_does_not_double_count(self, maker):
        """同一文档里的两行（理论上不该有，但历史数据可能有）只算一篇。"""
        async with maker() as db:
            db.add_all(
                [
                    _entity("RAG", doc_id="doc-1", id_="e1"),
                    _entity("RAG", doc_id="doc-1", id_="e2"),
                ]
            )
            await db.commit()
            data = await get_graph_data(db, KB)

        assert data["entities"][0]["mentions"] == 1


class TestRelations:
    async def test_relations_group_by_key_and_sum_weight(self, maker):
        """两个只差大小写的端点会并成一条边——归一后 85 条里有 1 组正是这种情况。"""
        async with maker() as db:
            db.add_all(
                [
                    _relation("LangChain", "OpenAI", doc_id="doc-1", label="使用"),
                    _relation("langchain", "openai", doc_id="doc-2", label="使用"),
                ]
            )
            await db.commit()
            data = await get_graph_data(db, KB)

        assert len(data["relations"]) == 1
        assert data["relations"][0]["weight"] == 2.0
        assert (data["relations"][0]["from_key"], data["relations"][0]["to_key"]) == (
            "langchain",
            "openai",
        )

    async def test_different_labels_stay_separate(self, maker):
        """分组键含 label——同一对实体可以有多种关系。"""
        async with maker() as db:
            db.add_all(
                [
                    _relation("A", "B", doc_id="doc-1", label="使用"),
                    _relation("A", "B", doc_id="doc-1", label="包含"),
                ]
            )
            await db.commit()
            data = await get_graph_data(db, KB)

        assert len(data["relations"]) == 2

    async def test_edge_endpoints_always_exist_as_nodes(self, maker):
        """边不许 dangle：端点键必须能在节点集里找到。

        此前节点 id 是 `min(行 id)`、边端点是另一套分组下的 `min(source_entity_id)`，
        两者对不上时前端会把边**静默丢掉**（useKnowledgeGraph 的过滤）。
        """
        async with maker() as db:
            db.add_all(
                [
                    _entity("LangChain", doc_id="doc-1"),
                    _entity("openai", doc_id="doc-1"),
                    _relation("LangChain", "OpenAI", doc_id="doc-1"),
                ]
            )
            await db.commit()
            data = await get_graph_data(db, KB)

        node_ids = {e["id"] for e in data["entities"]}
        for rel in data["relations"]:
            assert rel["from_key"] in node_ids, (
                f"边的起点 {rel['from_key']} 不在节点集里"
            )
            assert rel["to_key"] in node_ids, f"边的终点 {rel['to_key']} 不在节点集里"

    async def test_response_no_longer_carries_dangling_ids(self, maker):
        """`source_entity_id`/`target_entity_id` 已从响应里去掉——它们是 dangle 的根源。"""
        async with maker() as db:
            db.add_all(
                [
                    _entity("A", doc_id="doc-1"),
                    _entity("B", doc_id="doc-1"),
                    _relation("A", "B", doc_id="doc-1"),
                ]
            )
            await db.commit()
            data = await get_graph_data(db, KB)

        assert "source_entity_id" not in data["relations"][0]
        assert "target_entity_id" not in data["relations"][0]


class TestTypeFilter:
    async def test_filter_keeps_only_that_type(self, maker):
        async with maker() as db:
            db.add_all(
                [
                    _entity("张三", doc_id="doc-1", type_="人物"),
                    _entity("Milvus", doc_id="doc-1", type_="产品"),
                ]
            )
            await db.commit()
            data = await get_graph_data(db, KB, entity_type="人物")

        assert [e["name"] for e in data["entities"]] == ["张三"]


class TestEntityDetail:
    async def test_lookup_by_normalized_key(self, maker):
        """入参是归一键——这正是"点节点取详情"此前对不上的地方。"""
        async with maker() as db:
            db.add_all(
                [
                    _entity("LangChain", doc_id="doc-1"),
                    _entity("langchain", doc_id="doc-2"),
                ]
            )
            await db.commit()
            detail = await get_entity_detail(db, KB, "langchain")

        assert detail is not None
        assert detail["id"] == "langchain"
        assert detail["mentions"] == 2
        assert len(detail["documents"]) == 2

    async def test_accepts_any_casing_of_the_key(self, maker):
        """前端传回来的键可能大小写不一，入口统一归一。"""
        async with maker() as db:
            db.add(_entity("LangChain", doc_id="doc-1"))
            await db.commit()

            assert await get_entity_detail(db, KB, "LANGCHAIN") is not None

    async def test_returns_source_documents(self, maker):
        """详情要能说明"这个实体出自哪几篇文档"——面板此前看不到这个。"""
        async with maker() as db:
            db.add_all(
                [
                    KnowledgeBaseDocument(
                        id="doc-1",
                        kb_id=KB,
                        name="方案.md",
                        type="md",
                        storage_path="/tmp/a.md",
                    ),
                    _entity("Milvus", doc_id="doc-1"),
                ]
            )
            await db.commit()
            detail = await get_entity_detail(db, KB, "milvus")

        assert detail is not None
        assert detail["documents"] == [{"id": "doc-1", "name": "方案.md"}]

    async def test_includes_both_directions_of_relations(self, maker):
        async with maker() as db:
            db.add_all(
                [
                    _entity("A", doc_id="doc-1"),
                    _entity("B", doc_id="doc-1"),
                    _entity("C", doc_id="doc-1"),
                    _relation("A", "B", doc_id="doc-1", label="指向"),
                    _relation("C", "A", doc_id="doc-1", label="指向"),
                ]
            )
            await db.commit()
            detail = await get_entity_detail(db, KB, "a")

        assert detail is not None
        assert len(detail["relations"]) == 2

    async def test_unknown_key_returns_none(self, maker):
        async with maker() as db:
            db.add(_entity("Milvus", doc_id="doc-1"))
            await db.commit()

            assert await get_entity_detail(db, KB, "不存在的实体") is None
            assert await get_entity_detail(db, KB, "") is None

    async def test_other_kb_is_not_visible(self, maker):
        """跨库不可见——路由层的越权用例依赖这个前提。"""
        async with maker() as db:
            db.add(_entity("Milvus", doc_id="doc-1"))
            await db.commit()

            assert await get_entity_detail(db, "kb-other", "milvus") is None
