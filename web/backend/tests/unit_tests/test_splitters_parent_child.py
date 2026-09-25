"""Tests for 父子块切片与最小块长合并（迭代 3 T3.1）。

父子块（Small-to-Big）的动机：chunk 太小则语义被切断（实测出现过"只有标题"的
碎片切片并排到检索首位），太大则检索精度下降。策略是**用子块匹配、返回父块
上下文**——子块把父块正文写进元数据，检索侧据此替换返回内容。

最小块长合并解决另一类碎片：标题行、代码片段边界等产生的极短切片。
"""

import pytest
from langchain_core.documents import Document

from core.rag.splitters import (
    INDEX_CONFIG_DEFAULTS,
    ParentChildChunkStrategy,
    create_chunk_registry,
    merge_short_chunks,
)

pytestmark = pytest.mark.anyio


def _doc(text: str, **metadata) -> Document:
    return Document(page_content=text, metadata=dict(metadata))


class TestParentChildStrategy:
    def _split(self, text: str, child_size=200, parent_size=600) -> list[Document]:
        strategy = ParentChildChunkStrategy(
            chunk_size=child_size, chunk_overlap=0, parent_chunk_size=parent_size,
        )
        return strategy.split([_doc(text, source="a.md")])

    def test_children_are_smaller_than_parents(self):
        text = "".join(f"第{i}段的内容。" * 6 for i in range(40))
        chunks = self._split(text)

        assert len(chunks) > 1
        parents = {c.metadata["parent_id"] for c in chunks}
        assert len(parents) > 1
        # 每个子块都不超过子块预算，父块也不超过父块预算
        assert all(len(c.page_content) <= 220 for c in chunks)
        assert all(len(c.metadata["parent_text"]) <= 660 for c in chunks)

    def test_every_child_carries_its_parent_text(self):
        text = "".join(f"第{i}段的内容。" * 6 for i in range(40))
        chunks = self._split(text)

        by_parent: dict[str, list[Document]] = {}
        for chunk in chunks:
            by_parent.setdefault(chunk.metadata["parent_id"], []).append(chunk)

        for parent_id, children in by_parent.items():
            parent_text = children[0].metadata["parent_text"]
            assert parent_text
            # 同一父块下的子块共享同一段父块正文
            assert all(c.metadata["parent_text"] == parent_text for c in children)
            # 子块正文确实来自父块正文
            assert all(c.page_content in parent_text for c in children)

    def test_parent_index_is_sequential(self):
        text = "".join(f"第{i}段的内容。" * 6 for i in range(40))
        chunks = self._split(text)

        order: list[int] = []
        for chunk in chunks:
            index = chunk.metadata["parent_index"]
            if not order or order[-1] != index:
                order.append(index)
        assert order == sorted(order)
        assert order[0] == 0

    def test_document_metadata_is_preserved(self):
        chunks = self._split("内容。" * 60)
        assert all(c.metadata["source"] == "a.md" for c in chunks)

    def test_parent_is_at_least_twice_the_child(self):
        """父块预算小于子块时自动上抬——否则"父块"没有意义。"""
        strategy = ParentChildChunkStrategy(
            chunk_size=500, chunk_overlap=0, parent_chunk_size=100,
        )
        assert strategy._parent_size >= 1000  # type: ignore[attr-defined]


class TestShortChunkMerging:
    def test_short_chunks_merge_into_previous(self):
        long_a = "这是足够长的正文内容，超过最小块长阈值，应当独立成块，不被合并。"
        long_b = "这是另一段足够长的正文内容，同样超过最小块长阈值，保持独立不被合并。"
        assert len(long_a) >= 32 and len(long_b) >= 32, "语料必须真的超过阈值"
        chunks = [_doc(long_a), _doc("短"), _doc(long_b)]

        merged = merge_short_chunks(chunks, min_size=32)

        assert len(merged) == 2
        assert "短" in merged[0].page_content

    def test_leading_short_chunk_merges_forward(self):
        chunks = [_doc("标题"), _doc("这是足够长的正文内容，超过最小块长阈值，应当独立成块。")]

        merged = merge_short_chunks(chunks, min_size=32)

        assert len(merged) == 1
        assert merged[0].page_content.startswith("标题")

    def test_leading_short_chunk_updates_parent_text(self):
        """首片并入后一片时，父块正文也要包含首片内容。"""
        head = _doc("标题")
        body = _doc("正文" * 30, parent_id="p0", parent_text="正文" * 30)

        merged = merge_short_chunks([head, body], min_size=32)

        assert merged[0].metadata["parent_text"].startswith("标题")

    def test_disabled_when_zero(self):
        chunks = [_doc("短"), _doc("也短")]
        assert merge_short_chunks(chunks, min_size=0) == chunks

    def test_untouched_when_all_long_enough(self):
        chunks = [_doc("第一段正文内容足够长，不应该被合并。" * 2) for _ in range(3)]
        assert len(merge_short_chunks(chunks, min_size=32)) == 3


