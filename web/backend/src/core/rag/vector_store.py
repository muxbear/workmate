"""向量数据库抽象层——策略模式。

统一 Milvus 和 Chroma 的操作接口，支持向量检索和 BM25 稀疏检索。

**打分口径约定**：本层所有检索返回 ``(chunk_id, score)`` 且 **score 一律为
"越大越相关"**——向量侧已把各后端的距离统一换算为余弦相似度，稀疏侧为
BM25 得分。上层（``search_service``）依赖该约定做融合与展示。

混合检索（RRF 融合）由 ``api.knowledge_base.search_service._fuse_scores`` 统一
实现，本层不再提供 ``hybrid_search``，避免两套融合公式产生分歧。
"""

import asyncio
import hashlib
import logging
import re
import uuid
from abc import ABC, abstractmethod
from typing import Any

from langchain_core.documents import Document

from core.rag.bm25 import (
    SPARSE_ALGO_BM25,
    BM25Index,
    SparseConfig,
    SparseIndexCache,
    bm25_search_with_fallback,
    create_sparse_scorer,
)

logger = logging.getLogger(__name__)

#: HNSW 搜索宽度下界——Milvus 要求 ef >= limit，否则整次检索报错
_HNSW_MIN_EF = 64

#: Milvus 表达式允许的 ID 形态——UUID 与类 UUID 标识符（字母数字、``-``、``_``）。
#: Milvus 的 expr 没有参数化绑定，只能把值拼进表达式字符串，因此进入表达式之前
#: 必须先做白名单校验：``chunk_id='x" or id != "'`` 这类输入会构造出
#: ``id == "x" or id != ""``，从而读到/删掉整个 collection 的切片。
#: 用 ``fullmatch``（而不是 ``re.match`` + ``$``）——``$`` 会匹配结尾换行符，
#: 使 ``"x\\n"`` 这样的值通过校验。
_SAFE_ID_PATTERN = re.compile(r"[0-9a-zA-Z_-]{1,64}")

#: 切片 ID 的命名空间——``uuid5(namespace, f"{doc_id}:{chunk_index}")``。
#: **确定性 ID 是入库幂等的前提**：此前每片都是随机 uuid4，同一文档重复索引一次就
#: 多出一份切片（内容相同、ID 不同），库内计数虚高、检索结果重复。现在同一个
#: (文档, 切片号) 永远得到同一个 ID，配合 upsert 写入即为"覆盖"而非"追加"。
_CHUNK_ID_NAMESPACE = uuid.UUID("6f5b0f0e-7a1c-5b2e-9a10-2f4d8c3e5a71")


def chunk_id_for(doc_id: str, chunk_index: int) -> str:
    """由 (文档, 切片号) 推导切片 ID——幂等键。"""
    return str(uuid.uuid5(_CHUNK_ID_NAMESPACE, f"{doc_id}:{chunk_index}"))


def chunk_content_hash(text: str) -> str:
    """切片正文的内容哈希——用于判断"内容是否变过"（增量索引的基础）。"""
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()[:32]

#: 原生稀疏检索用到的字段名 / 函数名（Milvus 侧的 schema 约定）
_SPARSE_FIELD = "sparse"
_SPARSE_FUNCTION = "chunk_text_bm25"

#: 换名式重建用到的临时后缀——先建 `xxx__new`，成功后与正式集合换名
_STAGING_SUFFIX = "__new"
_TRASH_SUFFIX = "__old"

#: ``chunk_text`` 的分析器配置——**必须显式指定中文分析器**。
#: Milvus 默认的 standard 分析器按空白与标点切词，中文整句会变成一个大 token，
#: 结果是"BM25 对中文完全无效"（能建索引、能查询，但查什么都是低分）。
#: ``type: chinese`` 使用 jieba 分词，与客户端 :mod:`core.rag.text_analyzer` 同源。
_ANALYZED_TEXT_FIELD: dict[str, Any] = {
    "enable_analyzer": True,
    "analyzer_params": {"type": "chinese"},
}


def _sparse_index_params(sparse_params: dict[str, float] | None) -> dict[str, float]:
    """把知识库的 BM25 参数整理成 Milvus 稀疏索引参数。"""
    params: dict[str, float] = {}
    if not sparse_params:
        return params
    k1 = sparse_params.get("bm25_k1")
    b = sparse_params.get("bm25_b")
    if isinstance(k1, (int, float)):
        params["bm25_k1"] = float(k1)
    if isinstance(b, (int, float)):
        params["bm25_b"] = float(b)
    return params


def safe_expr_id(value: str, field: str = "id") -> str:
    """校验并返回可安全嵌入 Milvus 表达式的 ID。

    Args:
        value: 待校验的 ID（切片 / 文档 / 知识库主键）。
        field: 出参报错信息里使用的字段名。

    Returns:
        原样返回的 ID（已确认只含字母数字与 ``-``/``_``）。

    Raises:
        ValueError: ID 为空、超长或包含引号 / 空格 / 换行 / 运算符等字符。
    """
    if not isinstance(value, str) or not _SAFE_ID_PATTERN.fullmatch(value):
        raise ValueError(f"非法的 {field}: {value!r}")
    return value


