import asyncio
import json
import logging
import shlex
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from langchain_core.messages import HumanMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.utils.uuid import uuid7
from openai import BadRequestError
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select as sa_select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.background import BackgroundTask

from agent import get_graph_for, get_sandbox_manager
from agent.context.context import Context
from agent.models.resolver import ModelNotConfiguredError
from agent.sandbox.delivery import (
    delivery_host_dir,
    delivery_hint,
    delivery_virtual_dir,
    next_turn_dir,
)
from agent.sandbox.workspace import (
    ensure_workspace,
    normalize_workspace_id,
    workspace_path,
)
from api.agent.artifacts import (
    STATUS_READY,
    Artifact,
    build_bundle_zip,
    get_artifact,
    list_artifacts,
    list_artifacts_without_size,
    mark_artifact_expired,
    persist_artifact,
    persist_pending_artifacts,
    pick_turn_artifacts,
    record_artifacts,
    restore_delivery_artifacts,
    scan_delivery_artifacts,
    update_artifact_size,
)
from api.agent.event_logger import log_event
from api.agent.usage_tracker import record_chat_usage
from api.conversation.conversation_api import create_conversation
from api.experts.prompt_render import normalize_platform
from api.deps import get_current_user_id
from core.response import ok
from core.storage import ArtifactStore, get_artifact_store
from db import get_db
from db.models.conversation import Conversation

logger = logging.getLogger(__name__)

# 模型接口返回 400 时，只有内容审核类错误才提示“安全审核拦截”，
# 其余（如工具名不合法、参数错误）按通用错误返回，避免误导用户
_MODERATION_ERROR_MARKERS = (
    "content_filter",
    "content_policy",
    "content exists risk",
    "data_inspection_failed",
    "sensitive",
    "moderation",
    "risk_control",
    "安全审核",
    "内容审核",
)


def _is_moderation_error(error: Exception) -> bool:
    """判断 400 错误是否来自模型内容审核。.

    Args:
        error: 模型接口抛出的 BadRequestError。

    Returns:
        True 表示属于内容审核拦截，False 表示其他请求参数或格式错误。
    """
    text = str(error).lower()
    return any(marker in text for marker in _MODERATION_ERROR_MARKERS)


def _describe_stream_error(error: BaseException) -> str:
    """把流式对话中途的异常转成面向用户的提示。.

    Args:
        error: 流式消费过程中捕获的异常。

    Returns:
        面向用户的错误提示文案。
    """
    text = str(error).lower()
    sandbox_markers = ("sandboxinternalexception", "network connectivity error", "sandbox")
    if any(marker in text for marker in sandbox_markers):
        return (
            "抱歉，沙箱服务暂时不可用（无法连接 OpenSandbox），本次对话已中断，"
            "请联系管理员检查沙箱服务后重试。"
        )
    return "抱歉，服务处理您的请求时发生了错误，请稍后重试。"

router = APIRouter(prefix="/api")

# 附件文件扩展名分类常量
_IMAGE_EXTS: frozenset[str] = frozenset({
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tiff", "heic", "heif",
})
_AUDIO_EXTS: frozenset[str] = frozenset({
    "mp3", "wav", "ogg", "flac", "aac", "wma", "m4a",
})
_VIDEO_EXTS: frozenset[str] = frozenset({
    "mp4", "webm", "avi", "mov", "mkv", "flv", "wmv",
})


def _classify_path(path: str) -> str:
    """根据文件扩展名返回附件类别标签：IMAGE / AUDIO / VIDEO / FILE。"""
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    if ext in _IMAGE_EXTS:
        return "IMAGE"
    if ext in _AUDIO_EXTS:
        return "AUDIO"
    if ext in _VIDEO_EXTS:
        return "VIDEO"
    return "FILE"


class ChatPart(BaseModel):
    """保序消息部件：文本段或文件引用段（与网页版输入框内容一一对应）。"""

    type: Literal["text", "file"]
    text: str | None = None
    attachment_id: str | None = None
    filename: str | None = None


class ChatRequest(BaseModel):
    user_id: str | None = 'user_123' # TODO
    thread_id: str | None = None
    message: str = ""
    attachment_ids: list[str] | None = None

    # 会话级选择项：全部可选，未传时行为与改造前完全一致
    expert_id: str | None = None
    expert_name: str | None = None
    # 客户端平台（desktop / web / mobile）：决定运行环境说明的渲染口径
    platform: str | None = None
    skill_ids: list[str] | None = None
    kb_ids: list[str] | None = None
    mode: str | None = None
    model: str | None = None
    provider_id: str | None = None
    model_id: str | None = None
    workspace_id: str | None = None
    allow_network: bool | None = None
    allow_shell: bool | None = None
    web_search: bool | None = None
    parts: list[ChatPart] | None = None

    @model_validator(mode="after")
    def _validate_content(self) -> "ChatRequest":
        """message / parts / attachment_ids 至少提供一个，避免空请求进入智能体。"""
        has_message = bool((self.message or "").strip())
        if not (has_message or self.parts or self.attachment_ids):
            raise ValueError("message、parts、attachment_ids 至少需要提供一个")
        return self


class ChatResponse(BaseModel):
    thread_id: str
    response: str
    duration_ms: int | None = None


class StreamToken(BaseModel):
    token: str