class TestRegistryIntegration:
    def test_parent_child_is_registered(self):
        registry = create_chunk_registry({})
        assert registry.supports("parent_child")

    def test_registry_applies_min_size_merge(self):
        """走注册表时要按配置的最小块长合并碎片。"""
        registry = create_chunk_registry({"chunk_strategy": "recursive", "min_chunk_size": 32})
        chunks = registry.split("recursive", [_doc("标题\n\n" + "正文内容。" * 20)])

        assert all(len(c.page_content) >= 32 for c in chunks)

    def test_registry_configures_parent_size(self):
        registry = create_chunk_registry({"parent_chunk_size": 2048})
        strategy = registry.get("parent_child")
        assert strategy._parent_size == 2048  # type: ignore[attr-defined]

    def test_defaults_are_exposed(self):
        assert INDEX_CONFIG_DEFAULTS["parent_chunk_size"] == 1536
        assert INDEX_CONFIG_DEFAULTS["min_chunk_size"] == 32

    def test_min_size_zero_disables_merging(self):
        """同一份输入：关闭合并保留短章节，开启合并把它并入上一块。

        用 markdown 策略构造——按标题切分天然会产生"只有标题的短小节"，
        正是最小块长要处理的碎片。
        """
        text = "# 章节\n\n" + "正文内容。" * 40 + "\n\n## 小结\n\n短"

        without_merge = create_chunk_registry({"min_chunk_size": 0}).split(
            "markdown", [_doc(text)],
        )
        with_merge = create_chunk_registry({"min_chunk_size": 32}).split(
            "markdown", [_doc(text)],
        )

        assert len(without_merge) == 2
        assert len(without_merge[1].page_content) < 32
        assert len(with_merge) == 1


class TestParentExpansionInRetrieval:
    """检索侧：命中子块时返回父块正文。"""

    def test_content_is_replaced_by_parent_text(self):
        from api.knowledge_base.search_service import _content_for_result

        chunk = {
            "chunk_text": "子块正文",
            "metadata_": {"parent_id": "p0", "parent_text": "父块完整正文"},
        }

        content, expanded = _content_for_result(chunk)

        assert content == "父块完整正文"
        assert expanded is True

    def test_without_parent_text_returns_child(self):
        from api.knowledge_base.search_service import _content_for_result

        content, expanded = _content_for_result(
            {"chunk_text": "正文", "metadata_": {"h1": "第一章"}},
        )

        assert content == "正文"
        assert expanded is False

    def test_chroma_json_string_metadata_is_supported(self):
        """Chroma 把元数据存成 JSON 字符串，同样要能取到父块正文。"""
        from api.knowledge_base.search_service import _content_for_result

        content, expanded = _content_for_result({
            "chunk_text": "子块",
            "metadata_": '{"parent_text": "父块正文"}',
        })

        assert content == "父块正文"
        assert expanded is True


class TestMarkdownParentSplitting:
    """Markdown 文档按标题小节切父块，保留标题层级元数据。"""

    def _split(self, text: str) -> list[Document]:
        return ParentChildChunkStrategy(
            chunk_size=200, chunk_overlap=0, parent_chunk_size=600,
        ).split([_doc(text)])

    def test_parents_follow_headings(self):
        text = (
            "# 第一章\n\n" + "第一章正文。" * 30
            + "\n\n## 第一节\n\n" + "第一节正文。" * 30
        )
        chunks = self._split(text)

        parents = {c.metadata["parent_text"] for c in chunks}
        assert any("第一章" in p for p in parents)
        assert any("第一节" in p for p in parents)

    def test_headings_are_kept_in_parent_text(self):
        """strip_headers=False：标题行留在父块正文里，父块自解释。"""
        chunks = self._split("# 标题甲\n\n" + "正文。" * 80)
        assert any(c.metadata["parent_text"].startswith("# 标题甲") for c in chunks)

    def test_children_carry_heading_metadata(self):
        """子块要带上 h1/h2 —— 引用里的"章节"靠它。"""
        text = "# 章一\n\n" + "正文。" * 60 + "\n\n## 节二\n\n" + "内容。" * 60
        chunks = self._split(text)

        sections = {c.metadata.get("h1") for c in chunks}
        assert "章一" in sections
        assert any(c.metadata.get("h2") == "节二" for c in chunks)

    def test_oversized_section_is_split_further(self):
        """超长小节要再按递归切，父块不能无上界。"""
        chunks = self._split("# 超长章节\n\n" + "很长的正文内容。" * 200)

        parents = {c.metadata["parent_text"] for c in chunks}
        assert all(len(p) <= 700 for p in parents)
        assert len(parents) > 1

    def test_plain_text_falls_back_to_recursive(self):
        chunks = self._split("没有标题的纯文本。" * 60)
        assert chunks
        assert all(c.metadata["parent_id"].startswith("p") for c in chunks)


class TestParentMetadataPersistence:
    """父块信息必须写进向量库元数据，否则检索侧拿不到父块正文。"""

    async def test_embedding_state_persists_parent_keys(self):
        from api.knowledge_base.doc_state import EmbeddingState, IndexingContext

        stored: list = []

        class RecordingStore:
            async def add_documents(self, kb_id, documents, embeddings, target=None):
                stored.extend(documents)
                return []

        class FakeEmbeddings:
            async def aembed_documents(self, texts, on_batch=None):
                vectors = [[0.1, 0.2] for _ in texts]
                if on_batch is not None:
                    await on_batch(0, texts, vectors)
                return vectors

        class FakePipeline:
            vector_store = RecordingStore()
            embedding_model = FakeEmbeddings()

        ctx = IndexingContext(
            doc_id="doc-1", kb_id="kb-1", file_path="/tmp/a.md", file_type="md",
            config={},
        )
        ctx.chunks = [
            _doc("子块正文", parent_id="p0", parent_index=0, parent_text="父块完整正文"),
        ]

        # 向量化与写入是同一步（T4.3 的分批写入），因此这里驱动 EmbeddingState
        await EmbeddingState().handle(ctx, FakePipeline())  # type: ignore[arg-type]

        meta = stored[0].metadata["metadata_"]
        assert meta["parent_text"] == "父块完整正文"
        assert meta["parent_id"] == "p0"