class BaseVectorStore(ABC):
    """向量数据库抽象接口（策略模式）。"""

    @staticmethod
    async def run_sync(func: Any, /, *args: Any, **kwargs: Any) -> Any:
        """把**同步阻塞**的向量库调用丢到线程池执行。

        pymilvus 与 chromadb 的对外 API 都是同步的：直接在 ``async def`` 里调用
        等于在事件循环里做网络 IO 与本地计算。实测最严重的是 BM25 的全量语料扫描
        ——**2967ms 期间整个异步服务停摆**（期间所有 HTTP 请求、SSE 推送、健康检查
        全部卡住）。所有对向量库的调用都必须经过这里。

        为什么不用 ``asyncio.to_thread`` 直接写在调用点：调用点有几十处，散落的
        ``to_thread`` 一旦漏掉一处就退化成"偶发卡死"，很难测出来；收敛到一个入口
        才能靠 grep 审计。
        """
        return await asyncio.to_thread(func, *args, **kwargs)

    @abstractmethod
    async def create_collection(
        self, kb_id: str, dim: int, enable_bm25: bool = True,
        sparse_params: dict[str, float] | None = None,
    ) -> None:
        """为知识库创建 Collection。

        Args:
            kb_id: 知识库 ID。
            dim: 向量维度。
            enable_bm25: 是否建立**原生稀疏检索**所需的字段与索引。
            sparse_params: 稀疏索引参数（``bm25_k1`` / ``bm25_b``）。原生 BM25 的
                k1/b 在建索引时固化在索引里，因此必须在建集合时传入——否则改了配置
                只能靠重建集合才能生效。
        """

    @abstractmethod
    async def delete_collection(self, kb_id: str) -> None:
        """删除知识库对应的 Collection。"""

    @abstractmethod
    async def add_documents(
        self, kb_id: str, documents: list[Document], embeddings: list[list[float]]
    ) -> list[str]:
        """将文档向量写入向量数据库，返回 chunk ID 列表。"""

    @abstractmethod
    async def delete_by_doc_id(self, kb_id: str, doc_id: str) -> None:
        """按文档 ID 删除所有相关向量。"""

    @abstractmethod
    async def get_chunks_by_doc_id(self, kb_id: str, doc_id: str) -> list[dict]:
        """按文档 ID 查询所有切片，按 chunk_index 排序。"""

    @abstractmethod
    async def get_chunks_by_ids(
        self, kb_id: str, chunk_ids: list[str], include_embeddings: bool = False,
    ) -> list[dict]:
        """按切片 ID 列表批量查询切片详情。

        Args:
            include_embeddings: 返回结果里附带 ``embedding`` 字段。检索侧的去冗余
                （相似度去重 / MMR）需要候选向量，直接从库里取比重新 embedding 便宜。
        """

    @abstractmethod
    async def delete_chunk_by_id(self, kb_id: str, chunk_id: str) -> None:
        """按切片 ID 删除单个切片。"""

    @abstractmethod
    async def update_chunk(
        self, kb_id: str, chunk_id: str, new_text: str,
        new_embedding: list[float],
    ) -> None:
        """更新切片文本和向量（必须保留切片原有元数据）。"""

    @abstractmethod
    async def similarity_search(
        self, kb_id: str, query_embedding: list[float], top_k: int,
        doc_ids: list[str] | None = None,
        doc_types: list[str] | None = None,
    ) -> list[tuple[str, float]]:
        """向量相似度搜索，返回 (chunk_id, 余弦相似度)，越大越相关。

        Args:
            doc_ids: 只在这些文档内检索（``None`` 表示不限）。
            doc_types: 只在这些文件类型内检索（``None`` 表示不限）。

        过滤在**检索时**生效（而非事后筛结果），因此不会因为"前 K 条都不符合
        过滤条件"而漏掉本该命中的切片。
        """

    @staticmethod
    def _build_filter_expr(
        doc_ids: list[str] | None, doc_types: list[str] | None,
    ) -> str:
        """构造 Milvus 过滤表达式（供两个后端复用，Chroma 侧自行转换）。"""
        clauses: list[str] = []
        if doc_ids:
            ids = ", ".join(f'"{safe_expr_id(x, "doc_id")}"' for x in doc_ids)
            clauses.append(f"doc_id in [{ids}]")
        if doc_types:
            types = ", ".join(f'"{safe_expr_id(t, "doc_type")}"' for t in doc_types)
            clauses.append(f"doc_type in [{types}]")
        return " and ".join(clauses)

    @abstractmethod
    async def bm25_search(
        self, kb_id: str, query: str, top_k: int,
        sparse_config: SparseConfig | None = None,
    ) -> list[tuple[str, float]]:
        """BM25 稀疏检索，返回 (chunk_id, BM25 得分)，越大越相关。

        Args:
            sparse_config: 稀疏算法与 k1/b 参数；缺省用 bm25 默认参数。
        """

    async def _sparse_search(
        self, index: BM25Index, query: str, top_k: int, cfg: SparseConfig,
    ) -> list[tuple[str, float]]:
        """BM25 检索 + 同义词兜底（两个后端共用）。

        **必须走线程池**：客户端 BM25 是全量语料打分（O(N) Python 循环），
        万级切片就是几百毫秒到几秒的纯 CPU——留在事件循环里等于让整个服务停摆
        （实测单次 2967ms）。真正的解法是 T4.2 的倒排索引，这里先保证不阻塞。
        """
        return await self.run_sync(
            bm25_search_with_fallback, index, query, top_k, cfg,
        )

    async def _build_sparse_index(self, kb_id: str) -> BM25Index:
        """构建（或复用缓存中的）BM25 语料索引。子类需实现 :meth:`_fetch_corpus`。

        **按知识库加锁 + 双重检查**：并发查询同一知识库时，"查缓存 → 拉全量语料 →
        建索引"会被重复执行 N 次（每次都把整库语料拉一遍、分词一遍）。冷启动或刚
        写完库时最容易踩到（此时缓存必然为空）。

        本方法只服务于**回退路径**（老集合没有原生稀疏字段、或 bm25_plus / tf_idf
        这类原生不支持的算法）；主路径由 Milvus 原生稀疏检索承担。
        """
        cached = self._sparse_cache.get(kb_id)
        if cached is not None:
            return cached

        lock = self._sparse_locks.setdefault(kb_id, asyncio.Lock())
        async with lock:
            # 等锁期间可能已有别的协程建好了，再查一次
            cached = self._sparse_cache.get(kb_id)
            if cached is not None:
                return cached
            corpus = await self._fetch_corpus(kb_id)
            # 建索引同样是对全量语料的 CPU 计算（分词 + 倒排 + df 统计）
            index = await self.run_sync(BM25Index.build, corpus)
            self._sparse_cache.put(kb_id, index)
            return index

    @abstractmethod
    async def _fetch_corpus(self, kb_id: str) -> list[tuple[str, str]]:
        """拉取 ``(chunk_id, chunk_text)`` 全量语料，供 BM25 统计 df / avgdl。

        Milvus 需用 query_iterator 避免默认查询窗口截断，Chroma 直接全量 get。
        """



