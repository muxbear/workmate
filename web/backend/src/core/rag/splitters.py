"""文本切片器——策略模式。

支持 5 种切片策略：fixed / recursive / semantic / markdown / agentic。

``agentic`` 需要 LLM 判定主题边界，因此除同步的 :meth:`ChunkStrategy.split`
外还提供 :meth:`ChunkStrategy.async_split`；索引流水线走异步路径，同步路径保留
给既有调用方。
"""

import asyncio
import json
import logging
import re
from abc import ABC, abstractmethod

from langchain_core.documents import Document

logger = logging.getLogger(__name__)

#: 切片相关默认值——单一事实来源。
#: 此前三处默认值互不相同（IndexConfigSchema=512、IndexingPipeline=1024、
#: 本模块=1000），配置缺字段时会切出长度迥异的分片。IndexConfigSchema 的同名列
#: 必须与这里保持一致（由 tests/unit_tests/test_index_defaults.py 守护）。
INDEX_CONFIG_DEFAULTS = {
    "chunk_size": 512,
    "chunk_overlap": 64,
}


class ChunkStrategy(ABC):
    """文本切片策略抽象接口。"""

    @abstractmethod
    def split(self, documents: list[Document]) -> list[Document]:
        """将文档列表切分为更小的分片。"""
        ...

    async def async_split(self, documents: list[Document]) -> list[Document]:
        """异步切片——默认把同步实现放到线程池执行。

        阻塞式策略（langchain 各 splitter）不需要覆写；需要网络调用的策略
        （如 agentic）应覆写本方法以避免阻塞事件循环。
        """
        return await asyncio.to_thread(self.split, documents)


class FixedChunkStrategy(ChunkStrategy):
    """固定长度切片。"""

    def __init__(self, chunk_size: int = 1000, chunk_overlap: int = 200):
        self._chunk_size = chunk_size
        self._chunk_overlap = chunk_overlap

    def split(self, documents: list[Document]) -> list[Document]:
        from langchain_text_splitters import CharacterTextSplitter
        splitter = CharacterTextSplitter(
            separator="\n\n", chunk_size=self._chunk_size,
            chunk_overlap=self._chunk_overlap,
        )
        return splitter.split_documents(documents)


class RecursiveChunkStrategy(ChunkStrategy):
    """递归分隔符切片——按段落→换行→句号→空格递归切分。"""

    def __init__(self, chunk_size: int = 1000, chunk_overlap: int = 200):
        self._chunk_size = chunk_size
        self._chunk_overlap = chunk_overlap

    def split(self, documents: list[Document]) -> list[Document]:
        from langchain_text_splitters import RecursiveCharacterTextSplitter
        splitter = RecursiveCharacterTextSplitter(
            chunk_size=self._chunk_size, chunk_overlap=self._chunk_overlap,
            separators=["\n\n", "\n", "。", ".", " ", ""],
        )
        return splitter.split_documents(documents)


class SemanticChunkStrategy(ChunkStrategy):
    """语义切片——基于 embedding 向量相似度自动确定主题边界。"""

    def __init__(self, chunk_size: int = 1000, chunk_overlap: int = 200,
                 embedding_model=None):
        if embedding_model is None:
            raise ValueError("语义切分策略需要一个嵌入模型。")
        self._chunk_size = chunk_size
        self._chunk_overlap = chunk_overlap
        self._embedding_model = embedding_model

    def split(self, documents: list[Document]) -> list[Document]:
        from langchain_experimental.text_splitter import SemanticChunker
        splitter = SemanticChunker(
            embeddings=self._embedding_model,
            breakpoint_threshold_type="percentile",
        )
        return splitter.split_documents(documents)


class MarkdownChunkStrategy(ChunkStrategy):
    """Markdown 结构切片——按标题层级切分。"""

    def split(self, documents: list[Document]) -> list[Document]:
        from langchain_text_splitters import MarkdownHeaderTextSplitter
        splitter = MarkdownHeaderTextSplitter(
            headers_to_split_on=[
                ("#", "h1"), ("##", "h2"), ("###", "h3"), ("####", "h4"),
            ],
            strip_headers=True,
        )
        results: list[Document] = []
        for doc in documents:
            chunks = splitter.split_text(doc.page_content)
            for i, chunk in enumerate(chunks):
                chunk.metadata.update(doc.metadata)
                chunk.metadata["chunk_index"] = i
            results.extend(chunks)
        return results


