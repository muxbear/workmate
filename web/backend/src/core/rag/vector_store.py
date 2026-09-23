"""向量数据库抽象层——策略模式。

统一 Milvus 和 Chroma 的操作接口，支持向量检索和 BM25 稀疏检索。

**打分口径约定**：本层所有检索返回 ``(chunk_id, score)`` 且 **score 一律为
"越大越相关"**——向量侧已把各后端的距离统一换算为余弦相似度，稀疏侧为
BM25 得分。上层（``search_service``）依赖该约定做融合与展示。

混合检索（RRF 融合）由 ``api.knowledge_base.search_service._fuse_scores`` 统一
实现，本层不再提供 ``hybrid_search``，避免两套融合公式产生分歧。
"""

import logging
from abc import ABC, abstractmethod
from typing import Any

from langchain_core.documents import Document

from core.rag.bm25 import (
    BM25Index,
    SparseConfig,
    SparseIndexCache,
    create_sparse_scorer,
)

logger = logging.getLogger(__name__)


class BaseVectorStore(ABC):
    """向量数据库抽象接口（策略模式）。"""

    @abstractmethod
    async def create_collection(self, kb_id: str, dim: int, enable_bm25: bool = True) -> None:
        """为知识库创建 Collection。"""

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
    async def get_chunks_by_ids(self, kb_id: str, chunk_ids: list[str]) -> list[dict]:
        """按切片 ID 列表批量查询切片详情。"""

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
        self, kb_id: str, query_embedding: list[float], top_k: int
    ) -> list[tuple[str, float]]:
        """向量相似度搜索，返回 (chunk_id, 余弦相似度)，越大越相关。"""

    @abstractmethod
    async def bm25_search(
        self, kb_id: str, query: str, top_k: int,
        sparse_config: SparseConfig | None = None,
    ) -> list[tuple[str, float]]:
        """BM25 稀疏检索，返回 (chunk_id, BM25 得分)，越大越相关。

        Args:
            sparse_config: 稀疏算法与 k1/b 参数；缺省用 bm25 默认参数。
        """

    async def _build_sparse_index(self, kb_id: str) -> BM25Index:
        """构建（或复用缓存中的）BM25 语料索引。子类需实现 :meth:`_fetch_corpus`。"""
        cached = self._sparse_cache.get(kb_id)
        if cached is not None:
            return cached
        corpus = await self._fetch_corpus(kb_id)
        index = BM25Index.build(corpus)
        self._sparse_cache.put(kb_id, index)
        return index

    @abstractmethod
    async def _fetch_corpus(self, kb_id: str) -> list[tuple[str, str]]:
        """拉取 ``(chunk_id, chunk_text)`` 全量语料，供 BM25 统计 df / avgdl。

        Milvus 需用 query_iterator 避免默认查询窗口截断，Chroma 直接全量 get。
        """