class MilvusVectorStore(BaseVectorStore):
    """基于 Milvus 的向量数据库实现。

    Collection 命名规则: kb_{kb_id}。Schema 含 dense ``embedding`` 与稀疏 ``sparse``
    两个向量字段：``sparse`` 由 **BM25 Function** 从 ``chunk_text`` 自动生成，
    查询侧走 Milvus 原生稀疏检索（见 :meth:`bm25_search`）。

    为什么必须用原生稀疏检索：此前的客户端实现要把**全量语料**拉进进程、建全库词频
    统计、每查询做 O(N) Python 打分——万级切片就不可用，且内存随语料线性增长。
    原生路径把这些都放在服务端（倒排索引），客户端只发一条查询。

    兼容：老 collection 没有 ``sparse`` 字段（建立在本次改动之前），探测不到时自动
    回退到客户端实现；``bm25_plus`` / ``tf_idf`` 两种算法 Milvus 原生不支持，同样
    走客户端实现。回退路径保留但只作为兜底——重建一次索引即可切到原生路径。
    """

    @staticmethod
    def _collection_name(kb_id: str) -> str:
        """将 kb_id 转为合法的 Milvus 集合名（只允许字母数字下划线）。"""
        return f"kb_{kb_id.replace('-', '_')}"

    def __init__(self, uri: str, user: str, password: str, db_name: str = "ke_hermes"):
        self._uri = uri
        self._user = user
        self._password = password
        self._db_name = db_name
        self._connected = False
        self._collections: dict[str, Any] = {}
        self._sparse_cache = SparseIndexCache()
        #: 按知识库的建索引锁——并发查询时不重复拉全量语料（见 _build_sparse_index）
        self._sparse_locks: dict[str, asyncio.Lock] = {}
        #: 知识库 → (是否有原生稀疏字段, 稀疏索引参数)；None 表示尚未探测
        self._native_sparse: dict[str, tuple[bool, dict[str, Any]] | None] = {}

    async def _ensure_connected(self):
        if self._connected:
            return
        try:
            from pymilvus import connections
            await self.run_sync(
                connections.connect,
                alias="default",
                uri=self._uri,
                user=self._user,
                password=self._password,
                db_name=self._db_name,
            )
            self._connected = True
            logger.info("Milvus connected: %s, db=%s", self._uri, self._db_name)
        except Exception as e:
            logger.error("Milvus connection failed: %s", e)
            raise

    async def create_collection(
        self, kb_id: str, dim: int, enable_bm25: bool = True,
        sparse_params: dict[str, float] | None = None,
    ) -> None:
        await self._ensure_connected()
        collection_name = self._collection_name(kb_id)

        try:
            from pymilvus import utility

            await self._recover_interrupted_swap(collection_name)

            # 先在**临时名字**下把新集合建好，成功之后再替换：
            # 此前是"先删旧集合、再建新的"——删除之后任何一步失败（维度不对、
            # 服务端拒绝稀疏参数、建索引超时）都意味着**旧数据已经没了且不可恢复**。
            # 现在建失败时旧集合原封不动，调用方如实拿到异常即可。
            staging = f"{collection_name}{_STAGING_SUFFIX}"
            if await self.run_sync(utility.has_collection, staging):
                logger.warning("清理上次残留的临时集合: %s", staging)
                await self.run_sync(utility.drop_collection, staging)
                await self._await_collection_gone(staging)

            collection = await self._build_collection(
                staging, kb_id, dim, enable_bm25, sparse_params,
            )

            # 换名：旧 → 回收站，临时 → 正式，再删回收站。
            # 中途崩溃可在下次调用时由 _recover_interrupted_swap 收拾。
            trash = f"{collection_name}{_TRASH_SUFFIX}"
            if await self.run_sync(utility.has_collection, collection_name):
                if await self.run_sync(utility.has_collection, trash):
                    await self.run_sync(utility.drop_collection, trash)
                    await self._await_collection_gone(trash)
                await self.run_sync(
                    utility.rename_collection, collection_name, trash,
                )
            await self.run_sync(utility.rename_collection, staging, collection_name)

            if await self.run_sync(utility.has_collection, trash):
                await self.run_sync(utility.drop_collection, trash)

            # 换名后原句柄指向的名字已经不存在了，按正式名重新取一个
            from pymilvus import Collection
            collection = await self.run_sync(Collection, name=collection_name)
            await self.run_sync(collection.load)
            self._collections[kb_id] = collection
            self._sparse_cache.invalidate(kb_id)
            self._native_sparse.pop(kb_id, None)
            logger.info("Milvus collection created: %s (dim=%d)", collection_name, dim)

        except Exception as e:
            logger.error("Failed to create Milvus collection kb=%s: %s", kb_id, e)
            raise

    async def _build_collection(
        self, name: str, kb_id: str, dim: int, enable_bm25: bool,
        sparse_params: dict[str, float] | None,
    ) -> Any:
        """按当前 schema 建一个集合（含 dense / 稀疏 / 标量索引）并加载。"""
        from pymilvus import (
            Collection,
            CollectionSchema,
            DataType,
            FieldSchema,
            Function,
            FunctionType,
        )

        fields = [
            FieldSchema(name="id", dtype=DataType.VARCHAR, is_primary=True, max_length=36),
            FieldSchema(name="doc_id", dtype=DataType.VARCHAR, max_length=36),
            FieldSchema(name="kb_id", dtype=DataType.VARCHAR, max_length=36),
            FieldSchema(name="chunk_index", dtype=DataType.INT64),
            FieldSchema(name="chunk_text", dtype=DataType.VARCHAR, max_length=65535,
                        **(_ANALYZED_TEXT_FIELD if enable_bm25 else {})),
            FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=dim),
            FieldSchema(name="doc_name", dtype=DataType.VARCHAR, max_length=256),
            FieldSchema(name="doc_type", dtype=DataType.VARCHAR, max_length=16),
            FieldSchema(name="metadata_", dtype=DataType.JSON),
            FieldSchema(name="created_at", dtype=DataType.INT64),
        ]
        functions = []
        if enable_bm25:
            # 稀疏向量由 BM25 Function 从 chunk_text 自动生成——**不要**在写入时
            # 显式提供该字段（Milvus 会直接报错 "unexpected function output field"）
            fields.append(FieldSchema(name=_SPARSE_FIELD, dtype=DataType.SPARSE_FLOAT_VECTOR))
            functions.append(Function(
                name=_SPARSE_FUNCTION,
                function_type=FunctionType.BM25,
                input_field_names=["chunk_text"],
                output_field_names=[_SPARSE_FIELD],
                params={},
            ))

        schema = CollectionSchema(
            fields=fields, functions=functions, description=f"Knowledge base: {kb_id}",
        )
        collection = await self.run_sync(Collection, name=name, schema=schema)

        await self.run_sync(
            collection.create_index,
            field_name="embedding",
            index_params={
                "metric_type": "COSINE",
                "index_type": "HNSW",
                "params": {"M": 16, "efConstruction": 200},
            },
        )

        if enable_bm25:
            # k1/b 固化在索引里，因此建集合时必须带上知识库配置的参数
            await self.run_sync(
                collection.create_index,
                field_name=_SPARSE_FIELD,
                index_params={
                    "index_type": "SPARSE_INVERTED_INDEX",
                    "metric_type": "BM25",
                    "params": {
                        "inverted_index_algo": "DAAT_MAXSCORE",
                        **_sparse_index_params(sparse_params),
                    },
                },
            )

        for field_name in ["doc_id", "kb_id"]:
            await self.run_sync(
                collection.create_index,
                field_name=field_name,
                index_params={"index_type": "INVERTED"},
            )

        await self.run_sync(collection.load)
        return collection

    async def _await_collection_gone(self, name: str) -> None:
        """等待集合真正消失——删除是异步传播的，紧接着用同名建/改名会报"已存在"。"""
        from pymilvus import utility

        for _ in range(20):
            if not await self.run_sync(utility.has_collection, name):
                return
            await asyncio.sleep(0.5)
        logger.warning("集合 %s 删除后仍未消失，继续尝试后续操作", name)

    async def _recover_interrupted_swap(self, collection_name: str) -> None:
        """收拾上次换名中途失败留下的残局。

        换名是两步（正式 → 回收站、临时 → 正式），中间崩溃会留下两种状态：
        - 只有临时集合：正式集合还在，丢掉临时即可；
        - 正式集合缺失、数据在回收站里：**把回收站改回正式名**——这一步是回滚，
          不是清理。少了它，用户会看到"库还在、但检索什么都搜不到"。
        """
        from pymilvus import utility

        staging = f"{collection_name}{_STAGING_SUFFIX}"
        trash = f"{collection_name}{_TRASH_SUFFIX}"
        has_live = await self.run_sync(utility.has_collection, collection_name)
        has_staging = await self.run_sync(utility.has_collection, staging)
        has_trash = await self.run_sync(utility.has_collection, trash)

        if not has_live and has_trash:
            logger.warning(
                "检测到上次换名中断：把 %s 恢复为 %s", trash, collection_name,
            )
            await self.run_sync(utility.rename_collection, trash, collection_name)
            has_trash = False
        if has_staging and has_live:
            logger.warning("清理上次残留的临时集合: %s", staging)
            await self.run_sync(utility.drop_collection, staging)
            await self._await_collection_gone(staging)
        if has_trash:
            await self.run_sync(utility.drop_collection, trash)

    async def delete_collection(self, kb_id: str) -> None:
        await self._ensure_connected()
        collection_name = self._collection_name(kb_id)
        try:
            from pymilvus import utility
            await self.run_sync(utility.drop_collection, collection_name)
            self._collections.pop(kb_id, None)
            self._sparse_cache.invalidate(kb_id)
            self._native_sparse.pop(kb_id, None)
            logger.info("Milvus collection deleted: %s", collection_name)
        except Exception as e:
            logger.error("Failed to delete Milvus collection %s: %s", collection_name, e)

    async def add_documents(
        self, kb_id: str, documents: list[Document], embeddings: list[list[float]]
    ) -> list[str]:
        """写入切片——**幂等**：ID 由 (doc_id, chunk_index) 推导，重复写入即覆盖。

        此前 ID 是随机 uuid4 + ``insert``：同一文档被索引两次就多一份切片（内容
        相同、ID 不同），库内计数虚高且检索结果重复。现在改用确定性 ID + upsert，
        同一个 (文档, 切片号) 永远落成同一行——重试、重复入队、断点续传都不会
        产生重复数据。
        """
        await self._ensure_connected()
        import time

        collection = await self._get_collection(kb_id)
        now_ms = int(time.time() * 1000)

        chunk_ids: list[str] = []
        data = []
        for i, doc in enumerate(documents):
            doc_id = doc.metadata.get("doc_id", "")
            chunk_index = doc.metadata.get("chunk_index", i)
            chunk_id = chunk_id_for(doc_id, int(chunk_index))
            chunk_ids.append(chunk_id)
            metadata = dict(doc.metadata.get("metadata_", {}) or {})
            # 内容哈希随元数据落库：它是"内容有没有变"的唯一可靠依据，
            # 也是后续增量索引（只重算变了的切片）的基础
            metadata["content_hash"] = chunk_content_hash(doc.page_content)
            data.append({
                "id": chunk_id,
                "doc_id": doc_id,
                "kb_id": kb_id,
                "chunk_index": int(chunk_index),
                "chunk_text": doc.page_content[:65535],
                "embedding": embeddings[i],
                "doc_name": doc.metadata.get("doc_name", ""),
                "doc_type": doc.metadata.get("doc_type", ""),
                "metadata_": metadata,
                "created_at": now_ms,
            })

        await self.run_sync(collection.upsert, data)
        await self._prune_stale_tail(collection, kb_id, documents)
        await self.run_sync(collection.flush)
        self._sparse_cache.invalidate(kb_id)
        logger.info("Milvus upserted %d chunks for kb=%s", len(data), kb_id)
        return chunk_ids

    async def _prune_stale_tail(
        self, collection: Any, kb_id: str, documents: list[Document],
    ) -> None:
        """删掉超出本次写入范围的旧切片（文档变短时的残留）。

        幂等键是 (doc_id, chunk_index)，因此写入只是"覆盖同号切片"——如果同一文档
        这次切出的片数比上次少（换了切片策略、原文删减），**多出来的尾部切片不会被
        覆盖**，会以旧内容留在库里继续被检索到。这里按本次各文档的最大切片号收口。
        """
        max_index: dict[str, int] = {}
        for i, doc in enumerate(documents):
            doc_id = doc.metadata.get("doc_id", "")
            if not doc_id:
                continue
            index = int(doc.metadata.get("chunk_index", i))
            max_index[doc_id] = max(max_index.get(doc_id, -1), index)

        for doc_id, highest in max_index.items():
            expr = (
                f'doc_id == "{safe_expr_id(doc_id, "doc_id")}" '
                f"and chunk_index > {highest}"
            )
            await self.run_sync(collection.delete, expr)

    async def delete_by_doc_id(self, kb_id: str, doc_id: str) -> None:
        collection = await self._get_collection(kb_id)
        await self.run_sync(
            collection.delete, f'doc_id == "{safe_expr_id(doc_id, "doc_id")}"',
        )
        await self.run_sync(collection.flush)
        self._sparse_cache.invalidate(kb_id)
        logger.info("Milvus deleted chunks for doc=%s in kb=%s", doc_id, kb_id)

    async def _get_collection(self, kb_id: str) -> Any:
        """获取或加载 Milvus Collection。"""
        await self._ensure_connected()
        collection = self._collections.get(kb_id)
        if collection is None:
            from pymilvus import Collection

            collection = await self.run_sync(
                Collection, name=self._collection_name(kb_id),
            )
            await self.run_sync(collection.load)
            self._collections[kb_id] = collection
        return collection

    _CHUNK_OUTPUT_FIELDS = [
        "id", "doc_id", "kb_id", "chunk_index", "chunk_text",
        "doc_name", "doc_type", "metadata_",
    ]

    async def get_chunks_by_doc_id(self, kb_id: str, doc_id: str) -> list[dict]:
        collection = await self._get_collection(kb_id)
        results = await self.run_sync(
            collection.query,
            expr=f'doc_id == "{safe_expr_id(doc_id, "doc_id")}"',
            output_fields=self._CHUNK_OUTPUT_FIELDS,
        )
        results.sort(key=lambda r: r.get("chunk_index", 0))
        logger.info("Milvus queried %d chunks for doc=%s", len(results), doc_id)
        return results

    async def get_chunks_by_ids(
        self, kb_id: str, chunk_ids: list[str], include_embeddings: bool = False,
    ) -> list[dict]:
        """按切片 ID 列表批量查询切片详情（可选返回向量）。"""
        if not chunk_ids:
            return []

        collection = await self._get_collection(kb_id)
        ids_str = ", ".join(f'"{safe_expr_id(cid, "chunk_id")}"' for cid in chunk_ids)
        expr = f"id in [{ids_str}]"
        output_fields = list(self._CHUNK_OUTPUT_FIELDS)
        if include_embeddings:
            output_fields.append("embedding")
        try:
            return await self.run_sync(
                collection.query,
                expr=expr,
                output_fields=output_fields,
            )
        except Exception:
            logger.exception("Milvus get_chunks_by_ids failed for kb=%s", kb_id)
            return []

    async def delete_chunk_by_id(self, kb_id: str, chunk_id: str) -> None:
        collection = await self._get_collection(kb_id)
        await self.run_sync(
            collection.delete, f'id == "{safe_expr_id(chunk_id, "chunk_id")}"',
        )
        await self.run_sync(collection.flush)
        self._sparse_cache.invalidate(kb_id)
        logger.info("Milvus deleted chunk=%s in kb=%s", chunk_id, kb_id)

    async def update_chunk(
        self, kb_id: str, chunk_id: str, new_text: str,
        new_embedding: list[float],
    ) -> None:
        """更新切片——必须回填全部字段。

        Milvus 的 upsert 语义是「删除 + 插入」，且 schema 未声明 nullable /
        default_value，pymilvus 在 partial_update=False 时会对缺失字段直接抛
        ``DataNotMatchException``。因此这里先取出原记录，补齐 doc_id / kb_id /
        chunk_index / doc_name / doc_type / metadata_ 后再整行 upsert，避免
        切片更新后丢失文档归属。
        """
        import time
        collection = await self._get_collection(kb_id)
        now_ms = int(time.time() * 1000)

        existing = await self.get_chunks_by_ids(kb_id, [chunk_id])
        if not existing:
            raise ValueError(f"Chunk not found: {chunk_id}")
        old = existing[0]
        metadata = dict(old.get("metadata_", {}) or {})
        # 正文被改写后哈希必须跟着更新，否则"内容哈希"就成了过期信息
        # （增量索引按它判断"这片要不要重算"）
        metadata["content_hash"] = chunk_content_hash(new_text)

        await self.run_sync(collection.upsert, [{
            "id": chunk_id,
            "doc_id": old.get("doc_id", ""),
            "kb_id": old.get("kb_id", kb_id),
            "chunk_index": old.get("chunk_index", 0),
            "chunk_text": new_text[:65535],
            "embedding": new_embedding,
            "doc_name": old.get("doc_name", ""),
            "doc_type": old.get("doc_type", ""),
            "metadata_": metadata,
            "created_at": now_ms,
        }])
        await self.run_sync(collection.flush)
        self._sparse_cache.invalidate(kb_id)
        logger.info("Milvus updated chunk=%s in kb=%s", chunk_id, kb_id)

    async def similarity_search(
        self, kb_id: str, query_embedding: list[float], top_k: int,
        doc_ids: list[str] | None = None,
        doc_types: list[str] | None = None,
    ) -> list[tuple[str, float]]:
        """Milvus 向量检索——ANN 搜索 embedding 字段（支持元数据过滤）。

        Milvus 的 ``COSINE`` 度量返回的 ``hit.distance`` **就是余弦相似度本身**
        （范围 [-1, 1]，越大越相关），并非 [0, 2] 距离。这一点由 pymilvus 自身
        的 ``metrics_positive_related`` 佐证：COSINE 与 IP / BM25 同属"越大越好"
        分组，L2 / HAMMING / JACCARD 才是距离分组。因此直接透传即可，不要再做
        ``1 - distance/2`` 换算（那会把相似度压到 [0.5, 1] 并整体反转）。
        """
        collection = await self._get_collection(kb_id)
        # HNSW 的 ef（搜索宽度）必须 >= limit(=k)，否则 Milvus 直接报错：
        # "ef(64) should be larger than k(80)"。此前 ef 写死 64，一旦候选数超过
        # 64（开启精排后 hybrid 会按 top_k*8 取候选，top_k>=9 即触发）整次检索失败。
        ef = max(_HNSW_MIN_EF, top_k * 2)
        expr = self._build_filter_expr(doc_ids, doc_types)

        def _search_sync() -> list[tuple[str, float]]:
            # search 与命中遍历必须在同一个工作线程里（pymilvus 的命中是惰性的，
            # 遍历时可能触发额外请求——留在事件循环里就是一次隐藏的阻塞）
            return self._materialize_hits(collection.search(
                data=[query_embedding],
                anns_field="embedding",
                param={"metric_type": "COSINE", "params": {"ef": ef}},
                limit=top_k,
                expr=expr or None,
                output_fields=[],
            ))

        pairs = await self.run_sync(_search_sync)
        logger.info("Milvus similarity search kb=%s top_k=%d returned=%d", kb_id, top_k, len(pairs))
        return pairs

    async def _fetch_corpus(self, kb_id: str) -> list[tuple[str, str]]:
        """全量拉取 ``(chunk_id, chunk_text)`` 用作 BM25 语料。

        使用 ``query_iterator`` 分页，避免 ``query()`` 默认查询窗口（默认 16384
        行）静默截断导致大知识库稀疏检索漏召回。
        """
        collection = await self._get_collection(kb_id)
        corpus: list[tuple[str, str]] = []
        try:
            iterator = await self.run_sync(
                collection.query_iterator,
                expr="id != ''",
                output_fields=["id", "chunk_text"],
                batch_size=1000,
            )
            try:
                while True:
                    # 每批都走线程池：单批 1000 行也是一次远程查询，留在事件循环里
                    # 同样会阻塞（全量语料扫描实测 2.9s，期间服务停摆）
                    batch = await self.run_sync(iterator.next)
                    if not batch:
                        break
                    corpus.extend(
                        (row.get("id", ""), row.get("chunk_text") or "") for row in batch
                    )
            finally:
                await self.run_sync(iterator.close)
        except Exception:
            logger.exception("Milvus fetch corpus failed for kb=%s", kb_id)
            return []
        return corpus

    async def _probe_native_sparse(
        self, kb_id: str, collection: Any,
    ) -> tuple[bool, dict[str, Any]]:
        """探测该集合是否具备原生稀疏检索能力（结果按知识库缓存）。

        探测依据是 schema 里有没有 ``sparse`` 字段——建集合时的 ``enable_bm25``
        决定的；老的（本次改动之前建的）集合没有这个字段，只能走客户端回退。
        探测本身是一次远程调用（读 schema / 索引），因此结果缓存起来。
        """
        cached = self._native_sparse.get(kb_id)
        if cached is not None:
            return cached
        try:
            fields = await self.run_sync(lambda: [f.name for f in collection.schema.fields])
            has_sparse = _SPARSE_FIELD in fields
            params: dict[str, Any] = {}
            if has_sparse:
                params = await self.run_sync(self._read_sparse_index_params, collection)
            cached = (has_sparse, params)
        except Exception:
            logger.warning("探测 Milvus 稀疏字段失败，本次走客户端 BM25 kb=%s", kb_id)
            cached = (False, {})
        self._native_sparse[kb_id] = cached
        return cached

    @staticmethod
    def _read_sparse_index_params(collection: Any) -> dict[str, Any]:
        """读取稀疏索引上固化的参数（bm25_k1 / bm25_b）。"""
        for index in getattr(collection, "indexes", []) or []:
            if getattr(index, "field_name", "") == _SPARSE_FIELD:
                return dict((getattr(index, "params", {}) or {}).get("params", {}) or {})
        return {}

    async def bm25_search(
        self, kb_id: str, query: str, top_k: int,
        sparse_config: SparseConfig | None = None,
    ) -> list[tuple[str, float]]:
        """BM25 稀疏检索——优先走 Milvus 原生稀疏检索，不可用时回退客户端实现。"""
        cfg = sparse_config or SparseConfig()
        if create_sparse_scorer(cfg.sparse_algo) is None:
            logger.info("Milvus sparse search disabled (sparse_algo=%s) kb=%s", cfg.sparse_algo, kb_id)
            return []

        collection = await self._get_collection(kb_id)
        native, index_params = await self._probe_native_sparse(kb_id, collection)
        if native and cfg.sparse_algo == SPARSE_ALGO_BM25:
            self._warn_on_param_drift(kb_id, cfg, index_params)
            hits = await self._native_bm25_search(collection, kb_id, query, top_k)
            logger.info(
                "Milvus bm25(native) kb=%s top_k=%d returned=%d", kb_id, top_k, len(hits),
            )
            return hits

        # 回退：老集合（无 sparse 字段）、bm25_plus / tf_idf（原生不支持）
        index = await self._build_sparse_index(kb_id)
        hits = await self._sparse_search(index, query, top_k, cfg)
        logger.info(
            "Milvus bm25(client fallback) kb=%s top_k=%d algo=%s corpus=%d returned=%d",
            kb_id, top_k, cfg.sparse_algo, index.size, len(hits),
        )
        return hits

    @staticmethod
    def _warn_on_param_drift(
        kb_id: str, cfg: SparseConfig, index_params: dict[str, Any],
    ) -> None:
        """k1/b 固化在索引里，配置改了只有重建索引才能生效——不能静默。

        不做"配置与索引不一致就回退客户端实现"：那会让一次参数微调把检索从
        服务端倒排打回全量语料扫描（性能差两个数量级），比排序略有偏差更糟。
        """
        for key, configured in (("bm25_k1", cfg.bm25_k1), ("bm25_b", cfg.bm25_b)):
            built = index_params.get(key)
            if built is None:
                continue
            try:
                if abs(float(built) - float(configured)) > 1e-6:
                    logger.warning(
                        "知识库 %s 的 %s 配置为 %s，但稀疏索引是按 %s 建的——"
                        "BM25 的 k1/b 固化在索引里，需重建索引才能生效",
                        kb_id, key, configured, built,
                    )
            except (TypeError, ValueError):
                continue

    @staticmethod
    def _materialize_hits(results: Any) -> list[tuple[str, float]]:
        """把 Milvus 的 SearchResult 摊平成 ``(chunk_id, score)``。

        **必须与 search 调用一起放在工作线程里**：pymilvus 的命中是**惰性**的，
        ``hit.id`` / ``hit.distance`` 是访问时才去取字段（未缓存的字段要发一次
        请求）。此前只在工作线程里发出 search、在事件循环里遍历 hits——压测显示
        事件循环仍会被占住（实测最大停顿 647ms），正是这一步在偷偷做网络 IO。
        """
        pairs: list[tuple[str, float]] = []
        if results and results[0]:
            for hit in results[0]:
                pairs.append((hit.id, round(float(hit.distance), 6)))
        return pairs

    def _native_bm25_search_sync(
        self, collection: Any, query: str, top_k: int,
    ) -> list[tuple[str, float]]:
        """原生 BM25 检索（同步体）。

        ``data`` 传**原始查询文本**而不是向量：Milvus 会用与 ``chunk_text``
        相同的分析器对它分词，再由 BM25 Function 转成稀疏向量。
        """
        results = collection.search(
            data=[query],
            anns_field=_SPARSE_FIELD,
            param={"metric_type": "BM25"},
            limit=top_k,
            output_fields=[],
        )
        return self._materialize_hits(results)

    async def _native_bm25_search(
        self, collection: Any, kb_id: str, query: str, top_k: int,
    ) -> list[tuple[str, float]]:
        return await self.run_sync(
            self._native_bm25_search_sync, collection, query, top_k,
        )