async def _resolve_attachment_paths(
    db: AsyncSession, attachment_ids: list[str]
) -> list[str]:
    """将附件 ID 解析为虚拟路径，由 CompositeBackend 路由到本地 FilesystemBackend。

    Returns paths like ``/chat_upload/2026-06-30/uuid.pdf``.
    """
    from api.attachment.repository import get_attachments_by_ids

    attachments = await get_attachments_by_ids(db, attachment_ids)
    return [
        f"/{a.file_path}"
        for a in attachments
        if a.status == "success"
    ]


_MODE_LABELS: dict[str, str] = {
    "default": "默认",
    "files": "引用上传文件",
    "knowledge": "引用知识库",
}


async def _collect_attachment_ids(req: ChatRequest) -> list[str]:
    """合并 attachment_ids 与 parts 中的文件引用（保序去重）。"""
    ids: list[str] = []
    for aid in req.attachment_ids or []:
        if aid and aid not in ids:
            ids.append(aid)
    for part in req.parts or []:
        if part.type == "file" and part.attachment_id and part.attachment_id not in ids:
            ids.append(part.attachment_id)
    return ids


def _prepare_delivery(user_id: str, thread_id: str) -> tuple[str, str]:
    """准备本轮交付目录：返回 (轮次目录名, 虚拟绝对路径)，并在宿主侧建好目录。

    Args:
        user_id: 当前用户 ID。
        thread_id: 当前会话 ID。

    Returns:
        ``(turn_dir, delivery_dir)``，例如 ``("turn-1", "/artifacts/<thread>/turn-1")``。
    """
    turn = next_turn_dir(user_id, thread_id)
    delivery = delivery_virtual_dir(thread_id, turn)
    delivery_host_dir(user_id, thread_id, turn, create=True)
    return turn, delivery


def _build_user_body(req: ChatRequest) -> str:
    """按 parts 还原输入框正文；未传 parts 时退回纯文本 message。"""
    if not req.parts:
        return req.message or ""
    chunks: list[str] = []
    for part in req.parts:
        if part.type == "text":
            if part.text:
                chunks.append(part.text)
        elif part.filename:
            chunks.append("[" + part.filename + "]")
    return "".join(chunks).strip() or (req.message or "")


def _compose_effective_message(
    req: ChatRequest, attachment_paths: list[str], selection_hints: list[str]
) -> str:
    """组装送入智能体的用户消息：会话配置 + 附件清单 + 用户正文。"""
    blocks: list[str] = []
    if selection_hints:
        blocks.append("【会话配置】\n" + "\n".join("- " + h for h in selection_hints))
    if attachment_paths:
        categorized = ["  - [" + _classify_path(p) + "] " + p for p in attachment_paths]
        blocks.append("用户上传了以下附件文件：\n" + "\n".join(categorized))
    blocks.append("用户消息：" + _build_user_body(req))
    return "\n\n".join(blocks)


async def _resolve_selection(
    db: AsyncSession, req: ChatRequest, user_id: str
) -> tuple[list[str], dict[str, Any]]:
    """校验会话级选择项，返回（上下文提示行, 回显数据）。

    校验以数据库为准：不可用的专家 / 技能 / 知识库不会阻塞本次对话，仅记录告警。
    """
    from db.models.expert import Expert
    from db.models.knowledge_base import KnowledgeBase
    from db.models.skill import Skill

    hints: list[str] = []
    payload: dict[str, Any] = {}

    expert = None
    if req.expert_id:
        expert = (
            await db.execute(sa_select(Expert).where(Expert.id == req.expert_id))
        ).scalar_one_or_none()
    if expert is None and req.expert_name:
        expert = (
            await db.execute(sa_select(Expert).where(Expert.name == req.expert_name))
        ).scalar_one_or_none()
    if expert is not None and expert.is_published and expert.status == "active":
        hints.append(
            "【专家】本次任务已选择专家「" + expert.name + "」："
            "必须先用 task 工具把任务交给该专家（subagent_type 使用该专家名称），"
            "任务描述里要带上用户的完整需求与本条【交付目录】信息；"
            "等专家返回后再汇总其产出给用户，不要自己直接完成该专家的写作工作。"
        )
        payload["expert_id"] = expert.id
        payload["expert_name"] = expert.name
    elif req.expert_id or req.expert_name:
        logger.warning(
            "Selection ignored: expert unavailable (%s/%s)",
            req.expert_id,
            req.expert_name,
        )
        payload["expert_missing"] = req.expert_name or req.expert_id

    if req.skill_ids:
        skill_rows = (
            await db.execute(
                sa_select(Skill).where(
                    Skill.id.in_(req.skill_ids),
                    Skill.valid.is_(True),
                    Skill.enabled.is_(True),
                )
            )
        ).scalars().all()
        skill_by_id = {row.id: row for row in skill_rows}
        picked_skills = [skill_by_id[i] for i in req.skill_ids if i in skill_by_id]
        if picked_skills:
            hints.append(
                "【技能】本次任务需要用到以下技能："
                + "、".join(s.name for s in picked_skills)
                + "。"
            )
            payload["skills"] = [{"id": s.id, "name": s.name} for s in picked_skills]
        missing_skills = [i for i in req.skill_ids if i not in skill_by_id]
        if missing_skills:
            logger.warning("Selection ignored: skills unavailable (%s)", missing_skills)

    if req.kb_ids:
        kb_rows = (
            await db.execute(
                sa_select(KnowledgeBase).where(
                    KnowledgeBase.id.in_(req.kb_ids),
                    KnowledgeBase.user_id == user_id,
                )
            )
        ).scalars().all()
        if kb_rows:
            hints.append(
                "【知识库】知识检索范围限定为："
                + "、".join(k.name for k in kb_rows)
                + "，超出该范围的内容不要引用。"
            )
            payload["kbs"] = [{"id": k.id, "name": k.name} for k in kb_rows]
        else:
            logger.warning(
                "Selection ignored: knowledge bases unavailable (%s)", req.kb_ids
            )

    mode = req.mode if req.mode in _MODE_LABELS else None
    if mode and mode != "default":
        hints.append("【模式】当前任务模式：" + _MODE_LABELS[mode] + "。")
    payload["mode"] = mode or "default"
    if req.web_search:
        hints.append("【检索】本次任务允许联网检索。")

    if req.workspace_id:
        normalized = normalize_workspace_id(req.workspace_id)
        if normalized:
            hints.append(
                "【工作区】本次任务的工作目录为 "
                + workspace_path(normalized)
                + "，产物文件请写入该目录，不要写入其它工作区目录。"
            )
    if req.allow_network:
        hints.append("【权限】本次任务允许联网访问外部资源。")
    if req.allow_shell:
        hints.append("【权限】本次任务允许执行命令与代码。")

    # 说明：模型（model / provider_id）当前仅回显；沙箱开关（allow_network / allow_shell）
    # 已注入上下文提示，但真实沙箱策略仍由服务端与管理员配置控制（逐请求覆盖见方案第 10 章）。
    payload["model"] = req.model
    payload["provider_id"] = req.provider_id
    payload["web_search"] = bool(req.web_search)
    payload["allow_network"] = bool(req.allow_network)
    payload["allow_shell"] = bool(req.allow_shell)
    payload["workspace_id"] = req.workspace_id
    return hints, payload


