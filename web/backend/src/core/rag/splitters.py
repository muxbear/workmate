"""文本切片器——策略模式。

支持 6 种切片策略：fixed / recursive / semantic / markdown / agentic / parent_child。

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

#: 判定文本是否带 Markdown 标题（决定父块按标题小节切还是按递归切）
_MARKDOWN_HEADING = re.compile(r"^#{1,4}\s+\S", re.MULTILINE)

#: 切片相关默认值——单一事实来源。
#: 此前三处默认值互不相同（IndexConfigSchema=512、IndexingPipeline=1024、
#: 本模块=1000），配置缺字段时会切出长度迥异的分片。IndexConfigSchema 的同名列
#: 必须与这里保持一致（由 tests/unit_tests/test_index_defaults.py 守护）。
INDEX_CONFIG_DEFAULTS = {
    "chunk_size": 512,
    "chunk_overlap": 64,
    #: 父块大小（仅 parent_child 策略使用）
    "parent_chunk_size": 1536,
    #: 最小块长：低于该长度的切片会并入相邻块，避免"只有标题"的碎片进入索引
    "min_chunk_size": 32,
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


class ParentChildChunkStrategy(ChunkStrategy):
    """父子块切片（Small-to-Big）——**用子块匹配，返回父块作为上下文**。

    动机：chunk 太小则语义被切断（实测出现过"只有标题"的切片并排到首位），
    太大则检索精度下降。父子块把两者分开：

    - **子块**（``chunk_size``，默认 512 字符）参与向量化与匹配，精度高；
    - **父块**（``parent_chunk_size``，默认 1536 字符）承载完整上下文，命中子块后
      由检索层返回父块正文。

    子块把父块正文写进 ``metadata_.parent_text``，父块 ID 写在 ``parent_id``——
    检索侧据此替换返回内容，不需要额外的父块集合或二次查询。

    父子边界：Markdown 文档**按标题小节切父块**（小节过长时再按递归切），其他文档
    用递归分隔符切父块；然后在父块内部切子块。这样既拿到子块的高匹配精度，又保留
    标题层级元数据（h1~h4）——引用里的"章节"才不会丢。
    父块之间**不设重叠**（重叠只用于子块，父块重复会在存储里成倍放大文本）。
    """

    def __init__(
        self,
        chunk_size: int = 512,
        chunk_overlap: int = 64,
        parent_chunk_size: int = 1536,
    ):
        self._child_size = chunk_size
        self._child_overlap = chunk_overlap
        # 父块至少比子块大，否则"父块"没有意义
        self._parent_size = max(parent_chunk_size, chunk_size * 2)

    def _recursive(self, chunk_size: int, chunk_overlap: int):
        from langchain_text_splitters import RecursiveCharacterTextSplitter

        return RecursiveCharacterTextSplitter(
            chunk_size=chunk_size, chunk_overlap=chunk_overlap,
            separators=["\n\n", "\n", "。", ".", " ", ""],
        )

    def _split_parents(self, doc: Document) -> list[Document]:
        """切父块：Markdown 按标题小节，其他按递归分隔符。"""
        text = doc.page_content or ""
        if not _MARKDOWN_HEADING.search(text):
            pieces = self._recursive(self._parent_size, 0).split_text(text)
            return [
                Document(page_content=piece, metadata=dict(doc.metadata))
                for piece in pieces
            ]

        from langchain_text_splitters import MarkdownHeaderTextSplitter

        # strip_headers=False：标题行留在父块正文里，父块自解释
        sections = MarkdownHeaderTextSplitter(
            headers_to_split_on=[("#", "h1"), ("##", "h2"), ("###", "h3"), ("####", "h4")],
            strip_headers=False,
        ).split_text(text)

        parents: list[Document] = []
        for section in sections:
            metadata = {**doc.metadata, **section.metadata}
            body = section.page_content or ""
            if len(body) <= self._parent_size:
                parents.append(Document(page_content=body, metadata=metadata))
                continue
            # 小节过长：再按递归切，避免父块无上界
            for piece in self._recursive(self._parent_size, 0).split_text(body):
                parents.append(Document(page_content=piece, metadata=dict(metadata)))
        return parents

    def split(self, documents: list[Document]) -> list[Document]:
        child_splitter = self._recursive(self._child_size, self._child_overlap)

        results: list[Document] = []
        parent_index = 0
        for doc in documents:
            for parent in self._split_parents(doc):
                parent_text = parent.page_content or ""
                if not parent_text.strip():
                    continue
                parent_id = f"p{parent_index}"
                parent_index += 1
                for child in child_splitter.split_text(parent_text):
                    if not child.strip():
                        continue
                    results.append(Document(
                        page_content=child,
                        metadata={
                            **parent.metadata,
                            "parent_id": parent_id,
                            "parent_index": parent_index - 1,
                            "parent_text": parent_text,
                        },
                    ))
        return results


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


def merge_short_chunks(chunks: list[Document], min_size: int) -> list[Document]:
    """把长度低于 ``min_size`` 的分片并入相邻分片。

    动机：实测有"只有标题"的碎片切片（如「一、部署MySql主从」）排到检索首位——
    它几乎不含内容却被当成一条结果。合并策略：优先并入**前**一片（顺序阅读体验
    更自然），首片则并入后一片；并入时保留前片的元数据。

    Args:
        chunks: 切片列表（顺序敏感）。
        min_size: 最小字符数；<=0 表示不合并。

    Returns:
        合并后的切片列表（可能为空）。
    """
    if min_size <= 0 or not chunks:
        return chunks

    merged: list[Document] = []
    for chunk in chunks:
        text = chunk.page_content or ""
        if len(text) < min_size and merged:
            # 并入前一片：正文拼接，元数据保持前一片（定位仍指向该分片起点）
            previous = merged[-1]
            previous.page_content = f"{previous.page_content}{text}"
            continue
        merged.append(chunk)

    # 首片过短时并入后一片
    if len(merged) > 1 and len(merged[0].page_content or "") < min_size:
        head = merged.pop(0)
        merged[0].page_content = f"{head.page_content}{merged[0].page_content}"
        # 后一片的元数据来自它自己；但若它有 parent_text，需把首片正文并进父块
        parent_text = merged[0].metadata.get("parent_text")
        if parent_text is not None:
            merged[0].metadata["parent_text"] = f"{head.page_content}{parent_text}"

    return merged


class ChunkStrategyRegistry:
    """切片策略注册表。"""

    def __init__(self, min_chunk_size: int = 0):
        self._strategies: dict[str, ChunkStrategy] = {}
        #: 低于该长度的分片会被合并（见 merge_short_chunks）
        self._min_chunk_size = min_chunk_size

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
        chunks = self.get(name).split(documents)
        return merge_short_chunks(chunks, self._min_chunk_size)

    async def async_split(self, name: str, documents: list[Document]) -> list[Document]:
        """异步切片——索引流水线使用（agentic 策略需要 wait LLM）。"""
        chunks = await self.get(name).async_split(documents)
        return merge_short_chunks(chunks, self._min_chunk_size)


def create_chunk_registry(config: dict, embedding_model=None, llm=None) -> ChunkStrategyRegistry:
    """根据索引配置创建切片注册表。

    仅注册依赖可用的策略（semantic 需要 embedding，agentic 需要 llm）。配置里的
    ``chunk_strategy`` / ``chunk_size`` / ``chunk_overlap`` 会被读取：此前工厂只
    用 ``{chunk_size, chunk_overlap}`` 且调用方传空字典，导致这三个配置项被忽略。
    """
    chunk_size = int(config.get("chunk_size") or INDEX_CONFIG_DEFAULTS["chunk_size"])
    chunk_overlap = int(config.get("chunk_overlap") or INDEX_CONFIG_DEFAULTS["chunk_overlap"])

    parent_size = int(
        config.get("parent_chunk_size") or INDEX_CONFIG_DEFAULTS["parent_chunk_size"]
    )
    min_size = int(
        config.get("min_chunk_size")
        if config.get("min_chunk_size") is not None
        else INDEX_CONFIG_DEFAULTS["min_chunk_size"]
    )

    registry = ChunkStrategyRegistry(min_chunk_size=min_size)
    registry.register("fixed", FixedChunkStrategy(chunk_size, chunk_overlap))
    registry.register("recursive", RecursiveChunkStrategy(chunk_size, chunk_overlap))
    registry.register("markdown", MarkdownChunkStrategy())
    # 父子块不依赖外部服务，始终可用
    registry.register(
        "parent_child",
        ParentChildChunkStrategy(chunk_size, chunk_overlap, parent_size),
    )

    if embedding_model is not None:
        registry.register("semantic", SemanticChunkStrategy(chunk_size, chunk_overlap, embedding_model))

    if llm is not None:
        registry.register("agentic", AgenticChunkStrategy(llm, chunk_size, chunk_overlap))

    return registry