class ChromaVectorStore(BaseVectorStore):
    """基于 Chroma 的向量数据库实现。

    Collection 命名规则: kb_{kb_id}；文档文本存于 Chroma 的 ``documents`` 字段。
    稀疏检索与 Milvus 侧共用 :mod:`core.rag.bm25` 的客户端实现，不再使用
    ``where_document`` 预过滤（子串匹配会退化成"整句精确匹配"且破坏 IDF 统计）。
    """

    @staticmethod
    def _collection_name(kb_id: str) -> str:
        return f"kb_{kb_id.replace('-', '_')}"

    def __init__(
        self,
        host: str = "",
        port: int = 8001,
        persist_dir: str = "./chroma_data",
    ):
        self._host = host
        self._port = port
        self._persist_dir = persist_dir
        self._client: Any = None
        self._sparse_cache = SparseIndexCache()
        #: 按知识库的建索引锁——并发查询时不重复拉全量语料（见 _build_sparse_index）
        self._sparse_locks: dict[str, asyncio.Lock] = {}

    def _get_client(self) -> Any:
        """获取或初始化 Chroma 客户端（**同步**，构造开销只在首次）。"""
        if self._client is None:
            import chromadb
            if self._host:
                self._client = chromadb.HttpClient(host=self._host, port=self._port)
            else:
                self._client = chromadb.PersistentClient(path=self._persist_dir)
        return self._client

    def _get_collection_sync(self, kb_id: str) -> Any:
        """获取 Collection，不存在时抛出异常（同步版本，供线程池内调用）。"""
        client = self._get_client()
        return client.get_collection(self._collection_name(kb_id))

    async def _get_collection(self, kb_id: str) -> Any:
        """线程池版 ``get_collection``——Chroma 的 get 也要做一次远程/RPC 往返。"""
        return await self.run_sync(self._get_collection_sync, kb_id)

    async def create_collection(
        self, kb_id: str, dim: int, enable_bm25: bool = True,
        sparse_params: dict[str, float] | None = None,
    ) -> None:
        # Chroma 没有原生稀疏检索，接口参数仅为对齐（稀疏检索始终走客户端实现）
        collection_name = self._collection_name(kb_id)

        def _create() -> None:
            client = self._get_client()
            try:
                client.delete_collection(collection_name)
                logger.info("Dropped existing Chroma collection: %s", collection_name)
            except Exception:
                pass
            client.create_collection(
                name=collection_name,
                metadata={"hnsw:space": "cosine", "dim": dim},
            )

        await self.run_sync(_create)
        self._sparse_cache.invalidate(kb_id)
        logger.info("Chroma collection created: %s (dim=%d)", collection_name, dim)

    async def delete_collection(self, kb_id: str) -> None:
        collection_name = self._collection_name(kb_id)
        try:
            await self.run_sync(
                self._get_client().delete_collection, collection_name,
            )
            self._sparse_cache.invalidate(kb_id)
            logger.info("Chroma collection deleted: %s", collection_name)
        except Exception as e:
            logger.error("Failed to delete Chroma collection %s: %s", collection_name, e)

    async def add_documents(
        self, kb_id: str, documents: list[Document], embeddings: list[list[float]],
    ) -> list[str]:
        """写入切片——幂等，语义与 Milvus 侧一致（确定性 ID + upsert）。"""
        import json

        collection = await self._get_collection(kb_id)

        chunk_ids: list[str] = []
        chroma_docs: list[str] = []
        metadatas: list[dict[str, Any]] = []

        for i, doc in enumerate(documents):
            doc_id = doc.metadata.get("doc_id", "")
            chunk_index = int(doc.metadata.get("chunk_index", i))
            chunk_ids.append(chunk_id_for(doc_id, chunk_index))
            metadata = dict(doc.metadata.get("metadata_", {}) or {})
            metadata["content_hash"] = chunk_content_hash(doc.page_content)
            chroma_docs.append(doc.page_content)
            metadatas.append({
                "doc_id": doc_id,
                "kb_id": kb_id,
                "chunk_index": chunk_index,
                "doc_name": doc.metadata.get("doc_name", ""),
                "doc_type": doc.metadata.get("doc_type", ""),
                "metadata_": json.dumps(metadata),
                "created_at": doc.metadata.get("created_at", 0),
            })

        await self.run_sync(
            collection.upsert,
            ids=chunk_ids,
            documents=chroma_docs,
            embeddings=embeddings,
            metadatas=metadatas,
        )
        self._sparse_cache.invalidate(kb_id)
        logger.info("Chroma upserted %d chunks for kb=%s", len(chunk_ids), kb_id)
        return chunk_ids

    async def delete_by_doc_id(self, kb_id: str, doc_id: str) -> None:
        collection = await self._get_collection(kb_id)
        # Find all chunk IDs for this doc
        result = await self.run_sync(
            collection.get,
            where={"doc_id": doc_id},
            include=[],
        )
        if result["ids"]:
            await self.run_sync(collection.delete, ids=result["ids"])
            self._sparse_cache.invalidate(kb_id)
            logger.info("Chroma deleted %d chunks for doc=%s in kb=%s", len(result["ids"]), doc_id, kb_id)

    async def get_chunks_by_doc_id(self, kb_id: str, doc_id: str) -> list[dict]:
        import json

        collection = await self._get_collection(kb_id)
        result = await self.run_sync(
            collection.get,
            where={"doc_id": doc_id},
            include=["documents", "metadatas"],
        )

        chunks: list[dict] = []
        if not result["ids"]:
            return chunks

        for i, cid in enumerate(result["ids"]):
            meta = (result["metadatas"] or [{}])[i] if i < len(result["metadatas"] or []) else {}
            metadata_str = meta.get("metadata_", "{}")
            try:
                metadata_obj = json.loads(metadata_str) if isinstance(metadata_str, str) else metadata_str
            except (json.JSONDecodeError, TypeError):
                metadata_obj = {}

            chunks.append({
                "id": cid,
                "doc_id": meta.get("doc_id", ""),
                "kb_id": meta.get("kb_id", kb_id),
                "chunk_index": meta.get("chunk_index", i),
                "chunk_text": (result["documents"] or [""])[i] if i < len(result["documents"] or []) else "",
                "doc_name": meta.get("doc_name", ""),
                "doc_type": meta.get("doc_type", ""),
                "metadata_": metadata_obj,
            })

        chunks.sort(key=lambda r: r.get("chunk_index", 0))
        logger.info("Chroma queried %d chunks for doc=%s", len(chunks), doc_id)
        return chunks

    async def get_chunks_by_ids(
        self, kb_id: str, chunk_ids: list[str], include_embeddings: bool = False,
    ) -> list[dict]:
        """按切片 ID 列表批量查询切片详情（可选返回向量）。"""
        import json

        if not chunk_ids:
            return []

        collection = await self._get_collection(kb_id)
        include = ["documents", "metadatas"]
        if include_embeddings:
            include.append("embeddings")
        result = await self.run_sync(
            collection.get,
            ids=chunk_ids,
            include=include,
        )

        chunks: list[dict] = []
        if not result["ids"]:
            return chunks

        for i, cid in enumerate(result["ids"]):
            meta = (result.get("metadatas") or [{}])[i] if i < len(result.get("metadatas") or []) else {}
            metadata_str = meta.get("metadata_", "{}")
            try:
                metadata_obj = json.loads(metadata_str) if isinstance(metadata_str, str) else metadata_str
            except (json.JSONDecodeError, TypeError):
                metadata_obj = {}

            chunks.append({
                "id": cid,
                "doc_id": meta.get("doc_id", ""),
                "kb_id": meta.get("kb_id", kb_id),
                "chunk_index": meta.get("chunk_index", i),
                "chunk_text": (result.get("documents") or [""])[i] if i < len(result.get("documents") or []) else "",
                "doc_name": meta.get("doc_name", ""),
                "doc_type": meta.get("doc_type", ""),
                "metadata_": metadata_obj,
            })
            if include_embeddings:
                embeddings = result.get("embeddings")
                chunks[-1]["embedding"] = (
                    list(embeddings[i]) if embeddings is not None and i < len(embeddings)
                    else None
                )

        return chunks

    async def delete_chunk_by_id(self, kb_id: str, chunk_id: str) -> None:
        collection = await self._get_collection(kb_id)
        await self.run_sync(collection.delete, ids=[chunk_id])
        self._sparse_cache.invalidate(kb_id)
        logger.info("Chroma deleted chunk=%s in kb=%s", chunk_id, kb_id)

    async def update_chunk(
        self, kb_id: str, chunk_id: str, new_text: str,
        new_embedding: list[float],
    ) -> None:
        """更新切片——Chroma 的 metadata 是整体替换，必须先合并原元数据。

        若直接传 ``metadatas=[{"created_at": ...}]``，doc_id / kb_id /
        chunk_index 等字段会被清空，切片随即脱离文档归属（``get_chunks_by_doc_id``
        再也查不到）。
        """
        import time

        collection = await self._get_collection(kb_id)
        now_ms = int(time.time() * 1000)

        existing = await self.run_sync(
            collection.get, ids=[chunk_id], include=["metadatas"],
        )
        if not existing["ids"]:
            raise ValueError(f"Chunk not found: {chunk_id}")
        meta = dict((existing.get("metadatas") or [{}])[0] or {})
        meta["created_at"] = now_ms

        await self.run_sync(
            collection.update,
            ids=[chunk_id],
            documents=[new_text],
            embeddings=[new_embedding],
            metadatas=[meta],
        )
        self._sparse_cache.invalidate(kb_id)
        logger.info("Chroma updated chunk=%s in kb=%s", chunk_id, kb_id)

    async def _fetch_corpus(self, kb_id: str) -> list[tuple[str, str]]:
        """全量拉取 ``(chunk_id, chunk_text)`` 用作 BM25 语料（Chroma get 无窗口限制）。"""
        collection = await self._get_collection(kb_id)
        try:
            result = await self.run_sync(collection.get, include=["documents"])
        except Exception:
            logger.exception("Chroma fetch corpus failed for kb=%s", kb_id)
            return []
        ids = result.get("ids") or []
        docs = result.get("documents") or []
        return [
            (cid, docs[i] if i < len(docs) else "")
            for i, cid in enumerate(ids)
        ]

    async def similarity_search(
        self, kb_id: str, query_embedding: list[float], top_k: int,
        doc_ids: list[str] | None = None,
        doc_types: list[str] | None = None,
    ) -> list[tuple[str, float]]:
        """Chroma 向量检索（支持元数据过滤）。

        Chroma 的 cosine ``distances`` 是**距离**（0=完全相同，2=完全相反），
        必须换算为余弦相似度 ``1 - distance`` 才能与 Milvus 侧口径一致
        （越大越相关）。此前直接透传 distance，导致"综合/向量"分值方向相反。
        """
        collection = await self._get_collection(kb_id)
        where: dict | None = None
        if doc_ids and doc_types:
            where = {"$and": [
                {"doc_id": {"$in": list(doc_ids)}},
                {"doc_type": {"$in": list(doc_types)}},
            ]}
        elif doc_ids:
            where = {"doc_id": {"$in": list(doc_ids)}}
        elif doc_types:
            where = {"doc_type": {"$in": list(doc_types)}}

        result = await self.run_sync(
            collection.query,
            query_embeddings=[query_embedding],
            n_results=top_k,
            include=[],
            **({"where": where} if where else {}),
        )

        pairs: list[tuple[str, float]] = []
        if not result["ids"] or not result["ids"][0]:
            return pairs

        distances = (result.get("distances") or [[]])[0]
        for i, cid in enumerate(result["ids"][0]):
            distance = distances[i] if i < len(distances) else 0.0
            pairs.append((cid, round(1.0 - float(distance), 6)))

        logger.info("Chroma similarity search kb=%s top_k=%d returned=%d", kb_id, top_k, len(pairs))
        return pairs

    async def bm25_search(
        self, kb_id: str, query: str, top_k: int,
        sparse_config: SparseConfig | None = None,
    ) -> list[tuple[str, float]]:
        """BM25 稀疏检索——与 Milvus 侧共用同一套打分实现。

        此前用 ``where_document={"$contains": 最长词}`` 预过滤再数词频：中文查询
        的"最长词"就是整句，等于退化成子串精确匹配，且预过滤会破坏 IDF 统计。
        现改为全量语料上做真 BM25。
        """
        cfg = sparse_config or SparseConfig()
        if create_sparse_scorer(cfg.sparse_algo) is None:
            logger.info("Chroma sparse search disabled (sparse_algo=%s) kb=%s", cfg.sparse_algo, kb_id)
            return []

        index = await self._build_sparse_index(kb_id)
        hits = await self._sparse_search(index, query, top_k, cfg)
        logger.info(
            "Chroma bm25 kb=%s top_k=%d algo=%s corpus=%d returned=%d",
            kb_id, top_k, cfg.sparse_algo, index.size, len(hits),
        )
        return hits
