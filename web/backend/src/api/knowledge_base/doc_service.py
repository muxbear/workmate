"""文档管理 & 索引流水线服务——模板方法 + 观察者 + 单例模式。"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import uuid
from abc import ABC, abstractmethod
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from pathlib import PurePosixPath
from typing import TYPE_CHECKING, cast

from fastapi import HTTPException, UploadFile
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from agent.config import settings
from api.knowledge_base.doc_state import (
    STAGE_PROGRESS as _STAGE_PROGRESS,
)
from api.knowledge_base.doc_state import (
    IndexingContext,
    QueuedState,
)
from api.knowledge_base.schemas import (
    DocStageInfo,
    IndexConfigSchema,
    KBDocResponse,
)
from core.rag.loaders import DocumentLoaderRegistry
from core.rag.splitters import (
    INDEX_CONFIG_DEFAULTS,
    ChunkStrategyRegistry,
    create_chunk_registry,
)
from core.rag.vector_store import BaseVectorStore
from db.models.knowledge_base import KnowledgeBase
from db.models.knowledge_base_document import KnowledgeBaseDocument

if TYPE_CHECKING:
    from api.knowledge_base.mediator import KnowledgeBaseMediator

from core.notification_bus import NotificationBus, NotificationEvent

logger = logging.getLogger(__name__)

# 进度口径的唯一事实来源在状态机里（状态机负责"进入某阶段时的进度"）。
# 这里重新导出，保持既有导入路径可用。
STAGE_PROGRESS = _STAGE_PROGRESS
# 阶段名必须与文档状态一一对应（见 STAGE_STATUS_ORDER），否则会出现
# "某个阶段永远 pending / 永远运行中"的展示错误。
STAGE_NAMES = ["排队", "解析", "切片", "向量化", "稀疏索引", "实体关系抽取", "完成"]
STAGE_STATUS_ORDER = ["queued", "parsing", "chunking", "embedding", "bm25", "extracting", "indexed"]

#: 中间态（非终态）状态集合——用于判断"是否还有文档在索引中"
DOC_ACTIVE_STATUSES = frozenset(STAGE_STATUS_ORDER) - {"queued", "indexed"}

ALLOWED_EXTENSIONS = {
    "pdf", "docx", "xlsx", "pptx", "csv", "json", "md", "html", "txt",
    "png", "jpg", "jpeg",
}
MAX_FILE_SIZE_MB = 100

#: 单个索引阶段的执行上限（秒）。实测大文档的图谱抽取最慢，10 分钟足够覆盖
#: 万级切片的向量化 + 抽取；真正的挂死（网络无响应等）会在这一档被切断。
DEFAULT_STAGE_TIMEOUT_SECONDS = 600.0

#: 服务关停时等待在跑任务收尾的宽限期（秒）
SHUTDOWN_GRACE_SECONDS = 10.0

#: 取消任务后等待其停止的上限（秒）——用于取消后清理已写入的产物
CANCEL_GRACE_SECONDS = 5.0


def _format_bytes(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes} B"
    s: float = size_bytes
    for unit in ["KB", "MB", "GB", "TB"]:
        s /= 1024
        if s < 1024:
            return f"{s:.1f} {unit}"
    return f"{s:.1f} PB"


def _get_file_type(filename: str) -> str:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return ext if ext in ALLOWED_EXTENSIONS else "unknown"


def _sanitize_filename(filename: str) -> str:
    """把客户端提供的文件名净化为安全的存储名。

    客户端可控的 multipart 文件名此前被直接 ``os.path.join`` 到存储路径上，
    ``../../evil.md`` 这类名字可以写出上传目录，Windows 下传入绝对路径时
    ``os.path.join`` 还会直接丢弃目录前缀。这里只保留基名（去掉任何目录成分），
    并拒绝空名与 ``.`` / ``..``。

    Raises:
        HTTPException: 文件名为空或退化成分隔符时返回 400。
    """
    # 先归一 Windows 分隔符，再取基名——两种分隔符都能被 PurePosixPath 处理
    normalized = (filename or "").replace("\\", "/")
    name = PurePosixPath(normalized).name.strip()
    # 去掉控制字符（含空字节），它们会影响落盘与后续解析
    name = "".join(ch for ch in name if ch.isprintable())
    if name in ("", ".", ".."):
        raise HTTPException(status_code=400, detail="文件名不合法")
    return name


def _ensure_within(path: str, base_dir: str) -> str:
    """断言写入路径落在基目录内，返回规范化后的绝对路径。

    与 :func:`_sanitize_filename` 构成双保险：即便将来有人在净化逻辑上引入
    疏漏，越界的落盘也会在这里被拦下。
    """
    real = os.path.realpath(path)
    base = os.path.realpath(base_dir)
    if os.path.normcase(real) != os.path.normcase(base) and not os.path.normcase(
        real
    ).startswith(os.path.normcase(base) + os.sep):
        raise HTTPException(status_code=400, detail="文件名不合法")
    return real


def compute_stages(
    status: str,
    error_message: str | None = None,
    progress: int | None = None,
) -> list[dict]:
    """根据文档状态计算各阶段状态。

    阶段名与状态一一对应（``STAGE_NAMES[i]`` ↔ ``STAGE_STATUS_ORDER[i]``）。
    到达 ``indexed`` 时最后一个阶段标记为 ``done``，而不是继续显示"运行中"——
    此前阶段名有 8 项而状态只有 7 项，导致已完成的文档里「关系抽取」永远转圈、
    「入库」永远 pending。

    Args:
        status: 文档状态（``queued`` … ``indexed`` / ``failed`` / ``canceled``）。
        error_message: 失败原因，仅在无法用进度定位中断阶段时作为兜底线索。
        progress: 文档已记录的进度百分比——优先据此定位中断/失败发生在哪个阶段，
            比从错误文案里猜关键词可靠得多。

    Returns:
        每个阶段一条 ``{"name", "status", "pct"}``；中断阶段的状态为 ``failed``
        （失败）或 ``canceled``（用户取消）。
    """
    stages: list[dict] = []
    current_idx = (
        STAGE_STATUS_ORDER.index(status) if status in STAGE_STATUS_ORDER else -1
    )

    for i, name in enumerate(STAGE_NAMES):
        if i < current_idx:
            stages.append({"name": name, "status": "done", "pct": 100})
        elif i == current_idx:
            is_final = status == "indexed"
            stages.append({
                "name": name,
                "status": "done" if is_final else "running",
                "pct": STAGE_PROGRESS.get(status, 50),
            })
        else:
            stages.append({"name": name, "status": "pending", "pct": 0})

    if status in ("failed", "canceled"):
        stopped_idx = _resolve_stopped_stage(error_message, progress)
        if stopped_idx < len(stages):
            stages[stopped_idx]["status"] = (
                "canceled" if status == "canceled" else "failed"
            )
            stages[stopped_idx]["pct"] = 0
            # 中断阶段之前的阶段已完成
            for j in range(stopped_idx):
                stages[j]["status"] = "done"
                stages[j]["pct"] = 100

    return stages


def _resolve_stopped_stage(
    error_message: str | None, progress: int | None = None,
) -> int:
    """定位索引中断（失败 / 取消）发生在哪个阶段。

    优先用 ``progress`` 定位：进度是从状态机写下的真实值，按 ``STAGE_PROGRESS``
    的区间反查即可，不再依赖错误文案——此前只能靠 `"向量化" in msg` 这类关键词
    猜测，措辞一变就退化成"总是解析阶段"。
    """
    if isinstance(progress, int) and progress >= 0:
        # queued 阶段的进度是 0：既可能是还没开始，也可能刚进入解析
        stopped = 0
        for idx, stage in enumerate(STAGE_STATUS_ORDER):
            if progress >= STAGE_PROGRESS.get(stage, 0):
                stopped = idx
        return stopped
    return _infer_failed_stage_index(error_message)


def _infer_failed_stage_index(error_message: str | None) -> int:
    """从错误文案兜底推断失败阶段（仅当进度不可用时使用）。

    映射关系（错误消息关键词 → STAGE_NAMES 索引）：
    - "解析" → 1
    - "切片" → 2
    - "向量化" → 3
    - "BM25" / "稀疏" → 4
    - "实体" / "关系" / "图谱" → 5（实体与关系在同一阶段完成）
    """
    if not error_message:
        return 1  # 兜底：无法推断时默认解析阶段
    msg = error_message
    if "向量化" in msg:
        return 3
    if "切片" in msg:
        return 2
    if "BM25" in msg or "稀疏" in msg:
        return 4
    if "实体" in msg or "关系" in msg or "图谱" in msg:
        return 5
    if "解析" in msg:
        return 1
    return 1  # 兜底


# ══════════════════════════════════════════════════════════════
# 观察者模式
# ══════════════════════════════════════════════════════════════

class ProgressObserver(ABC):
    """索引进度观察者抽象接口。"""

    @abstractmethod
    async def on_progress(self, ctx: IndexingContext) -> None:
        ...


class DatabaseProgressObserver(ProgressObserver):
    """数据库进度观察者——将进度写入 knowledge_base_documents 表。"""

    def __init__(self, db_session_factory):
        self._db_factory = db_session_factory

    async def on_progress(self, ctx: IndexingContext) -> None:
        # 进度写入失败不应让索引失败，但也不能只是打条日志就完事——重试一次，
        # 仍失败就明确记录（此前任何异常都只记 error 日志，用户看到的是
        # "索引跑完了但页面停在某个中间态"）。
        last_error: Exception | None = None
        for attempt in (1, 2):
            try:
                await self._write_once(ctx)
                await self._publish_event(ctx)
                return
            except Exception as e:  # noqa: BLE001 - 观察者必须兜住一切
                last_error = e
                if attempt == 1:
                    await asyncio.sleep(0.2)
        logger.error(
            "数据库进度写入失败（已重试）doc=%s status=%s: %s",
            ctx.doc_id, ctx.status, last_error, exc_info=last_error,
        )

    async def _write_once(self, ctx: IndexingContext) -> None:
        """把一次状态变更落库（文档进度 + 任务心跳 + 终态计数/通知）。"""
        from db.models.knowledge_base_index_task import (
            TASK_STATUS_CANCELED,
            TASK_STATUS_FAILED,
            TASK_STATUS_RUNNING,
            TASK_STATUS_SUCCEEDED,
            TASK_TERMINAL_STATUSES,
            KnowledgeBaseIndexTask,
        )

        async with self._db_factory() as db:
            doc_values: dict = {
                "status": ctx.status,
                "progress": ctx.progress,
                "error_message": ctx.error_message,
                "chunks_count": len(ctx.chunks),
                "entities_count": ctx.entities_count,
                "relations_count": ctx.relations_count,
                "graph_error": ctx.graph_error,
            }
            # indexed_at 只在索引成功时写入：此前无条件传 None，
            # 会让每次中间状态更新都把已完成文档的索引时间抹掉。
            if ctx.status == "indexed":
                doc_values["indexed_at"] = datetime.utcnow()

            doc_stmt = update(KnowledgeBaseDocument).where(
                KnowledgeBaseDocument.id == ctx.doc_id
            )
            if ctx.status not in ("indexed", "failed", "canceled"):
                # 中间态写入不得"复活"已进入终态的文档：用户可能刚取消、删除或
                # 重试（重试前会先把文档置回 queued）了它，而上一轮任务还在跑最后
                # 几次状态回调。所有重入路径都会先提交 queued，因此这里排除三个
                # 终态不会误伤正常写入。
                doc_stmt = doc_stmt.where(
                    KnowledgeBaseDocument.status.notin_(
                        ["indexed", "failed", "canceled"]
                    )
                )
            await db.execute(doc_stmt.values(**doc_values))

            # 任务心跳：调度器写入任务行，这里随每次状态变更刷新，
            # 使"失联任务"可以在启动恢复时被识别。
            task_values: dict = {"heartbeat_at": datetime.utcnow()}
            task_stmt = update(KnowledgeBaseIndexTask).where(
                KnowledgeBaseIndexTask.doc_id == ctx.doc_id
            )
            if ctx.status == "indexed":
                task_values.update(
                    status=TASK_STATUS_SUCCEEDED, finished_at=datetime.utcnow(),
                )
            elif ctx.status == "failed":
                task_values.update(
                    status=TASK_STATUS_FAILED,
                    finished_at=datetime.utcnow(),
                    error_message=ctx.error_message,
                )
            elif ctx.status == "canceled":
                task_values.update(
                    status=TASK_STATUS_CANCELED, finished_at=datetime.utcnow(),
                )
            else:
                task_values["status"] = TASK_STATUS_RUNNING
                # 终态任务行不再被中间态心跳改写（例如取消后流水线最后几次回调）
                task_stmt = task_stmt.where(
                    KnowledgeBaseIndexTask.status.notin_(list(TASK_TERMINAL_STATUSES))
                )
            await db.execute(task_stmt.values(**task_values))

            await db.commit()

        # KB 级计数与通知放在**独立事务**里：若与上面的文档行更新同事务，本事务会
        # 在持有文档行锁的同时去更新 knowledge_bases 行；而 reindex 会先锁全库文档
        # 行、再更新 KB 行——两边加锁顺序相反，Postgres 下会死锁（SQLite 测不出来）。
        # 拆开后没有任何事务会"持着文档行等 KB 行"，环被打破。
        if ctx.status in ("indexed", "failed", "canceled"):
            async with self._db_factory() as db:
                await recalc_kb_counters(db, ctx.kb_id)
                await self._publish_notification(db, ctx)
                await db.commit()

    async def _publish_event(self, ctx: IndexingContext) -> None:
        """向订阅了该知识库的页面推送进度事件（不涉及数据库）。"""
        from api.knowledge_base.indexing_events import IndexingEventBus

        IndexingEventBus.publish(ctx.kb_id, {
            "doc_id": ctx.doc_id,
            "kb_id": ctx.kb_id,
            "status": ctx.status,
            "progress": ctx.progress,
            "chunks_count": len(ctx.chunks),
            "entities_count": ctx.entities_count,
            "relations_count": ctx.relations_count,
            "error_message": ctx.error_message,
            "graph_error": ctx.graph_error,
            # 阶段进度一并推送：否则前端面板要等 30 秒兜底轮询才前进
            "stages": compute_stages(ctx.status, ctx.error_message, ctx.progress),
        })

    async def _publish_notification(self, db, ctx: IndexingContext) -> None:
        """发布索引终态通知——收件人必须是知识库归属用户，而不是 kb_id。"""
        from db.models.knowledge_base import KnowledgeBase

        user_id = await db.scalar(
            select(KnowledgeBase.user_id).where(KnowledgeBase.id == ctx.kb_id)
        )
        if not user_id:
            logger.warning("通知跳过：知识库 %s 不存在", ctx.kb_id)
            return

        indexed = ctx.status == "indexed"
        try:
            await NotificationBus.publish(NotificationEvent(
                user_id=user_id,
                type="kb_indexed" if indexed else "kb_failed",
                title="文档索引完成" if indexed else "文档索引失败",
                content=(
                    f"文档 {ctx.doc_id} 索引完成" if indexed
                    else f"文档 {ctx.doc_id} 索引失败: {ctx.error_message or ''}"
                ),
                level="success" if indexed else "error",
                link=f"/knowledge-base?kb_id={ctx.kb_id}",
                metadata={"doc_id": ctx.doc_id, "kb_id": ctx.kb_id},
            ))
        except Exception:
            logger.warning("发布通知事件失败", exc_info=True)


class LoggingProgressObserver(ProgressObserver):
    """日志进度观察者。"""

    async def on_progress(self, ctx: IndexingContext) -> None:
        stage = ctx.current_state.name if ctx.current_state else "unknown"
        logger.info("文档 %s: 状态=%s 进度=%d%% 阶段=%s", ctx.doc_id, ctx.status, ctx.progress, stage)


async def recalc_kb_counters(db: AsyncSession, kb_id: str) -> None:
    """按真实数据重算知识库的冗余计数与状态。

    口径统一为**行数**（页面上能看到多少就记多少）：此前 ``entities_count`` 取
    ``count(distinct name)``，与图谱页签实际渲染的行数不一致——同一个知识库会出现
    "统计卡 255 个实体"与"图里 282 个节点"并存。

    调用时机：文档终态（观察者）、切片增删改（chunk_api）、删除文档/知识库。
    调用方负责提交事务。
    """
    from db.models.knowledge_base import KnowledgeBase
    from db.models.knowledge_base_entity import KnowledgeBaseEntity
    from db.models.knowledge_base_relation import KnowledgeBaseRelation

    kb = (
        await db.execute(select(KnowledgeBase).where(KnowledgeBase.id == kb_id))
    ).scalar_one_or_none()
    if kb is None:
        return

    docs_count = await db.scalar(
        select(func.count()).select_from(KnowledgeBaseDocument).where(
            KnowledgeBaseDocument.kb_id == kb_id,
        )
    )
    size_bytes = await db.scalar(
        select(func.coalesce(func.sum(KnowledgeBaseDocument.size_bytes), 0)).where(
            KnowledgeBaseDocument.kb_id == kb_id,
        )
    )
    chunks_total = await db.scalar(
        select(func.coalesce(func.sum(KnowledgeBaseDocument.chunks_count), 0)).where(
            KnowledgeBaseDocument.kb_id == kb_id,
            KnowledgeBaseDocument.status == "indexed",
        )
    )
    entity_total = await db.scalar(
        select(func.count()).select_from(KnowledgeBaseEntity).where(
            KnowledgeBaseEntity.kb_id == kb_id,
        )
    )
    relation_total = await db.scalar(
        select(func.count()).select_from(KnowledgeBaseRelation).where(
            KnowledgeBaseRelation.kb_id == kb_id,
        )
    )
    # 仍在索引中的文档（queued 与各中间态都算）
    active_count = await db.scalar(
        select(func.count()).select_from(KnowledgeBaseDocument).where(
            KnowledgeBaseDocument.kb_id == kb_id,
            KnowledgeBaseDocument.status.notin_(["indexed", "failed", "canceled"]),
        )
    )

    kb.docs_count = docs_count or 0
    kb.size_bytes = int(size_bytes or 0)
    kb.chunks_count = int(chunks_total or 0)
    kb.entities_count = entity_total or 0
    kb.relations_count = relation_total or 0
    if not docs_count:
        kb.status = "draft"
    elif (active_count or 0) > 0:
        kb.status = "indexing"
    else:
        kb.status = "ready"
    kb.updated_at = datetime.utcnow()


async def recalc_doc_counters(db: AsyncSession, doc_id: str) -> None:
    """按真实数据重算单个文档的分片数与图谱计数。

    切片级增删改后调用：``chunks_count`` 是"已入库切片数"的快照，切片被删掉后
    不重算就会一直虚高（并连带把知识库的分片总数算错）。
    """
    from db.models.knowledge_base_entity import KnowledgeBaseEntity
    from db.models.knowledge_base_relation import KnowledgeBaseRelation

    doc = (
        await db.execute(
            select(KnowledgeBaseDocument).where(KnowledgeBaseDocument.id == doc_id)
        )
    ).scalar_one_or_none()
    if doc is None:
        return

    doc.entities_count = await db.scalar(
        select(func.count()).select_from(KnowledgeBaseEntity).where(
            KnowledgeBaseEntity.doc_id == doc_id,
        )
    ) or 0
    doc.relations_count = await db.scalar(
        select(func.count()).select_from(KnowledgeBaseRelation).where(
            KnowledgeBaseRelation.doc_id == doc_id,
        )
    ) or 0


# ══════════════════════════════════════════════════════════════
# 模板方法模式——IndexingPipeline
# ══════════════════════════════════════════════════════════════

class IndexingPipeline:
    """索引流水线——模板方法模式定义 8 阶段骨架。"""

    def __init__(
        self,
        loader_registry: DocumentLoaderRegistry,
        chunk_registry: ChunkStrategyRegistry,
        embedding_model,
        vector_store: BaseVectorStore,
        graph_service,
        stage_timeout: float = DEFAULT_STAGE_TIMEOUT_SECONDS,
    ):
        self.loader_registry = loader_registry
        self.chunk_registry = chunk_registry
        self.embedding_model = embedding_model
        self.vector_store = vector_store
        self.graph_service = graph_service
        #: 单阶段执行上限（秒）——超时即判定失败并释放并发槽
        self.stage_timeout = stage_timeout
        self._observers: list[ProgressObserver] = []
        self._embedding_cache: dict[tuple[str, str | None], object] = {}
        self._chunk_registry_cache: dict[tuple, ChunkStrategyRegistry] = {}
        self._llm_cache: dict[tuple[str | None, str | None], object] = {}

    def attach(self, observer: ProgressObserver) -> None:
        self._observers.append(observer)

    async def _get_or_create_embedding(
        self,
        model_name: str | None,
        provider_id: str | None = None,
    ):
        """获取或创建 embedding model 实例（缓存避免重复创建）。"""
        if not model_name:
            return self.embedding_model
        cache_key = (model_name, provider_id)
        if cache_key not in self._embedding_cache:
            from api.knowledge_base.model_provider import load_embedding_model
            from db.engine import async_session
            try:
                async with async_session() as session:
                    self._embedding_cache[cache_key] = await load_embedding_model(
                        session,
                        model_name=model_name,
                        provider_id=provider_id,
                    )
            except RuntimeError:
                logger.warning(
                    "未找到知识库配置的 embedding 模型 %s，使用默认实例", model_name
                )
                self._embedding_cache[cache_key] = self.embedding_model
        return self._embedding_cache[cache_key]

    async def _get_or_create_llm(self, config: dict):
        """获取或创建 agentic 切片所需的 LLM 客户端（缓存避免重复创建）。

        使用知识库配置的 LLM（与图谱抽取同一个模型选择）。不可用时返回 ``None``，
        由调用方回退到 recursive 切片——切片能力缺失不应让整个索引失败。
        """
        model_name = config.get("entity_model") or config.get("entityModel")
        provider_id = config.get("entity_provider_id") or config.get("entityProviderId")
        cache_key = (model_name, provider_id)
        if cache_key in self._llm_cache:
            return self._llm_cache[cache_key]

        from core.rag.llm import ChatClient
        from db.engine import async_session

        client: object | None = None
        try:
            async with async_session() as session:
                from api.knowledge_base.model_provider import load_llm_model

                name, api_base, api_key = await load_llm_model(
                    session, model_name=model_name, provider_id=provider_id,
                )
            client = ChatClient(model=name, api_base=api_base, api_key=api_key)
        except RuntimeError as exc:
            logger.warning("Agentic 切片未找到可用 LLM，将回退 recursive 切片: %s", exc)

        self._llm_cache[cache_key] = client
        return client

    def _get_or_create_chunk_registry(self, config: dict, emb_model, llm=None):
        """获取或创建带自定义参数的分片注册表。"""
        chunk_size = config.get("chunk_size") or INDEX_CONFIG_DEFAULTS["chunk_size"]
        chunk_overlap = config.get("chunk_overlap")
        if chunk_overlap is None:
            chunk_overlap = INDEX_CONFIG_DEFAULTS["chunk_overlap"]
        # 缓存键必须包含所有影响切片的配置——漏掉任何一项都会让"改了配置但
        # 切出来还是老样子"
        cache_key = (
            chunk_size,
            chunk_overlap,
            config.get("parent_chunk_size"),
            config.get("min_chunk_size"),
            llm is not None,
        )
        if cache_key not in self._chunk_registry_cache:
            self._chunk_registry_cache[cache_key] = create_chunk_registry(
                config,
                embedding_model=emb_model,
                llm=llm,
            )
        return self._chunk_registry_cache[cache_key]

    def _resolve_strategy(self, config: dict, registry) -> str:
        """确定实际使用的切片策略：请求的策略不可用时回退 recursive。"""
        requested = config.get("chunk_strategy") or "recursive"
        if registry.supports(requested):
            return requested
        logger.warning(
            "切片策略 '%s' 不可用（缺少依赖），本次回退 recursive 切片", requested,
        )
        return "recursive"

    async def _notify(self, ctx: IndexingContext) -> None:
        for observer in self._observers:
            try:
                await observer.on_progress(ctx)
            except Exception as e:
                logger.error("观察者 %s 执行失败: %s", type(observer).__name__, e)

    async def execute(self, task: IndexingTask) -> None:
        """模板方法：定义 8 阶段索引骨架。"""
        # 准备阶段（解析 embedding / 切片注册表）必须在 try 内：此前它跑在 try 之外，
        # 一旦抛错（例如模型页没配 embedding），异常既没被取回、也没写库，文档会
        # 永久停留在 queued 且不可重试。
        try:
            ctx = await self._prepare(task)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.exception("索引初始化失败 doc=%s", task.doc_id)
            await self._fail_without_state(task, f"索引初始化失败: {e}")
            return

        await self._notify(ctx)
        try:
            await self._run_state_machine(ctx)
        except asyncio.CancelledError:
            # 取消（用户操作或服务关停）由调度器/服务层负责落库，这里只向上抛
            raise
        except Exception as e:
            logger.exception("流水线处理文档 %s 失败", task.doc_id)
            await ctx.fail(str(e))
            await self._notify(ctx)

    async def _prepare(self, task: IndexingTask) -> IndexingContext:
        """构建索引上下文（解析模型与切片策略）。"""
        config = task.config

        # 获取该文档使用的 embedding model、切片策略与（agentic 需要的）LLM
        emb_model_name = config.get("embedding_model")
        emb_model = await self._get_or_create_embedding(
            emb_model_name, config.get("embedding_provider_id"),
        )
        requested_strategy = config.get("chunk_strategy") or "recursive"
        llm = await self._get_or_create_llm(config) if requested_strategy == "agentic" else None
        chunk_reg = self._get_or_create_chunk_registry(config, emb_model, llm=llm)

        ctx = IndexingContext(
            doc_id=task.doc_id,
            kb_id=task.kb_id,
            file_path=task.file_path,
            file_type=task.file_type,
            config=config,
            current_state=QueuedState(),
            status="queued",
            progress=0,
            embedding_model=emb_model,
            chunk_registry=chunk_reg,
            chunk_strategy=self._resolve_strategy(config, chunk_reg),
        )

        async def _on_status_change(c: IndexingContext) -> None:
            await self._notify(c)
        ctx.on_status_change = _on_status_change
        return ctx

    async def _fail_without_state(self, task: IndexingTask, message: str) -> None:
        """在状态机尚未建立时把文档标记为失败（仍走观察者，保证计数与事件一致）。"""
        ctx = IndexingContext(
            doc_id=task.doc_id,
            kb_id=task.kb_id,
            file_path=task.file_path,
            file_type=task.file_type,
            config=task.config,
        )

        async def _on_status_change(c: IndexingContext) -> None:
            await self._notify(c)
        ctx.on_status_change = _on_status_change
        ctx.error_message = message
        await ctx.fail(message)

    async def _run_state_machine(self, ctx: IndexingContext) -> None:
        """驱动状态机直到终态；每个阶段都有超时保护。

        没有超时保护时，一次挂死的解析或 LLM 调用会永久占用一个并发槽，
        队列会逐渐停摆（且文档卡在中间态、按旧逻辑还不可重试）。
        """
        while ctx.current_state is not None:
            state = ctx.current_state
            try:
                await asyncio.wait_for(
                    state.handle(ctx, self), timeout=self.stage_timeout,
                )
            except TimeoutError:
                # 文案用中文阶段名：错误信息会直接展示给用户，英文状态名（embedding）
                # 既对不上界面上的阶段列表，也让失败阶段只能靠文案猜（见 compute_stages）
                stage_label = (
                    STAGE_NAMES[STAGE_STATUS_ORDER.index(state.name)]
                    if state.name in STAGE_STATUS_ORDER
                    else state.name
                )
                logger.error(
                    "索引阶段超时 doc=%s stage=%s timeout=%.0fs",
                    ctx.doc_id, state.name, self.stage_timeout,
                )
                await ctx.fail(
                    f"阶段「{stage_label}」执行超时（超过 {self.stage_timeout:g} 秒）"
                )
                break
            if ctx.status in ("indexed", "failed"):
                break


# ══════════════════════════════════════════════════════════════
# 调度器——单例模式
# ══════════════════════════════════════════════════════════════

@dataclass
class IndexingTask:
    kb_id: str
    doc_id: str
    file_path: str
    file_type: str
    config: dict


class IndexingScheduler:
    """索引任务调度器（单例）。

    职责：内存队列 + 并发槽控制 + **任务表持久化** + 启动恢复。

    任务生命周期：``enqueue`` 先落库再进内存队列 → ``_try_start_next`` 占用空闲槽
    → 执行期间由进度观察者刷新心跳 → 终态时观察者把任务行置为终态。
    进程重启后 ``recover_pending`` 把非终态任务重新入队。
    """

    _instance: IndexingScheduler | None = None

    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(
        self,
        pipeline: IndexingPipeline | None = None,
        max_concurrent: int = 3,
        session_factory=None,
    ):
        # 单例只初始化一次：但若首次构造时没传 pipeline（例如测试里先取 instance），
        # 后续带 pipeline 的构造必须能补上，否则所有任务都会静默失败。
        if self._initialized:
            if pipeline is not None and self._pipeline is None:
                self._pipeline = pipeline
            if session_factory is not None and self._session_factory is None:
                self._session_factory = session_factory
            return
        self._initialized = True
        self._pipeline = pipeline
        self._queue: deque[IndexingTask] = deque()
        self._running: dict[str, asyncio.Task] = {}
        self._max_concurrent = max_concurrent
        self._session_factory = session_factory
        self._stopping = False

    @classmethod
    def instance(cls) -> IndexingScheduler | None:
        return cls._instance

    def _resolve_session_factory(self):
        """惰性获取会话工厂（允许测试注入内存库）。"""
        if self._session_factory is None:
            from db.engine import async_session
            self._session_factory = async_session
        return self._session_factory

    # ── 入队 ──────────────────────────────────────────────────────────────

    async def enqueue(self, task: IndexingTask) -> None:
        """入队一个索引任务。

        **调用方必须保证文档行已经提交**——进度观察者用的是独立 session，文档行
        未提交时它会更新到 0 行（或稍后被回滚覆盖成 queued）。
        """
        await self._record_queued(task)
        self._queue.append(task)
        logger.info("任务已入队: 文档=%s, 队列长度=%d", task.doc_id, len(self._queue))
        await self._try_start_next()

    async def _record_queued(self, task: IndexingTask) -> None:
        """把任务写入任务表（按 doc_id 幂等：重复入队只累加尝试次数）。"""
        from db.models.knowledge_base_index_task import (
            TASK_STATUS_QUEUED,
            KnowledgeBaseIndexTask,
        )

        now = datetime.utcnow()
        try:
            async with self._resolve_session_factory()() as db:
                row = (
                    await db.execute(
                        select(KnowledgeBaseIndexTask).where(
                            KnowledgeBaseIndexTask.doc_id == task.doc_id
                        )
                    )
                ).scalar_one_or_none()
                if row is None:
                    db.add(KnowledgeBaseIndexTask(
                        doc_id=task.doc_id,
                        kb_id=task.kb_id,
                        status=TASK_STATUS_QUEUED,
                        attempt=1,  # 首次入队即算一次尝试
                        file_path=task.file_path,
                        file_type=task.file_type,
                        config=task.config,
                        enqueued_at=now,
                        heartbeat_at=now,
                    ))
                else:
                    row.status = TASK_STATUS_QUEUED
                    row.kb_id = task.kb_id
                    row.file_path = task.file_path
                    row.file_type = task.file_type
                    row.config = task.config
                    row.attempt = (row.attempt or 0) + 1
                    row.enqueued_at = now
                    row.heartbeat_at = now
                    row.started_at = None
                    row.finished_at = None
                    row.error_message = None
                await db.commit()
        except Exception:
            # 落库失败不阻断索引（内存队列仍会执行），但必须留下痕迹
            logger.exception("写入索引任务行失败 doc=%s", task.doc_id)

    # ── 启动恢复与停止 ────────────────────────────────────────────────────

    async def recover_pending(self) -> int:
        """恢复上次进程遗留的非终态任务（服务启动时调用）。

        进程刚启动时，所有 ``queued`` / ``running`` 任务都已经没有活的协程，
        因此一律重新入队；文档状态同时回退为 ``queued``，避免界面停在中间态。

        Returns:
            实际重新入队的任务数。
        """
        from db.models.knowledge_base_index_task import (
            TASK_STATUS_QUEUED,
            TASK_STATUS_RUNNING,
            KnowledgeBaseIndexTask,
        )

        tasks: list[IndexingTask] = []
        async with self._resolve_session_factory()() as db:
            rows = list(
                (
                    await db.execute(
                        select(KnowledgeBaseIndexTask).where(
                            KnowledgeBaseIndexTask.status.in_(
                                [TASK_STATUS_QUEUED, TASK_STATUS_RUNNING]
                            )
                        )
                    )
                ).scalars().all()
            )
            if not rows:
                return 0

            doc_ids = [r.doc_id for r in rows]
            docs = {
                d.id: d
                for d in (
                    await db.execute(
                        select(KnowledgeBaseDocument).where(
                            KnowledgeBaseDocument.id.in_(doc_ids)
                        )
                    )
                ).scalars().all()
            }
            for row in rows:
                doc = docs.get(row.doc_id)
                if doc is None:
                    # 文档已被删除，任务行是孤儿
                    await db.delete(row)
                    continue
                doc.status = "queued"
                doc.progress = 0
                doc.error_message = None
                tasks.append(IndexingTask(
                    kb_id=row.kb_id,
                    doc_id=row.doc_id,
                    file_path=row.file_path,
                    file_type=row.file_type,
                    config=row.config or doc.config or {},
                ))
            await db.commit()

        self._stopping = False
        for task in tasks:
            await self.enqueue(task)
        logger.info("索引任务恢复完成：%d 个任务重新入队", len(tasks))
        return len(tasks)

    async def shutdown(self) -> None:
        """停止调度：取消运行中的任务并把它们退回 ``queued``，等待下次启动恢复。"""
        self._stopping = True
        running_doc_ids = list(self._running)
        for task in list(self._running.values()):
            task.cancel()
        if self._running:
            # 等待协程收尾，但必须有上限：如果任务正卡在同步阻塞调用里
            # （例如 pymilvus 的网络等待），无上限的等待会让服务无法退出。
            try:
                await asyncio.wait_for(
                    asyncio.gather(*self._running.values(), return_exceptions=True),
                    timeout=SHUTDOWN_GRACE_SECONDS,
                )
            except TimeoutError:
                logger.warning(
                    "索引任务在 %.0f 秒内未收尾，强制停止（下次启动会重新入队）",
                    SHUTDOWN_GRACE_SECONDS,
                )
        self._running.clear()
        self._queue.clear()

        if running_doc_ids:
            await self._reset_interrupted(running_doc_ids)
        logger.info("索引调度器已停止（中断 %d 个任务）", len(running_doc_ids))

    async def _reset_interrupted(self, doc_ids: list[str]) -> None:
        """把被中断的任务与文档退回 queued。"""
        from db.models.knowledge_base_index_task import (
            TASK_STATUS_QUEUED,
            KnowledgeBaseIndexTask,
        )

        try:
            async with self._resolve_session_factory()() as db:
                await db.execute(
                    update(KnowledgeBaseIndexTask)
                    .where(KnowledgeBaseIndexTask.doc_id.in_(doc_ids))
                    .values(status=TASK_STATUS_QUEUED, started_at=None)
                )
                await db.execute(
                    update(KnowledgeBaseDocument)
                    .where(KnowledgeBaseDocument.id.in_(doc_ids))
                    .values(status="queued", progress=0)
                )
                await db.commit()
        except Exception:
            logger.exception("重置中断任务失败：%s", doc_ids)

    # ── 取消 ──────────────────────────────────────────────────────────────

    async def cancel(self, doc_id: str) -> bool:
        """取消排队中或执行中的任务。

        Returns:
            是否找到并取消了任务（文档状态由调用方负责落库）。
        """
        running = self._running.pop(doc_id, None)
        if running is not None:
            running.cancel()
            logger.info("已取消运行中的索引任务 doc=%s", doc_id)
            return True

        for index, queued in enumerate(self._queue):
            if queued.doc_id == doc_id:
                del self._queue[index]
                logger.info("已从队列移除索引任务 doc=%s", doc_id)
                return True
        return False

    async def cancel_and_wait(self, doc_id: str, timeout: float = CANCEL_GRACE_SECONDS) -> bool:
        """取消任务并**等它真正停下**。

        取消后调用方往往要清理该任务可能已经写入的产物（向量、图谱）。协程的取消是
        协作式的：``cancel()`` 只在下一次 ``await`` 处生效，因此必须等到任务真的退出，
        否则清理完它还能继续往回写。
        """
        running = self._running.get(doc_id)
        if running is None:
            return await self.cancel(doc_id)

        running.cancel()
        # asyncio.wait 不会因任务被取消而抛出 CancelledError（不同于直接 await）
        done, _ = await asyncio.wait({running}, timeout=timeout)
        if not done:
            logger.warning(
                "取消后任务未在 %.1f 秒内停止 doc=%s（可能卡在同步调用里）", timeout, doc_id,
            )
        self._running.pop(doc_id, None)
        logger.info("已取消运行中的索引任务并等待其停止 doc=%s", doc_id)
        return True

    # ── 调度 ──────────────────────────────────────────────────────────────

    async def _try_start_next(self) -> None:
        """在有空闲槽位时尽可能多地启动任务。"""
        if self._stopping:
            return
        if self._pipeline is None:
            if self._queue:
                logger.error(
                    "调度器未绑定索引流水线，%d 个任务无法执行", len(self._queue),
                )
            return

        while self._queue and len(self._running) < self._max_concurrent:
            task = self._queue.popleft()
            async_task = asyncio.create_task(self._pipeline.execute(task))
            self._running[task.doc_id] = async_task
            async_task.add_done_callback(
                lambda finished, doc_id=task.doc_id: self._on_task_done(doc_id, finished)
            )

        if self._queue:
            logger.debug(
                "队列等待中：运行 %d / 上限 %d，剩余 %d",
                len(self._running), self._max_concurrent, len(self._queue),
            )

    def _on_task_done(self, doc_id: str, finished: asyncio.Task) -> None:
        """任务结束回调：取回异常、释放槽位、启动下一个。

        回调里不能 await，因此这里只做同步收尾，需要落库的部分交给后台任务。
        """
        self._running.pop(doc_id, None)

        if finished.cancelled():
            logger.info("索引任务被取消 doc=%s", doc_id)
        else:
            exc = finished.exception()  # 必须取回，否则异常被静默丢弃
            if exc is not None:
                logger.error("索引任务异常退出 doc=%s: %s", doc_id, exc, exc_info=exc)
                self._schedule_fixup(doc_id, str(exc))

        try:
            asyncio.get_running_loop().create_task(self._try_start_next())
        except RuntimeError:
            # 事件循环已在关停流程中关闭
            logger.debug("事件循环已关闭，跳过队列推进")

    def _schedule_fixup(self, doc_id: str, message: str) -> None:
        """异常逃逸时把文档/任务落成 failed，避免永久卡在中间态。"""
        try:
            asyncio.get_running_loop().create_task(self._mark_failed(doc_id, message))
        except RuntimeError:
            logger.debug("事件循环已关闭，跳过失败状态修正 doc=%s", doc_id)

    async def _mark_failed(self, doc_id: str, message: str) -> None:
        from db.models.knowledge_base_index_task import (
            TASK_STATUS_FAILED,
            KnowledgeBaseIndexTask,
        )

        try:
            async with self._resolve_session_factory()() as db:
                # 带状态守卫的更新：异常逃逸的收尾不得覆盖用户刚取消（canceled）
                # 或已经写入的终态（indexed / failed）
                await db.execute(
                    update(KnowledgeBaseDocument)
                    .where(
                        KnowledgeBaseDocument.id == doc_id,
                        KnowledgeBaseDocument.status.notin_(
                            ["indexed", "failed", "canceled"]
                        ),
                    )
                    .values(
                        status="failed",
                        error_message=f"索引任务异常退出: {message}",
                    )
                )
                kb_id = await db.scalar(
                    select(KnowledgeBaseDocument.kb_id).where(
                        KnowledgeBaseDocument.id == doc_id
                    )
                )
                if kb_id:
                    await recalc_kb_counters(db, kb_id)
                await db.execute(
                    update(KnowledgeBaseIndexTask)
                    .where(KnowledgeBaseIndexTask.doc_id == doc_id)
                    .values(
                        status=TASK_STATUS_FAILED,
                        finished_at=datetime.utcnow(),
                        error_message=message,
                    )
                )
                await db.commit()
        except Exception:
            logger.exception("修正失败状态失败 doc=%s", doc_id)


# ══════════════════════════════════════════════════════════════
# 文档业务逻辑
# ══════════════════════════════════════════════════════════════

async def upload_documents(
    db: AsyncSession,
    kb_id: str,
    user_id: str,
    files: list[UploadFile],
    scheduler: IndexingScheduler | None = None,
    custom_config: dict | None = None,
) -> list[KBDocResponse]:
    """上传文档并触发索引流水线。"""
    # 校验知识库
    kb = (
        await db.execute(
            select(KnowledgeBase).where(
                KnowledgeBase.id == kb_id,
                KnowledgeBase.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    if kb is None:
        raise HTTPException(status_code=404, detail="知识库不存在")

    upload_dir = os.path.join(settings.doc_upload_dir, kb_id)
    os.makedirs(upload_dir, exist_ok=True)

    results: list[KBDocResponse] = []
    total_new_bytes = 0
    pending_tasks: list[IndexingTask] = []

    # 先整体校验（文件名 + 已知大小），再落盘：避免第 N 个文件校验失败时
    # 前面已写入的文件成为孤儿（调用方会回滚事务，磁盘上却已经留下文件）。
    sanitized: list[tuple[UploadFile, str, str]] = []
    max_bytes = MAX_FILE_SIZE_MB * 1024 * 1024
    for file in files:
        filename = _sanitize_filename(file.filename or "")
        file_type = _get_file_type(filename)
        if file_type == "unknown":
            raise HTTPException(status_code=400, detail=f"不支持的文件类型: {filename}")
        known_size = getattr(file, "size", None)
        if isinstance(known_size, int) and known_size > max_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"文件 {filename} 超过最大大小 {MAX_FILE_SIZE_MB}MB",
            )
        sanitized.append((file, filename, file_type))

    for file, filename, file_type in sanitized:
        # 读取并校验大小（部分客户端不上报 size，这里兜底）
        content = await file.read()
        if len(content) > max_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"文件 {filename} 超过最大大小 {MAX_FILE_SIZE_MB}MB",
            )

        doc_id = str(uuid.uuid4())
        storage_dir = os.path.join(upload_dir, doc_id)
        os.makedirs(storage_dir, exist_ok=True)
        storage_path = _ensure_within(os.path.join(storage_dir, filename), upload_dir)

        with open(storage_path, "wb") as f:
            f.write(content)

        now = datetime.utcnow()
        doc = KnowledgeBaseDocument(
            id=doc_id,
            kb_id=kb_id,
            name=filename,
            type=file_type,
            size_bytes=len(content),
            storage_path=storage_path,
            status="queued",
            uploaded_at=now,
            config=custom_config,
        )
        db.add(doc)
        total_new_bytes += len(content)

        # 返回体与文档列表（KBDocResponse）保持同一形状：此前只返回 7 个字段，
        # 前端 mapDoc 读 progress/chunks_count/stages 等会拿到 undefined，
        # 上传后立刻显示 NaN 进度。
        results.append(KBDocResponse(
            id=doc_id, name=filename, type=file_type,
            size_display=_format_bytes(len(content)),
            status="queued", progress=STAGE_PROGRESS["queued"],
            chunks_count=0, entities_count=0, relations_count=0,
            uploaded_at=now, indexed_at=None, error_message=None,
            stages=[DocStageInfo(**s) for s in compute_stages("queued")],
            config=IndexConfigSchema(**custom_config) if custom_config else None,
        ))

        # 入队索引任务：自定义配置优先，否则回退到 KB 配置
        if scheduler:
            pending_tasks.append(IndexingTask(
                kb_id=kb_id, doc_id=doc_id, file_path=storage_path,
                file_type=file_type,
                config=custom_config if custom_config else kb.config,
            ))

    # 统计口径统一走 recalc（文档数/体积/分片/实体/状态一次算准）
    await recalc_kb_counters(db, kb_id)
    # **先提交再入队**：进度观察者用独立 session 更新文档行，文档行未提交时
    # 它会更新到 0 行，随后还可能被本事务的 INSERT 覆盖回 queued（状态丢失）。
    await db.commit()

    for task in pending_tasks:
        await scheduler.enqueue(task)  # type: ignore[union-attr]

    return results


async def list_documents(
    db: AsyncSession,
    kb_id: str,
    user_id: str,
    page: int = 1,
    page_size: int = 20,
    search: str | None = None,
    status: str | None = None,
) -> dict:
    """获取文档列表（分页 + 筛选）。可读即可浏览。"""
    from api.knowledge_base.service import require_kb_readable
    await require_kb_readable(db, kb_id, user_id)

    page = max(1, page)
    page_size = max(1, min(page_size, 100))
    offset = (page - 1) * page_size

    conditions = [KnowledgeBaseDocument.kb_id == kb_id]
    if search:
        conditions.append(KnowledgeBaseDocument.name.ilike(f"%{search}%"))
    if status:
        conditions.append(KnowledgeBaseDocument.status == status)

    total = (
        await db.execute(
            select(func.count()).select_from(KnowledgeBaseDocument).where(*conditions)
        )
    ).scalar() or 0

    rows = (
        await db.execute(
            select(KnowledgeBaseDocument)
            .where(*conditions)
            .order_by(KnowledgeBaseDocument.uploaded_at.desc())
            .offset(offset)
            .limit(page_size)
        )
    ).scalars().all()

    items = []
    for r in rows:
        items.append(KBDocResponse(
            id=r.id, name=r.name, type=r.type,
            size_display=_format_bytes(r.size_bytes or 0),
            status=r.status, progress=max(r.progress or 0, 0),
            chunks_count=r.chunks_count or 0,
            entities_count=r.entities_count or 0,
            relations_count=r.relations_count or 0,
            uploaded_at=r.uploaded_at,
            indexed_at=r.indexed_at,
            error_message=r.error_message,
            graph_error=r.graph_error,
            stages=[
                DocStageInfo(**s)
                for s in compute_stages(
                    r.status or "queued", r.error_message, r.progress,
                )
            ],
            config=cast(IndexConfigSchema | None, r.config),
        ))

    return {
        "items": [i.model_dump() for i in items],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


async def get_document(
    db: AsyncSession, kb_id: str, doc_id: str, user_id: str,
) -> KBDocResponse:
    """获取文档详情（含流水线状态）。可读即可查看。"""
    from api.knowledge_base.service import require_kb_readable
    await require_kb_readable(db, kb_id, user_id)

    doc = (
        await db.execute(
            select(KnowledgeBaseDocument).where(
                KnowledgeBaseDocument.id == doc_id,
                KnowledgeBaseDocument.kb_id == kb_id,
            )
        )
    ).scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="文档不存在")

    return KBDocResponse(
        id=doc.id, name=doc.name, type=doc.type,
        size_display=_format_bytes(doc.size_bytes or 0),
        status=doc.status, progress=max(doc.progress or 0, 0),
        chunks_count=doc.chunks_count or 0,
        entities_count=doc.entities_count or 0,
        relations_count=doc.relations_count or 0,
        uploaded_at=doc.uploaded_at,
        indexed_at=doc.indexed_at,
        error_message=doc.error_message,
        graph_error=doc.graph_error,
        stages=[
            DocStageInfo(**s)
            for s in compute_stages(doc.status or "queued", doc.error_message, doc.progress)
        ],
        config=cast(IndexConfigSchema | None, doc.config),
    )


async def delete_document(
    db: AsyncSession, kb_id: str, doc_id: str, user_id: str,
    vector_store: BaseVectorStore | None = None,
    mediator: KnowledgeBaseMediator | None = None,
    scheduler: IndexingScheduler | None = None,
) -> None:
    """删除文档——级联删除向量数据、源文件和图谱数据。

    删除前先取消在跑的索引任务：否则任务会继续往向量库写数据，形成"删不掉的
    孤儿向量"，并不断更新一条已经不存在的文档行。
    """
    from api.knowledge_base.service import _get_kb_or_404
    await _get_kb_or_404(db, kb_id, user_id)

    doc = (
        await db.execute(
            select(KnowledgeBaseDocument).where(
                KnowledgeBaseDocument.id == doc_id,
                KnowledgeBaseDocument.kb_id == kb_id,
            )
        )
    ).scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="文档不存在")

    if scheduler is not None:
        await scheduler.cancel(doc_id)

    # 向量库 + 文件系统清理（优先使用中介者）
    if mediator:
        await mediator.on_document_deleted(kb_id, doc_id, doc.storage_path)
    else:
        if vector_store:
            try:
                await vector_store.delete_by_doc_id(kb_id, doc_id)
            except Exception as e:
                logger.error("删除文档 %s 向量数据失败: %s", doc_id, e)
        storage_dir = os.path.dirname(doc.storage_path)
        if os.path.isdir(storage_dir):
            shutil.rmtree(storage_dir, ignore_errors=True)

    await db.delete(doc)
    await db.flush()

    # 图谱数据按 doc_id 清理，并同步清理任务行

    await db.execute(
        text("DELETE FROM knowledge_base_relations WHERE kb_id = :kb_id AND doc_id = :doc_id"),
        {"kb_id": kb_id, "doc_id": doc_id},
    )
    await db.execute(
        text("DELETE FROM knowledge_base_entities WHERE kb_id = :kb_id AND doc_id = :doc_id"),
        {"kb_id": kb_id, "doc_id": doc_id},
    )
    await db.execute(
        text("DELETE FROM knowledge_base_index_tasks WHERE doc_id = :doc_id"),
        {"doc_id": doc_id},
    )
    await db.flush()

    # 计数一律按真实数据重算，避免"只减不增 / 减错对象"造成的长期漂移
    await recalc_kb_counters(db, kb_id)


async def retry_document(
    db: AsyncSession, kb_id: str, doc_id: str, user_id: str,
    scheduler: IndexingScheduler | None = None,
    vector_store: BaseVectorStore | None = None,
) -> KBDocResponse:
    """重试索引：失败、已取消，或卡在中间态的文档都可以重跑。

    重试前先清掉上一次留下的向量与图谱数据——否则重跑会往同一个 ``doc_id``
    再写一份切片，库内出现重复内容且计数虚高（此前只有整库重建才会清理）。
    """
    from api.knowledge_base.service import _get_kb_or_404
    await _get_kb_or_404(db, kb_id, user_id)

    doc = (
        await db.execute(
            select(KnowledgeBaseDocument).where(
                KnowledgeBaseDocument.id == doc_id,
                KnowledgeBaseDocument.kb_id == kb_id,
            )
        )
    ).scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="文档不存在")

    if doc.status == "indexed":
        raise HTTPException(
            status_code=400,
            detail="文档已索引完成；如需重建请使用「保存并重新索引」",
        )

    # 若任务仍在队列/运行中，先取消再重入队（等价于"重启这个文档的索引"）
    if scheduler is not None:
        await scheduler.cancel(doc_id)

    if vector_store is not None:
        try:
            await vector_store.delete_by_doc_id(kb_id, doc_id)
        except Exception as e:  # noqa: BLE001 - 清理失败不应阻断重试
            logger.warning("重试前清理向量失败 doc=%s: %s", doc_id, e)

    await db.execute(
        text("DELETE FROM knowledge_base_relations WHERE kb_id = :kb_id AND doc_id = :doc_id"),
        {"kb_id": kb_id, "doc_id": doc_id},
    )
    await db.execute(
        text("DELETE FROM knowledge_base_entities WHERE kb_id = :kb_id AND doc_id = :doc_id"),
        {"kb_id": kb_id, "doc_id": doc_id},
    )

    doc.status = "queued"
    doc.progress = 0
    doc.error_message = None
    doc.graph_error = None
    doc.indexed_at = None
    doc.chunks_count = 0
    doc.entities_count = 0
    doc.relations_count = 0

    kb = (
        await db.execute(
            select(KnowledgeBase).where(KnowledgeBase.id == kb_id)
        )
    ).scalar_one_or_none()

    await recalc_kb_counters(db, kb_id)
    # 先提交再入队：进度观察者用独立 session 更新文档行
    await db.commit()

    if scheduler and kb:
        # 重试时使用文档级别的 config（如果存在），否则回退到 KB config
        doc_config = doc.config if doc.config else kb.config
        await scheduler.enqueue(IndexingTask(
            kb_id=kb_id, doc_id=doc_id, file_path=doc.storage_path,
            file_type=doc.type, config=doc_config,
        ))

    return KBDocResponse(
        id=doc.id, name=doc.name, type=doc.type,
        size_display=_format_bytes(doc.size_bytes or 0),
        status=doc.status, progress=doc.progress,
        chunks_count=doc.chunks_count or 0,
        entities_count=doc.entities_count or 0,
        relations_count=doc.relations_count or 0,
        uploaded_at=doc.uploaded_at,
        indexed_at=doc.indexed_at,
        error_message=doc.error_message,
        graph_error=doc.graph_error,
        stages=[DocStageInfo(**s) for s in compute_stages("queued")],
        config=cast(IndexConfigSchema | None, doc.config),
    )


async def cancel_document(
    db: AsyncSession, kb_id: str, doc_id: str, user_id: str,
    scheduler: IndexingScheduler | None = None,
    vector_store: BaseVectorStore | None = None,
) -> KBDocResponse:
    """取消排队中或执行中的索引任务。

    语义是"停下并撤销"：

    1. 等任务真正停止（取消是协作式的，不等它就可能边清理边写）；
    2. 用**带状态守卫的 UPDATE** 把文档置为 ``canceled``——如果流水线恰好在这期间
       完成了索引（已写入 indexed），守卫会让本次取消失败并返回 409，而不是把已完成
       的文档覆盖成"已取消"；
    3. 清掉该文档已写入的向量与图谱：这些是在 bm25 阶段（约 55%）就落库的，
       不清理就会出现"文档显示已取消、内容却仍能被检索到"的错乱状态。

    取消后文档可重试。
    """
    from api.knowledge_base.service import _get_kb_or_404

    await _get_kb_or_404(db, kb_id, user_id)

    doc = (
        await db.execute(
            select(KnowledgeBaseDocument).where(
                KnowledgeBaseDocument.id == doc_id,
                KnowledgeBaseDocument.kb_id == kb_id,
            )
        )
    ).scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="文档不存在")

    if doc.status == "indexed":
        raise HTTPException(status_code=409, detail="文档已索引完成，无需取消")
    if doc.status in ("failed", "canceled"):
        raise HTTPException(status_code=400, detail="文档当前状态不可取消")

    cancelled = (
        await scheduler.cancel_and_wait(doc_id) if scheduler else False
    )

    # 原子判定：只有仍处于非终态时才允许置为 canceled
    result = await db.execute(
        update(KnowledgeBaseDocument)
        .where(
            KnowledgeBaseDocument.id == doc_id,
            KnowledgeBaseDocument.status.notin_(["indexed", "failed", "canceled"]),
        )
        .values(status="canceled", error_message="已取消索引")
    )
    if result.rowcount == 0:
        await db.rollback()
        raise HTTPException(status_code=409, detail="文档已索引完成，无需取消")

    # 清理已写入的产物（向量 + 图谱）
    if vector_store is not None:
        try:
            await vector_store.delete_by_doc_id(kb_id, doc_id)
        except Exception as e:  # noqa: BLE001 - 清理失败不阻断取消
            logger.warning("取消后清理向量失败 doc=%s: %s", doc_id, e)
    await db.execute(
        text("DELETE FROM knowledge_base_relations WHERE kb_id = :kb_id AND doc_id = :doc_id"),
        {"kb_id": kb_id, "doc_id": doc_id},
    )
    await db.execute(
        text("DELETE FROM knowledge_base_entities WHERE kb_id = :kb_id AND doc_id = :doc_id"),
        {"kb_id": kb_id, "doc_id": doc_id},
    )

    from db.models.knowledge_base_index_task import (
        TASK_STATUS_CANCELED,
        KnowledgeBaseIndexTask,
    )

    await db.execute(
        update(KnowledgeBaseIndexTask)
        .where(KnowledgeBaseIndexTask.doc_id == doc_id)
        .values(
            status=TASK_STATUS_CANCELED,
            finished_at=datetime.utcnow(),
            error_message="用户取消索引",
        )
    )

    await db.execute(
        update(KnowledgeBaseDocument)
        .where(KnowledgeBaseDocument.id == doc_id)
        .values(chunks_count=0, entities_count=0, relations_count=0)
    )
    await recalc_kb_counters(db, kb_id)
    await db.commit()

    refreshed = (
        await db.execute(
            select(KnowledgeBaseDocument).where(KnowledgeBaseDocument.id == doc_id)
        )
    ).scalar_one()
    logger.info("文档索引已取消 doc=%s（调度器命中=%s）", doc_id, cancelled)
    return KBDocResponse(
        id=refreshed.id, name=refreshed.name, type=refreshed.type,
        size_display=_format_bytes(refreshed.size_bytes or 0),
        status=refreshed.status, progress=max(refreshed.progress or 0, 0),
        chunks_count=0,
        entities_count=0,
        relations_count=0,
        uploaded_at=refreshed.uploaded_at,
        indexed_at=refreshed.indexed_at,
        error_message=refreshed.error_message,
        graph_error=refreshed.graph_error,
        stages=[
            DocStageInfo(**s)
            for s in compute_stages(
                "canceled", refreshed.error_message, refreshed.progress,
            )
        ],
        config=cast(IndexConfigSchema | None, refreshed.config),
    )
