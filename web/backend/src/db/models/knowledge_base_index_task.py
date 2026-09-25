"""知识库索引任务——索引队列的持久化表示。

此前队列只是进程内的 ``collections.deque``：进程重启后队列丢失，正在进行中的
文档会永久停留在中间状态，而重试接口只接受 ``failed``，用户无法自救。本表把
每个待执行 / 执行中的索引任务落库，服务启动时据此恢复。

与 ``knowledge_base_documents.status`` 的关系：文档状态是**执行进度**，任务状态是
**调度生命周期**（排队中 / 执行中 / 已结束）。二者由调度器同步维护，文档被删除时
任务行一并清理。
"""

import uuid
from datetime import datetime

from sqlalchemy import JSON, DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base

# 任务生命周期状态
TASK_STATUS_QUEUED = "queued"      # 已入队，等待空闲槽位
TASK_STATUS_RUNNING = "running"    # 正在执行
TASK_STATUS_SUCCEEDED = "succeeded"
TASK_STATUS_FAILED = "failed"
TASK_STATUS_CANCELED = "canceled"

TASK_TERMINAL_STATUSES = (
    TASK_STATUS_SUCCEEDED,
    TASK_STATUS_FAILED,
    TASK_STATUS_CANCELED,
)


class KnowledgeBaseIndexTask(Base):
    """一次索引任务（每个文档至多一条活动记录）。"""

    __tablename__ = "knowledge_base_index_tasks"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    doc_id: Mapped[str] = mapped_column(
        String(36), nullable=False, unique=True, index=True
    )
    kb_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    status: Mapped[str] = mapped_column(
        String(16), default=TASK_STATUS_QUEUED, index=True
    )
    attempt: Mapped[int] = mapped_column(Integer, default=0, comment="已尝试次数")
    file_path: Mapped[str] = mapped_column(String(512), nullable=False)
    file_type: Mapped[str] = mapped_column(String(16), nullable=False)
    config: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    #: 写入目标物理集合——重建期间为临时集合名（读路径仍指向正式集合）。
    #: 必须落库：进程重启后恢复的任务要继续写同一个临时集合，否则会被写进
    #: 正式集合、与"重建完成前不切换"的语义相互矛盾。
    target_collection: Mapped[str | None] = mapped_column(String(255), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    enqueued_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    heartbeat_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True, comment="执行中心跳时间，用于判定任务是否失联"
    )