@router.post("/chat", response_model=ChatResponse)
async def chat(
    req: ChatRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db)
):
    import time
    _start_time = time.time()
    is_new = not req.thread_id
    thread_id = req.thread_id or str(uuid7())

    merged_attachment_ids = await _collect_attachment_ids(req)
    resolved_paths: list[str] = []
    if merged_attachment_ids:
        resolved_paths = await _resolve_attachment_paths(db, merged_attachment_ids)

    selection_hints, selection_payload = await _resolve_selection(db, req, user_id)
    # 本轮交付目录：会话 + 轮次子目录（宿主 staging），并注入给模型
    turn_dir, delivery_dir = await asyncio.to_thread(
        _prepare_delivery, user_id, thread_id
    )
    platform = normalize_platform(req.platform)
    selection_hints.append(delivery_hint(thread_id, turn_dir))
    selection_payload["delivery_dir"] = delivery_dir
    selection_payload["platform"] = platform
    if req.allow_network or req.allow_shell or req.workspace_id:
        await log_event(
            db,
            "info",
            "agent",
            f"会话选择项：工作区={req.workspace_id} 联网={bool(req.allow_network)} 代码执行={bool(req.allow_shell)} (thread_id={thread_id})",
        )
    user_body = _build_user_body(req)
    # 会话配置与附件清单并入本次请求正文；attachment_paths 保持为空，
    # 避免下方既有逻辑重复追加附件清单。
    req.message = _compose_effective_message(req, resolved_paths, selection_hints)
    req.attachment_ids = merged_attachment_ids or None
    attachment_paths: list[str] = []

    config: RunnableConfig = {"configurable": {"thread_id": thread_id}}
    workspace_id = normalize_workspace_id(req.workspace_id)
    allow_network = True if req.allow_network is None else bool(req.allow_network)
    allow_shell = True if req.allow_shell is None else bool(req.allow_shell)
    # 按会话「联网访问」开关调整沙箱出网策略（失败仅告警，不阻塞对话）
    try:
        await asyncio.to_thread(
            get_sandbox_manager().apply_session_network_policy, user_id, allow_network
        )
    except Exception:
        logger.warning("Apply session network policy failed", exc_info=True)
    # 按会话工作区在沙箱内创建 /workspace/<id> 目录（失败仅告警）
    if workspace_id:
        try:
            await asyncio.to_thread(
                ensure_workspace,
                get_sandbox_manager().get_or_create_backend(user_id),
                workspace_id,
            )
        except Exception:
            logger.warning("Ensure workspace failed", exc_info=True)

    context = Context(
        server_info="ke_hermes_server",
        user_id=user_id,
        org_id="default-org",  # TODO: 从 JWT claims 或 User 表读取真实 org_id
        allow_network=allow_network,
        allow_shell=allow_shell,
        workspace_id=workspace_id,
        delivery_dir=delivery_dir,
        expert_id=str(selection_payload.get("expert_id") or ""),
        expert_name=str(selection_payload.get("expert_name") or ""),
        platform=platform,
    )

    try:
        effective_message = req.message
        if attachment_paths:
            categorized = [f"  - [{_classify_path(p)}] {p}" for p in attachment_paths]
            paths_text = "\n".join(categorized)
            effective_message = (
                f"用户上传了以下附件文件：\n{paths_text}\n\n用户消息：{req.message}"
            )

        graph = await get_graph_for(req.provider_id, req.model_id)
        result = await graph.ainvoke(
            {"messages": [HumanMessage(content=effective_message)]},
            config=config,
            context=context
        )
    except BadRequestError as e:
        await record_chat_usage(db, user_id, thread_id, _start_time, status="error")
        if _is_moderation_error(e):
            logger.warning("Model rejected request by content moderation: %s", e)
            await log_event(db, "error", "agent", f"对话被安全审核拦截 (thread_id={thread_id})")
            response_text = "抱歉，您的请求被模型安全审核拦截，请尝试换一种表述方式。"
        else:
            logger.warning("Model returned BadRequestError: %s", e)
            await log_event(db, "error", "agent", f"模型接口返回 400 错误 (thread_id={thread_id})")
            response_text = "抱歉，模型服务拒绝了本次请求，请稍后重试或调整输入内容。"
        return ChatResponse(response=response_text, thread_id=thread_id)
    except ModelNotConfiguredError as e:
        # 把「去模型页面配置」这句可执行提示原样回给用户，而不是被下面的
        # 通用分支吞成无信息量的「服务处理您的请求时发生了错误」。
        logger.warning("对话模型未配置：%s", e)
        await record_chat_usage(db, user_id, thread_id, _start_time, status="error")
        await log_event(db, "error", "agent", f"对话模型未配置 (thread_id={thread_id})")
        return ChatResponse(response=str(e), thread_id=thread_id)
    except Exception:
        logger.exception("Agent encountered an unhandled error")
        await record_chat_usage(db, user_id, thread_id, _start_time, status="error")
        await log_event(db, "error", "agent", f"对话处理异常 (thread_id={thread_id})")
        return ChatResponse(
            response="抱歉，服务处理您的请求时发生了错误，请稍后重试。",
            thread_id=thread_id,
        )

    # 新对话自动创建记录；已有对话则合并 attachment_ids
    if is_new:
        await create_conversation(db, user_id, thread_id, user_body, merged_attachment_ids or None)
    elif req.attachment_ids:
        conv_result = await db.execute(
            sa_select(Conversation).where(Conversation.thread_id == thread_id)
        )
        existing_conv = conv_result.scalar_one_or_none()
        if existing_conv:
            existing_ids: list[str] = existing_conv.attachment_ids or []
            merged = list({*existing_ids, *req.attachment_ids})
            existing_conv.attachment_ids = merged
            await db.commit()

    # 记录对话审计信息（Token 用量、耗时等）
    await record_chat_usage(db, user_id, thread_id, _start_time, result=result)
    # 记录系统事件
    await log_event(db, "success", "agent", f"对话完成 (thread_id={thread_id})")

    final_message = result["messages"][-1]
    return ChatResponse(
        response=final_message.content,
        thread_id=thread_id,
        duration_ms=int((time.time() - _start_time) * 1000),
    )