class MilvusVectorStore(BaseVectorStore):
    """基于 Milvus 的向量数据库实现。

    Collection 命名规则: kb_{kb_id}
    每个 Collection 包含 embedding (FLOAT_VECTOR) 字段和 BM25 稀疏向量。
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

    async def _ensure_connected(self):
        if self._connected:
            return
        try:
            from pymilvus import connections
            connections.connect(
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

    async def create_collection(self, kb_id: str, dim: int, enable_bm25: bool = True) -> None:
        await self._ensure_connected()
        collection_name = self._collection_name(kb_id)

        try:
            from pymilvus import (
                Collection,
                CollectionSchema,
                DataType,
                FieldSchema,
                utility,
            )
            # 删除旧集合（可能由旧版 Schema 创建，与新版本不兼容）
            if utility.has_collection(collection_name):
                logger.info("Dropping existing collection: %s", collection_name)
                await utility.drop_collection(collection_name)

            fields = [
                FieldSchema(name="id", dtype=DataType.VARCHAR, is_primary=True, max_length=36),
                FieldSchema(name="doc_id", dtype=DataType.VARCHAR, max_length=36),
                FieldSchema(name="kb_id", dtype=DataType.VARCHAR, max_length=36),
                FieldSchema(name="chunk_index", dtype=DataType.INT64),
                FieldSchema(name="chunk_text", dtype=DataType.VARCHAR, max_length=65535),
                FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=dim),
                FieldSchema(name="doc_name", dtype=DataType.VARCHAR, max_length=256),
                FieldSchema(name="doc_type", dtype=DataType.VARCHAR, max_length=16),
                FieldSchema(name="metadata_", dtype=DataType.JSON),
                FieldSchema(name="created_at", dtype=DataType.INT64),
            ]

            schema = CollectionSchema(fields=fields, description=f"Knowledge base: {kb_id}")
            collection = Collection(name=collection_name, schema=schema)

            # Dense vector index (COSINE)
            collection.create_index(  # pyright: ignore[reportUnusedCoroutine]
                field_name="embedding",
                index_params={
                    "metric_type": "COSINE",
                    "index_type": "HNSW",
                    "params": {"M": 16, "efConstruction": 200},
                },
            )

            # Scalar indices
            for field_name in ["doc_id", "kb_id"]:
                collection.create_index(  # pyright: ignore[reportUnusedCoroutine]
                    field_name=field_name,
                    index_params={"index_type": "INVERTED"},
                )

            collection.load()
            self._collections[kb_id] = collection
            self._sparse_cache.invalidate(kb_id)
            logger.info("Milvus collection created: %s (dim=%d)", collection_name, dim)

        except Exception as e:
            logger.error("Failed to create Milvus collection kb=%s: %s", kb_id, e)
            raise

    async def delete_collection(self, kb_id: str) -> None:
        await self._ensure_connected()
        collection_name = self._collection_name(kb_id)
        try:
            from pymilvus import utility
            await utility.drop_collection(collection_name)
            self._collections.pop(kb_id, None)
            self._sparse_cache.invalidate(kb_id)
            logger.info("Milvus collection deleted: %s", collection_name)
        except Exception as e:
            logger.error("Failed to delete Milvus collection %s: %s", collection_name, e)

    async def add_documents(
        self, kb_id: str, documents: list[Document], embeddings: list[list[float]]
    ) -> list[str]:
        await self._ensure_connected()
        import time
        import uuid

        collection = self._collections.get(kb_id)
        if collection is None:
            from pymilvus import Collection
            collection = Collection(name=self._collection_name(kb_id))
            collection.load()
            self._collections[kb_id] = collection

        chunk_ids = [str(uuid.uuid4()) for _ in documents]
        now_ms = int(time.time() * 1000)

        data = []
        for i, doc in enumerate(documents):
            data.append({
                "id": chunk_ids[i],
                "doc_id": doc.metadata.get("doc_id", ""),
                "kb_id": kb_id,
                "chunk_index": doc.metadata.get("chunk_index", i),
                "chunk_text": doc.page_content[:65535],
                "embedding": embeddings[i],
                "doc_name": doc.metadata.get("doc_name", ""),
                "doc_type": doc.metadata.get("doc_type", ""),
                "metadata_": doc.metadata.get("metadata_", {}),
                "created_at": now_ms,
            })

        collection.insert(data)
        collection.flush()
        self._sparse_cache.invalidate(kb_id)
        logger.info("Milvus inserted %d chunks for kb=%s", len(data), kb_id)
        return chunk_ids

    async def delete_by_doc_id(self, kb_id: str, doc_id: str) -> None:
        await self._ensure_connected()
        collection = self._collections.get(kb_id)
        if collection is None:
            from pymilvus import Collection
            collection = Collection(name=self._collection_name(kb_id))
            collection.load()
            self._collections[kb_id] = collection

        collection.delete(f'doc_id == "{doc_id}"')
        collection.flush()
        self._sparse_cache.invalidate(kb_id)
        logger.info("Milvus deleted chunks for doc=%s in kb=%s", doc_id, kb_id)

    async def _get_collection(self, kb_id: str) -> Any:
        """获取或加载 Milvus Collection。"""
        await self._ensure_connected()
        collection = self._collections.get(kb_id)
        if collection is None:
            from pymilvus import Collection
            collection = Collection(name=self._collection_name(kb_id))
            collection.load()
            self._collections[kb_id] = collection
        return collection

    _CHUNK_OUTPUT_FIELDS = [
        "id", "doc_id", "kb_id", "chunk_index", "chunk_text",
        "doc_name", "doc_type", "metadata_",
    ]

    async def get_chunks_by_doc_id(self, kb_id: str, doc_id: str) -> list[dict]:
        collection = await self._get_collection(kb_id)
        results = collection.query(
            expr=f'doc_id == "{doc_id}"',
            output_fields=self._CHUNK_OUTPUT_FIELDS,
        )
        results.sort(key=lambda r: r.get("chunk_index", 0))
        logger.info("Milvus queried %d chunks for doc=%s", len(results), doc_id)
        return results

    async def get_chunks_by_ids(self, kb_id: str, chunk_ids: list[str]) -> list[dict]:
        """按切片 ID 列表批量查询切片详情。"""
        if not chunk_ids:
            return []

        collection = await self._get_collection(kb_id)
        ids_str = ", ".join(f'"{cid}"' for cid in chunk_ids)
        expr = f"id in [{ids_str}]"
        try:
            results = collection.query(
                expr=expr,
                output_fields=self._CHUNK_OUTPUT_FIELDS,
            )
            return results
        except Exception:
            logger.exception("Milvus get_chunks_by_ids failed for kb=%s", kb_id)
            return []

    async def delete_chunk_by_id(self, kb_id: str, chunk_id: str) -> None:
        collection = await self._get_collection(kb_id)
        collection.delete(f'id == "{chunk_id}"')
        collection.flush()
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

        collection.upsert([{
            "id": chunk_id,
            "doc_id": old.get("doc_id", ""),
            "kb_id": old.get("kb_id", kb_id),
            "chunk_index": old.get("chunk_index", 0),
            "chunk_text": new_text[:65535],
            "embedding": new_embedding,
            "doc_name": old.get("doc_name", ""),
            "doc_type": old.get("doc_type", ""),
            "metadata_": old.get("metadata_", {}) or {},
            "created_at": now_ms,
        }])
        collection.flush()
        self._sparse_cache.invalidate(kb_id)
        logger.info("Milvus updated chunk=%s in kb=%s", chunk_id, kb_id)

    async def similarity_search(
        self, kb_id: str, query_embedding: list[float], top_k: int
    ) -> list[tuple[str, float]]:
        """Milvus 向量检索——ANN 搜索 embedding 字段。

        Milvus 的 ``COSINE`` 度量返回的 ``hit.distance`` **就是余弦相似度本身**
        （范围 [-1, 1]，越大越相关），并非 [0, 2] 距离。这一点由 pymilvus 自身
        的 ``metrics_positive_related`` 佐证：COSINE 与 IP / BM25 同属"越大越好"
        分组，L2 / HAMMING / JACCARD 才是距离分组。因此直接透传即可，不要再做
        ``1 - distance/2`` 换算（那会把相似度压到 [0.5, 1] 并整体反转）。
        """
        collection = await self._get_collection(kb_id)
        results = collection.search(
            data=[query_embedding],
            anns_field="embedding",
            param={"metric_type": "COSINE", "params": {"ef": 64}},
            limit=top_k,
            output_fields=[],
        )
        pairs: list[tuple[str, float]] = []
        if results and results[0]:
            for hit in results[0]:
                pairs.append((hit.id, round(float(hit.distance), 6)))
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
            iterator = collection.query_iterator(
                expr="id != ''",
                output_fields=["id", "chunk_text"],
                batch_size=1000,
            )
            try:
                while True:
                    batch = iterator.next()
                    if not batch:
                        break
                    corpus.extend(
                        (row.get("id", ""), row.get("chunk_text") or "") for row in batch
                    )
            finally:
                iterator.close()
        except Exception:
            logger.exception("Milvus fetch corpus failed for kb=%s", kb_id)
            return []
        return corpus

    async def bm25_search(
        self, kb_id: str, query: str, top_k: int,
        sparse_config: SparseConfig | None = None,
    ) -> list[tuple[str, float]]:
        """BM25 稀疏检索——真 IDF + 长度归一，算法由 sparse_algo 决定。"""
        cfg = sparse_config or SparseConfig()
        if create_sparse_scorer(cfg.sparse_algo) is None:
            logger.info("Milvus sparse search disabled (sparse_algo=%s) kb=%s", cfg.sparse_algo, kb_id)
            return []

        index = await self._build_sparse_index(kb_id)
        hits = index.search(query, top_k, cfg)
        logger.info(
            "Milvus bm25 kb=%s top_k=%d algo=%s corpus=%d returned=%d",
            kb_id, top_k, cfg.sparse_algo, index.size, len(hits),
        )
        return hits


class ChromaVectorStore(BaseVectorStore):
    """基于 Chroma 的向量数据库实现。

    Collection 命名规则: kb_{kb_id}
    文档文本存储为 Chroma documents 字段以支持全文检索。
    BM25 通过 Chroma 内置 where_document 全文搜索 + TF 打分实现。
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

    def _get_client(self) -> Any:
        """获取或初始化 Chroma 客户端。"""
        if self._client is None:
            import chromadb
            if self._host:
                self._client = chromadb.HttpClient(host=self._host, port=self._port)
            else:
                self._client = chromadb.PersistentClient(path=self._persist_dir)
        return self._client

    def _get_collection(self, kb_id: str) -> Any:
        """获取 Collection，不存在时抛出异常。"""
        client = self._get_client()
        return client.get_collection(self._collection_name(kb_id))

    async def create_collection(self, kb_id: str, dim: int, enable_bm25: bool = True) -> None:
        client = self._get_client()
        collection_name = self._collection_name(kb_id)

        try:
            client.delete_collection(collection_name)
            logger.info("Dropped existing Chroma collection: %s", collection_name)
        except Exception:
            pass

        client.create_collection(
            name=collection_name,
            metadata={"hnsw:space": "cosine", "dim": dim},
        )
        self._sparse_cache.invalidate(kb_id)
        logger.info("Chroma collection created: %s (dim=%d)", collection_name, dim)

    async def delete_collection(self, kb_id: str) -> None:
        client = self._get_client()
        collection_name = self._collection_name(kb_id)
        try:
            client.delete_collection(collection_name)
            self._sparse_cache.invalidate(kb_id)
            logger.info("Chroma collection deleted: %s", collection_name)
        except Exception as e:
            logger.error("Failed to delete Chroma collection %s: %s", collection_name, e)

    async def add_documents(
        self, kb_id: str, documents: list[Document], embeddings: list[list[float]],
    ) -> list[str]:
        import json
        import uuid

        collection = self._get_collection(kb_id)

        chunk_ids = [str(uuid.uuid4()) for _ in documents]
        chroma_docs: list[str] = []
        metadatas: list[dict[str, Any]] = []

        for i, doc in enumerate(documents):
            chroma_docs.append(doc.page_content)
            metadatas.append({
                "doc_id": doc.metadata.get("doc_id", ""),
                "kb_id": kb_id,
                "chunk_index": doc.metadata.get("chunk_index", i),
                "doc_name": doc.metadata.get("doc_name", ""),
                "doc_type": doc.metadata.get("doc_type", ""),
                "metadata_": json.dumps(doc.metadata.get("metadata_", {})),
                "created_at": doc.metadata.get("created_at", 0),
            })

        collection.add(
            ids=chunk_ids,
            documents=chroma_docs,
            embeddings=embeddings,
            metadatas=metadatas,
        )
        self._sparse_cache.invalidate(kb_id)
        logger.info("Chroma inserted %d chunks for kb=%s", len(chunk_ids), kb_id)
        return chunk_ids

    async def delete_by_doc_id(self, kb_id: str, doc_id: str) -> None:
        collection = self._get_collection(kb_id)
        # Find all chunk IDs for this doc
        result = collection.get(
            where={"doc_id": doc_id},
            include=[],
        )
        if result["ids"]:
            collection.delete(ids=result["ids"])
            self._sparse_cache.invalidate(kb_id)
            logger.info("Chroma deleted %d chunks for doc=%s in kb=%s", len(result["ids"]), doc_id, kb_id)

    async def get_chunks_by_doc_id(self, kb_id: str, doc_id: str) -> list[dict]:
        import json

        collection = self._get_collection(kb_id)
        result = collection.get(
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

    async def get_chunks_by_ids(self, kb_id: str, chunk_ids: list[str]) -> list[dict]:
        """按切片 ID 列表批量查询切片详情。"""
        import json

        if not chunk_ids:
            return []

        collection = self._get_collection(kb_id)
        result = collection.get(
            ids=chunk_ids,
            include=["documents", "metadatas"],
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

        return chunks

    async def delete_chunk_by_id(self, kb_id: str, chunk_id: str) -> None:
        collection = self._get_collection(kb_id)
        collection.delete(ids=[chunk_id])
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

        collection = self._get_collection(kb_id)
        now_ms = int(time.time() * 1000)

        existing = collection.get(ids=[chunk_id], include=["metadatas"])
        if not existing["ids"]:
            raise ValueError(f"Chunk not found: {chunk_id}")
        meta = dict((existing.get("metadatas") or [{}])[0] or {})
        meta["created_at"] = now_ms

        collection.update(
            ids=[chunk_id],
            documents=[new_text],
            embeddings=[new_embedding],
            metadatas=[meta],
        )
        self._sparse_cache.invalidate(kb_id)
        logger.info("Chroma updated chunk=%s in kb=%s", chunk_id, kb_id)

    async def _fetch_corpus(self, kb_id: str) -> list[tuple[str, str]]:
        """全量拉取 ``(chunk_id, chunk_text)`` 用作 BM25 语料（Chroma get 无窗口限制）。"""
        collection = self._get_collection(kb_id)
        try:
            result = collection.get(include=["documents"])
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
    ) -> list[tuple[str, float]]:
        """Chroma 向量检索。

        Chroma 的 cosine ``distances`` 是**距离**（0=完全相同，2=完全相反），
        必须换算为余弦相似度 ``1 - distance`` 才能与 Milvus 侧口径一致
        （越大越相关）。此前直接透传 distance，导致"综合/向量"分值方向相反。
        """
        collection = self._get_collection(kb_id)
        result = collection.query(
            query_embeddings=[query_embedding],
            n_results=top_k,
            include=[],
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
        hits = index.search(query, top_k, cfg)
        logger.info(
            "Chroma bm25 kb=%s top_k=%d algo=%s corpus=%d returned=%d",
            kb_id, top_k, cfg.sparse_algo, index.size, len(hits),
        )
        return hits