class AgenticChunkStrategy(ChunkStrategy):
    """Agentic 智能切片——由 LLM 判断段落之间的主题边界。

    算法（按文档逐个处理）：

    1. 按空行切段；
    2. 将段落累积进缓冲区，达到 ``chunk_size`` 预算时询问 LLM：缓冲区内部的哪个
       段落边界是"主题切换点"；
    3. 在 LLM 指出的边界处断开；LLM 未给出可用边界时退化为按预算硬切（保证
       chunk 不会无限增长）；
    4. 按 ``chunk_overlap`` 把上一片尾部段落带入下一片，保持上下文连续。

    成本：每个产出的分片约一次 LLM 调用（可离线用假 LLM 测试）。LLM 不可用时
    **不会**使索引失败——流水线会回退到递归切片（见
    ``IndexingPipeline._get_or_create_chunk_registry``）。
    """

    _SYSTEM_PROMPT = (
        "你是文档切片助手。给定若干按顺序编号的段落，判断哪些位置属于「主题切换点」"
        "（即相邻两段在讲不同的主题）。只输出 JSON，不要解释。"
    )

    def __init__(
        self,
        llm=None,
        chunk_size: int = 512,
        chunk_overlap: int = 64,
        hard_cap_ratio: float = 1.5,
    ):
        self._llm = llm
        self._chunk_size = max(1, chunk_size)
        self._chunk_overlap = max(0, chunk_overlap)
        self._hard_cap_ratio = max(1.0, hard_cap_ratio)

    # ── 公共接口 ────────────────────────────────────────────────────────

    def split(self, documents: list[Document]) -> list[Document]:
        """同步切片——无运行中的事件循环时直接驱动异步实现。"""
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(self.async_split(documents))
        raise RuntimeError(
            "AgenticChunkStrategy.split 不能在事件循环内同步调用，请改用 await async_split()"
        )

    async def async_split(self, documents: list[Document]) -> list[Document]:
        """异步切片——按文档逐段与 LLM 交互。"""
        results: list[Document] = []
        for doc in documents:
            results.extend(await self._split_document(doc))
        return results

    # ── 内部实现 ────────────────────────────────────────────────────────

    async def _split_document(self, doc: Document) -> list[Document]:
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", doc.page_content or "") if p.strip()]
        if not paragraphs:
            return []

        chunks: list[str] = []
        buffer: list[str] = []
        # 缓冲区头部有多少段来自上一片的重叠——用于保证每次切分都产出新内容
        carry_count = 0

        for paragraph in paragraphs:
            buffer.append(paragraph)
            if self._buffer_length(buffer) < self._chunk_size:
                continue
            # 缓冲区里只有重叠段 + 当前段时无法再切，继续累积（否则会切出重复内容）
            if len(buffer) <= carry_count + 1:
                continue

            head, tail = await self._split_buffer(buffer, min_cut=carry_count + 1)
            chunks.append(head)
            buffer = self._with_overlap(head, tail)
            carry_count = len(buffer) - len(tail)

        if buffer:
            chunks.append("\n\n".join(buffer))

        return [
            Document(
                page_content=text,
                metadata={**doc.metadata, "chunk_index": i, "splitter": "agentic"},
            )
            for i, text in enumerate(chunks)
            if text.strip()
        ]

    async def _split_buffer(
        self, buffer: list[str], min_cut: int = 1,
    ) -> tuple[str, list[str]]:
        """把超预算的缓冲区切成 (本片文本, 余下段落)。

        优先采用 LLM 给出的主题边界；不可用时按预算硬切，保证分片长度有上界。

        Args:
            buffer: 待切分段落。
            min_cut: 切分点下界——至少要在重叠段之后再切一段，否则本片将只包含
                上一片的重复内容。
        """
        boundary = await self._ask_boundary(buffer)
        if boundary is not None and max(min_cut, 1) <= boundary < len(buffer):
            return "\n\n".join(buffer[:boundary]), buffer[boundary:]

        cut = max(self._hard_cut_index(buffer), min_cut)
        cut = min(cut, len(buffer))
        if cut <= 0:
            cut = len(buffer)
        return "\n\n".join(buffer[:cut]), buffer[cut:]

    async def _ask_boundary(self, buffer: list[str]) -> int | None:
        """询问 LLM 主题边界，返回"在此段之后断开"的段落下标；失败返回 None。"""
        if self._llm is None:
            return None

        numbered = "\n\n".join(
            f"[{i}] {text}" for i, text in enumerate(buffer)
        )
        prompt = (
            f"段落列表（共 {len(buffer)} 段）：\n\n{numbered}\n\n"
            "请输出 JSON：{\"boundaries\": [i, ...]}，其中 i 表示第 i 段与第 i+1 段"
            "之间应断开。若整体属于同一主题则输出 {\"boundaries\": []}。"
        )

        try:
            answer = await self._llm.acomplete(prompt, system=self._SYSTEM_PROMPT)
        except Exception:
            logger.warning("Agentic 切片调用 LLM 失败，回退硬切", exc_info=True)
            return None
        if not answer:
            return None

        boundaries = parse_boundaries(answer, len(buffer))
        if not boundaries:
            return None
        # 取最靠近预算上限的边界，避免第一片过短
        return max(b for b in boundaries if 0 < b < len(buffer))

    def _hard_cut_index(self, buffer: list[str]) -> int:
        """按预算硬切：在不超过硬上限的前提下尽量多放段落。"""
        hard_cap = self._chunk_size * self._hard_cap_ratio
        index = 1
        total = len(buffer[0])
        while index < len(buffer):
            candidate = total + len(buffer[index]) + 2
            if candidate > hard_cap and index >= 1:
                break
            total = candidate
            index += 1
        return index

    def _with_overlap(self, head: str, tail: list[str]) -> list[str]:
        """把上一片尾部段落带入下一片，使分片之间保留上下文。"""
        if self._chunk_overlap <= 0 or not tail:
            return tail
        carry: list[str] = []
        budget = self._chunk_overlap
        for paragraph in reversed(head.split("\n\n")):
            if len(paragraph) > budget:
                break
            carry.insert(0, paragraph)
            budget -= len(paragraph)
        return carry + tail

    @staticmethod
    def _buffer_length(buffer: list[str]) -> int:
        return sum(len(text) for text in buffer) + 2 * max(0, len(buffer) - 1)