@router.post("/chat/stream")
async def chat_stream(
    req: ChatRequest,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db)):
    import time
    _start_time = time.time()
    is_new = not req.thread_id
    thread_id = req.thread_id or str(uuid7())

    merged_attachment_ids = await _collect_attachment_ids(req)
    resolved_paths: list[str] = []
    if merged_attachment_ids:
        resolved_paths = await _resolve_attachment_paths(db, merged_attachment_ids)

    selection_hints, selection_payload = await _resolve_selection(db, req, user_id)
    # 本轮交付目录：会话 + 轮次子目录（宿主 staging），并注入给模型
    turn_dir, delivery_dir = await asyncio.to_thread(
        _prepare_delivery, user_id, thread_id
    )
    platform = normalize_platform(req.platform)
    selection_hints.append(delivery_hint(thread_id, turn_dir))
    selection_payload["delivery_dir"] = delivery_dir
    selection_payload["platform"] = platform
    if req.allow_network or req.allow_shell or req.workspace_id:
        await log_event(
            db,
            "info",
            "agent",
            f"会话选择项：工作区={req.workspace_id} 联网={bool(req.allow_network)} 代码执行={bool(req.allow_shell)} (thread_id={thread_id})",
        )
    user_body = _build_user_body(req)
    # 会话配置与附件清单并入本次请求正文；attachment_paths 保持为空，
    # 避免下方既有逻辑重复追加附件清单。
    req.message = _compose_effective_message(req, resolved_paths, selection_hints)
    req.attachment_ids = merged_attachment_ids or None
    attachment_paths: list[str] = []

    config: RunnableConfig = {"configurable": {"thread_id": thread_id}, "recursion_limit": 50}
    workspace_id = normalize_workspace_id(req.workspace_id)
    allow_network = True if req.allow_network is None else bool(req.allow_network)
    allow_shell = True if req.allow_shell is None else bool(req.allow_shell)
    # 按会话「联网访问」开关调整沙箱出网策略（失败仅告警，不阻塞对话）
    try:
        await asyncio.to_thread(
            get_sandbox_manager().apply_session_network_policy, user_id, allow_network
        )
    except Exception:
        logger.warning("Apply session network policy failed", exc_info=True)
    # 按会话工作区在沙箱内创建 /workspace/<id> 目录（失败仅告警）
    if workspace_id:
        try:
            await asyncio.to_thread(
                ensure_workspace,
                get_sandbox_manager().get_or_create_backend(user_id),
                workspace_id,
            )
        except Exception:
            logger.warning("Ensure workspace failed", exc_info=True)

    context = Context(
        server_info="ke_hermes_server",
        user_id=user_id,
        org_id="default-org",  # TODO: 从 JWT claims 或 User 表读取真实 org_id
        allow_network=allow_network,
        allow_shell=allow_shell,
        workspace_id=workspace_id,
        delivery_dir=delivery_dir,
        expert_id=str(selection_payload.get("expert_id") or ""),
        expert_name=str(selection_payload.get("expert_name") or ""),
        platform=platform,
    )

    effective_message = req.message
    if attachment_paths:
        categorized = [f"  - [{_classify_path(p)}] {p}" for p in attachment_paths]
        paths_text = "\n".join(categorized)
        effective_message = (
            f"用户上传了以下附件文件：\n{paths_text}\n\n用户消息：{req.message}"
        )

    async def event_generator():
        queue: asyncio.Queue[dict | None] = asyncio.Queue()
        run_failed = False
        # 本次流已推送过 artifact 事件的产物标识（artifact_id 或路径）
        emitted_artifacts: set[str] = set()

        async def push_new_turn_artifacts() -> None:
            """补推本轮交付目录中尚未推送过的产物事件。

            ``download_asset`` 等工具在工具内部直接登记产物，基于工具入参的登记
            逻辑看不到「新增」，因此需要按交付目录差集补推，否则前端当轮拿不到
            交付物卡片与打包入口。
            """
            try:
                items = await list_artifacts(thread_id, user_id)
            except Exception:
                logger.warning(
                    "读取本轮交付物失败（thread_id=%s）", thread_id, exc_info=True
                )
                return
            for artifact in pick_turn_artifacts(items, delivery_dir, emitted_artifacts):
                await queue.put({
                    "event": "artifact",
                    "data": artifact.to_dict(),
                })

        async def consume_all() -> None:
            nonlocal run_failed
            try:
                # 在图解析放在 try 内：本端点没有 @handle_errors，若在生成器外抛错，
                # 客户端只会拿到一个无信息量的裸 500。
                graph = await get_graph_for(req.provider_id, req.model_id)
                stream = await graph.astream_events(
                    {"messages": [HumanMessage(content=effective_message)]},
                    config=config,
                    context=context,
                    version="v3",
                )

                # 回显本次生效的会话选择项（专家 / 技能 / 知识库 / 模式等）
                await queue.put({"event": "selection", "data": selection_payload})

                # Emit main agent start before any consumer output
                await queue.put({
                    "event": "agent_start",
                    "data": {"agent_name": "main", "agent_type": "main", "call_id": "root"}
                })

                async def consume_messages() -> None:
                    async for message in stream.messages:
                        async for delta in message.reasoning:
                            await queue.put({
                                "event": "reasoning",
                                "data": {"agent_name": "main", "content": delta},
                            })
                        async for delta in message.text:
                            await queue.put({
                                "event": "token",
                                "data": {"agent_name": "main", "content": delta},
                            })

                async def consume_tool_calls() -> None:
                    async for call in stream.tool_calls:
                        call_id = str(uuid7())
                        input_str = json.dumps(call.input, ensure_ascii=False, default=str)
                        await queue.put({
                            "event": "tool_start",
                            "data": {
                                "tool_name": call.tool_name,
                                "call_id": call_id,
                                "agent_name": "main",
                                "input": input_str,
                            }
                        })
                        async for delta in call.output_deltas:
                            await queue.put({
                                "event": "tool_output",
                                "data": {"call_id": call_id, "content": str(delta)},
                            })
                        output_str = str(call.output) if call.output is not None else ""
                        error_str = str(call.error) if call.error is not None else ""
                        await queue.put({
                            "event": "tool_end",
                            "data": {
                                "tool_name": call.tool_name,
                                "call_id": call_id,
                                "output": error_str or output_str,
                            }
                        })

                        # 识别本次工具调用产生的产物文件并推送 artifact 事件
                        for artifact in await record_artifacts(
                            thread_id, user_id, call.tool_name, input_str
                        ):
                            emitted_artifacts.add(artifact.artifact_id or artifact.path)
                            await queue.put({
                                "event": "artifact",
                                "data": artifact.to_dict(),
                            })
                        # 工具自身已登记的交付物（如 download_asset 代理下载的配图）补推事件
                        await push_new_turn_artifacts()

                async def consume_subagents() -> None:
                    async for subagent in stream.subagents:
                        call_id = str(uuid7())
                        await queue.put({
                            "event": "agent_start",
                            "data": {
                                "agent_name": subagent.name,
                                "agent_type": "sub",
                                "call_id": call_id,
                            }
                        })
                        try:
                            async for message in subagent.messages:
                                async for delta in message.reasoning:
                                    await queue.put({
                                        "event": "reasoning",
                                        "data": {"agent_name": subagent.name, "content": delta},
                                    })
                                async for delta in message.text:
                                    await queue.put({
                                        "event": "token",
                                        "data": {"agent_name": subagent.name, "content": delta},
                                    })
                        except Exception as e:
                            subagent_error = getattr(subagent, "error", None) or str(e)
                            subagent_status = getattr(subagent, "status", "failed")
                            logger.warning(
                                "Subagent '%s' failed — status=%s, error=%s",
                                subagent.name, subagent_status, subagent_error,
                            )
                            await queue.put({
                                "event": "agent_end",
                                "data": {
                                    "agent_name": subagent.name,
                                    "call_id": call_id,
                                    "status": subagent_status,
                                    "error": subagent_error,
                                }
                            })
                            continue
                        await queue.put({
                            "event": "agent_end",
                            "data": {
                                "agent_name": subagent.name,
                                "call_id": call_id,
                                "status": subagent.status,
                            }
                        })

                results = await asyncio.gather(
                    consume_messages(), consume_tool_calls(), consume_subagents(),
                    return_exceptions=True,
                )
                stream_error: BaseException | None = None
                for result in results:
                    if isinstance(result, BadRequestError):
                        raise result
                    if isinstance(result, BaseException):
                        logger.warning("Stream consumer aborted: %s", result)
                        stream_error = stream_error or result
                # 运行期异常必须回传前端，否则用户只会看到一条空回复
                if stream_error is not None:
                    run_failed = True
                    await queue.put({
                        "event": "error",
                        "data": {"message": _describe_stream_error(stream_error)},
                    })

                # Emit main agent end after all consumers finish
                await queue.put({
                    "event": "agent_end",
                    "data": {"agent_name": "main", "call_id": "root", "status": "completed"}
                })

            except BadRequestError as e:
                run_failed = True
                if _is_moderation_error(e):
                    logger.warning("Model rejected stream by content moderation: %s", e)
                    error_message = "抱歉，您的请求被模型安全审核拦截，请尝试换一种表述方式。"
                else:
                    logger.warning("Model returned BadRequestError in stream: %s", e)
                    error_message = "抱歉，模型服务拒绝了本次请求，请稍后重试或调整输入内容。"
                await queue.put({
                    "event": "error",
                    "data": {"message": error_message},
                })
            except ModelNotConfiguredError as e:
                run_failed = True
                logger.warning("流式对话模型未配置：%s", e)
                await queue.put({
                    "event": "error",
                    "data": {"message": str(e)},
                })
            except Exception:
                run_failed = True
                logger.exception("Agent stream encountered an unhandled error")
                await queue.put({
                    "event": "error",
                    "data": {"message": "抱歉，服务处理您的请求时发生了错误，请稍后重试。"},
                })
            finally:
                await queue.put(None)

        consumer = asyncio.create_task(consume_all())

        try:
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=0.5)
                except TimeoutError:
                    if await request.is_disconnected():
                        logger.info("Client disconnected, cancelling agent stream")
                        consumer.cancel()
                        break
                    continue
                if item is None:
                    break
                yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
        except asyncio.CancelledError:
            logger.info("Stream generator cancelled, cleaning up consumer")
            consumer.cancel()
            raise

        await consumer

        # 轮末兜底：把交付目录中未被工具登记的文件补登记并物化（脚本产物等）
        try:
            scanned = await scan_delivery_artifacts(user_id, thread_id, turn_dir)
            if scanned:
                logger.info(
                    "交付目录扫描补登记 %d 个产物（thread_id=%s）", len(scanned), thread_id
                )
        except Exception:
            logger.warning("交付目录扫描失败（thread_id=%s）", thread_id, exc_info=True)

        # 流结束后补全产物元信息（物化 + 文件大小），并把最新元信息推给前端
        updated_artifacts = await _enrich_artifact_sizes(user_id, thread_id)

        # 轮末补推本轮尚未推送过的交付物（轮末扫描登记的文章等），保证消息里出现交付物卡片
        try:
            turn_items = await list_artifacts(thread_id, user_id)
            for artifact in pick_turn_artifacts(turn_items, delivery_dir, emitted_artifacts):
                yield f"data: {json.dumps({'event': 'artifact', 'data': artifact.to_dict()}, ensure_ascii=False)}\n\n"
        except Exception:
            logger.warning("轮末补推交付物事件失败（thread_id=%s）", thread_id, exc_info=True)

        for updated_artifact in updated_artifacts:
            yield f"data: {json.dumps({'event': 'artifact_updated', 'data': updated_artifact.to_dict()}, ensure_ascii=False)}\n\n"

        yield f"data: {json.dumps({'event': 'done', 'data': {'thread_id': thread_id, 'duration_ms': int((time.time() - _start_time) * 1000)}}, ensure_ascii=False)}\n\n"

        if is_new:
            try:
                await create_conversation(db, user_id, thread_id, user_body, merged_attachment_ids or None)
            except Exception:
                logger.exception("Failed to create conversation record")
        elif req.attachment_ids:
            try:
                conv_result = await db.execute(
                    sa_select(Conversation).where(Conversation.thread_id == thread_id)
                )
                existing_conv = conv_result.scalar_one_or_none()
                if existing_conv:
                    existing_ids: list[str] = existing_conv.attachment_ids or []
                    merged = list({*existing_ids, *req.attachment_ids})
                    existing_conv.attachment_ids = merged
                    await db.commit()
            except Exception:
                logger.exception("Failed to merge attachment_ids")

        # 记录对话审计信息（Token 用量、耗时等）
        await record_chat_usage(
            db, user_id, thread_id, _start_time,
            status="error" if run_failed else "success",
        )
        # 记录系统事件
        if run_failed:
            await log_event(db, "error", "agent", f"流式对话失败 (thread_id={thread_id})")
        else:
            await log_event(db, "success", "agent", f"流式对话完成 (thread_id={thread_id})")

    return StreamingResponse(event_generator(), media_type="text/event-stream")