def parse_boundaries(answer: str, paragraph_count: int) -> list[int]:
    """从 LLM 回复中解析边界下标，过滤非法值。

    容忍常见的输出噪声（```json 代码块、前后解释文字），解析失败返回空列表。
    """
    if not answer:
        return []

    match = re.search(r"\{.*\}", answer, re.DOTALL)
    if match is None:
        return []
    try:
        payload = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    if not isinstance(payload, dict):
        return []

    raw = payload.get("boundaries")
    if not isinstance(raw, list):
        return []

    boundaries: list[int] = []
    for item in raw:
        try:
            value = int(item)
        except (TypeError, ValueError):
            continue
        if 0 < value < paragraph_count:
            boundaries.append(value)
    return sorted(set(boundaries))


class ChunkStrategyRegistry:
    """切片策略注册表。"""

    def __init__(self):
        self._strategies: dict[str, ChunkStrategy] = {}

    def register(self, name: str, strategy: ChunkStrategy) -> None:
        self._strategies[name] = strategy

    def get(self, name: str) -> ChunkStrategy:
        if name not in self._strategies:
            available = ", ".join(sorted(self._strategies)) or "(空)"
            raise ValueError(
                f"不支持的切片策略 '{name}'（可用: {available}）。"
                "提示：agentic 需要先在「模型」页面配置可用的 LLM。"
            )
        return self._strategies[name]

    def supports(self, name: str) -> bool:
        """判断策略是否已注册。"""
        return name in self._strategies

    def split(self, name: str, documents: list[Document]) -> list[Document]:
        return self.get(name).split(documents)

    async def async_split(self, name: str, documents: list[Document]) -> list[Document]:
        """异步切片——索引流水线使用（agentic 策略需要 wait LLM）。"""
        return await self.get(name).async_split(documents)


def create_chunk_registry(config: dict, embedding_model=None, llm=None) -> ChunkStrategyRegistry:
    """根据索引配置创建切片注册表。

    仅注册依赖可用的策略（semantic 需要 embedding，agentic 需要 llm）。配置里的
    ``chunk_strategy`` / ``chunk_size`` / ``chunk_overlap`` 会被读取：此前工厂只
    用 ``{chunk_size, chunk_overlap}`` 且调用方传空字典，导致这三个配置项被忽略。
    """
    chunk_size = int(config.get("chunk_size") or INDEX_CONFIG_DEFAULTS["chunk_size"])
    chunk_overlap = int(config.get("chunk_overlap") or INDEX_CONFIG_DEFAULTS["chunk_overlap"])

    registry = ChunkStrategyRegistry()
    registry.register("fixed", FixedChunkStrategy(chunk_size, chunk_overlap))
    registry.register("recursive", RecursiveChunkStrategy(chunk_size, chunk_overlap))
    registry.register("markdown", MarkdownChunkStrategy())

    if embedding_model is not None:
        registry.register("semantic", SemanticChunkStrategy(chunk_size, chunk_overlap, embedding_model))

    if llm is not None:
        registry.register("agentic", AgenticChunkStrategy(llm, chunk_size, chunk_overlap))

    return registry