async def _enrich_artifact_sizes(user_id: str, thread_id: str) -> list[Artifact]:
    """流结束后收尾产物：兜底物化未就绪项并补全大小，返回需通知前端的产物。"""
    touched: set[str] = set()

    try:
        saved = await persist_pending_artifacts(user_id, thread_id)
        for item in saved:
            touched.add(item.artifact_id or item.path)
        if saved:
            logger.info("流结束后补物化 %d 个产物（thread_id=%s）", len(saved), thread_id)
    except Exception:
        logger.warning("流结束后补物化产物失败（thread_id=%s）", thread_id, exc_info=True)

    try:
        pending = await list_artifacts_without_size(thread_id)
        if pending:
            paths = [item.path for item in pending][:20]
            quoted = " ".join(shlex.quote(item) for item in paths)
            backend = get_sandbox_manager().get_or_create_backend(user_id)
            result = await asyncio.to_thread(backend.execute, "stat -c '%s|%n' " + quoted)
            output = getattr(result, "output", "") or ""
            for line in output.splitlines():
                size_text, _, raw_path = line.partition("|")
                if not size_text.strip().isdigit():
                    continue
                artifact_path = raw_path.strip()
                await update_artifact_size(thread_id, artifact_path, int(size_text))
                touched.add(artifact_path)
    except Exception:
        logger.warning(
            "Enrich artifact sizes failed (thread_id=%s)", thread_id, exc_info=True
        )

    if not touched:
        return []
    try:
        items = await list_artifacts(thread_id, user_id)
    except Exception:
        logger.warning("回读产物元信息失败（thread_id=%s）", thread_id, exc_info=True)
        return []
    return [item for item in items if (item.artifact_id or item.path) in touched]


@router.get("/chat/artifacts/{thread_id}")
async def list_chat_artifacts(
    thread_id: str,
    user_id: str = Depends(get_current_user_id),
):
    """列出指定会话已登记的产物文件（持久化于 chat_artifacts 表）。"""
    items = await list_artifacts(thread_id, user_id)
    return ok([item.to_dict() for item in items])


@router.get("/chat/artifacts/{thread_id}/download")
async def download_chat_artifact(
    request: Request,
    thread_id: str,
    path: str,
    disposition: str = "attachment",
    user_id: str = Depends(get_current_user_id),
):
    """下载或预览会话产物（优先读取持久副本，沙箱仅作兜底来源）。

    Args:
        request: 原始请求，用于读取 Range 头。
        thread_id: 会话 ID。
        path: 沙箱内产物路径（沿用既有参数，服务端映射到持久对象）。
        disposition: ``attachment`` 触发下载，``inline`` 用于页面内预览。
        user_id: 当前登录用户。

    Returns:
        产物文件响应；本地存储走 FileResponse，对象存储按 Range 返回字节。
    """
    artifact = await get_artifact(thread_id, user_id, path)
    if artifact is None:
        raise HTTPException(status_code=404, detail="产物不存在或不属于该会话")

    store = get_artifact_store()
    artifact = await _ensure_materialized(user_id, thread_id, artifact, store)
    if artifact is None:
        raise HTTPException(status_code=410, detail="文件已过期，无法恢复")

    key = artifact.storage_key
    filename = quote(artifact.name or "artifact")
    mode = "inline" if disposition == "inline" else "attachment"
    media_type = artifact.mime_type or "application/octet-stream"
    headers = {"Content-Disposition": f"{mode}; filename*=UTF-8''{filename}"}

    local_path = store.local_path(key)
    if local_path is not None and await asyncio.to_thread(store.exists, key):
        return FileResponse(local_path, media_type=media_type, headers=headers)

    return await _storage_response(request, store, key, media_type, headers)


@router.get("/chat/artifacts/{thread_id}/bundle.zip")
async def download_artifact_bundle(
    thread_id: str,
    scope: str = "turn",
    turn: str | None = None,
    user_id: str = Depends(get_current_user_id),
):
    """打包下载交付目录（scope=turn 本轮 / scope=thread 整个会话）。

    留存期清理会删除宿主 staging 里的旧交付文件，而持久层副本仍在；因此打包前
    先按持久层回填缺失文件，否则历史会话会打成空包（方案 P1-1）。zip 落到临时
    文件后流式返回，避免整包驻留内存（方案 P1-2）。

    Args:
        thread_id: 会话 ID。
        scope: ``turn`` 只打包本轮；``thread`` 打包整个会话。
        turn: 指定轮次目录名（缺省取最新一轮）。
        user_id: 当前登录用户。

    Returns:
        zip 响应；无内容或不属于该用户时返回 404。
    """
    normalized_scope = "thread" if scope == "thread" else "turn"
    try:
        await restore_delivery_artifacts(user_id, thread_id)
    except Exception:
        logger.warning("打包前回填交付目录失败（thread_id=%s）", thread_id, exc_info=True)

    packed = await asyncio.to_thread(
        build_bundle_zip, user_id, thread_id, scope=normalized_scope, turn=turn
    )
    if packed is None:
        raise HTTPException(status_code=404, detail="没有可打包的交付文件")

    archive_name, zip_path, _count = packed
    headers = {
        "Content-Disposition": "attachment; filename*=UTF-8''" + quote(archive_name, safe="")
    }
    return FileResponse(
        zip_path,
        media_type="application/zip",
        headers=headers,
        background=BackgroundTask(_remove_quietly, zip_path),
    )


def _remove_quietly(path: Path) -> None:
    """删除临时文件（清理失败不影响已开始的响应）。"""
    try:
        Path(path).unlink(missing_ok=True)
    except OSError:
        logger.warning("临时 zip 清理失败：%s", path, exc_info=True)


async def _ensure_materialized(
    user_id: str, thread_id: str, artifact: Artifact, store: ArtifactStore
) -> Artifact | None:
    """确保产物存在持久副本；缺失时尝试从沙箱补一次物化。

    Args:
        user_id: 当前登录用户。
        thread_id: 会话 ID。
        artifact: 已登记的产物。
        store: 产物存储实例。

    Returns:
        可用产物；持久副本与沙箱均不可用时返回 None（并标记过期）。
    """
    if artifact.storage_key and artifact.status == STATUS_READY:
        if await asyncio.to_thread(store.exists, artifact.storage_key):
            return artifact
    if artifact.artifact_id:
        refreshed = await persist_artifact(user_id, thread_id, artifact.artifact_id)
        if refreshed is not None and refreshed.storage_key:
            if await asyncio.to_thread(store.exists, refreshed.storage_key):
                return refreshed
    await mark_artifact_expired(thread_id, artifact.artifact_id)
    return None


async def _storage_response(
    request: Request,
    store: ArtifactStore,
    key: str,
    media_type: str,
    headers: dict[str, str],
) -> Response:
    """从对象存储读取产物并构造响应（支持单段 Range 请求）。

    Args:
        request: 原始请求。
        store: 产物存储实例。
        key: 产物存储键。
        media_type: 响应媒体类型。
        headers: 基础响应头。

    Returns:
        完整内容响应或 206 部分内容响应。

    Raises:
        HTTPException: 对象在存储侧已不存在（410）。
    """
    total = await asyncio.to_thread(store.size, key)
    if total is None:
        raise HTTPException(status_code=410, detail="文件已过期，无法恢复")

    byte_range = _parse_byte_range(request.headers.get("range"), total)
    if byte_range is None:
        content = await asyncio.to_thread(store.read, key, 0, None)
        if content is None:
            raise HTTPException(status_code=410, detail="文件已过期，无法恢复")
        return Response(content=content, media_type=media_type, headers=headers)

    start, end = byte_range
    chunk = await asyncio.to_thread(store.read, key, start, end - start + 1)
    if chunk is None:
        raise HTTPException(status_code=410, detail="文件已过期，无法恢复")
    return Response(
        content=chunk,
        status_code=206,
        media_type=media_type,
        headers={
            **headers,
            "Accept-Ranges": "bytes",
            "Content-Range": f"bytes {start}-{end}/{total}",
        },
    )


def _parse_byte_range(header: str | None, total: int) -> tuple[int, int] | None:
    """解析单段 ``Range`` 请求头；无法解析或不适用时返回 None（按完整内容返回）。

    Args:
        header: 原始 Range 头。
        total: 对象总字节数。

    Returns:
        ``(起始偏移, 结束偏移)`` 闭区间；不支持或越界时返回 None。
    """
    if not header or total <= 0 or not header.startswith("bytes="):
        return None
    spec = header[len("bytes=") :].split(",", 1)[0].strip()
    start_text, _, end_text = spec.partition("-")
    try:
        if not start_text:
            suffix = int(end_text)
            if suffix <= 0:
                return None
            start = max(0, total - suffix)
            end = total - 1
        else:
            start = int(start_text)
            end = int(end_text) if end_text else total - 1
    except ValueError:
        return None
    if start < 0 or start >= total:
        return None
    end = min(end, total - 1)
    if end < start:
        return None
    return start, end


POLISH_INSTRUCTION = (
    "请把下面这段任务描述改写得更清晰、具体、可执行，保持原意与语言，"
    "直接输出改写后的文本，不要添加解释、标题或前后缀。"
)
# 单次改写的文本上限与分片阈值（超出阈值按段落分片，逐片改写后拼接）
POLISH_CHUNK_CHARS = 1500
POLISH_MAX_CHUNKS = 8


class PolishRequest(BaseModel):
    """AI 改写润色请求体（长文本由服务端分片处理）。"""

    text: str = Field(min_length=1, max_length=POLISH_CHUNK_CHARS * POLISH_MAX_CHUNKS)


def split_for_polish(text: str, limit: int = POLISH_CHUNK_CHARS) -> list[str]:
    """按空行/段落切分长文本，单段超出上限时硬切；短文本返回单元素列表。"""
    if len(text) <= limit:
        return [text]

    chunks: list[str] = []
    current = ""
    for paragraph in text.split("\n"):
        piece = paragraph if not current else current + "\n" + paragraph
        if len(piece) <= limit:
            current = piece
            continue
        if current:
            chunks.append(current)
        # 单段自身超长：按上限硬切
        while len(paragraph) > limit:
            chunks.append(paragraph[:limit])
            paragraph = paragraph[limit:]
        current = paragraph
    if current:
        chunks.append(current)
    return chunks


@router.post("/chat/polish")
async def polish_text(
    req: PolishRequest,
    user_id: str = Depends(get_current_user_id),
):
    """把用户输入改写为更清晰、具体、可执行的任务描述（长文本自动分片）。"""
    from agent.common import resolve_model

    chunks = split_for_polish(req.text)
    if len(chunks) > POLISH_MAX_CHUNKS:
        raise HTTPException(
            status_code=413,
            detail=f"文本过长，最多支持 {POLISH_CHUNK_CHARS * POLISH_MAX_CHUNKS} 个字符",
        )

    try:
        model = await resolve_model(None, None)
        polished: list[str] = []
        for chunk in chunks:
            result = await model.ainvoke(POLISH_INSTRUCTION + "\n\n" + chunk)
            content = getattr(result, "content", result)
            if isinstance(content, list):
                content = "".join(str(part) for part in content)
            polished.append(str(content).strip())
    except ModelNotConfiguredError as e:
        logger.warning("改写功能未配置对话模型：%s", e)
        raise HTTPException(status_code=503, detail=str(e))
    except Exception:
        logger.exception("Polish text failed")
        raise HTTPException(status_code=500, detail="改写失败，请稍后重试")

    return ok({"text": "\n\n".join(item for item in polished if item), "chunks": len(chunks)})
