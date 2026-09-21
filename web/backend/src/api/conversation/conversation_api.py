import json
import logging
import re
from datetime import UTC
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agent import get_checkpointer, get_graph
from api.agent.artifacts import delete_artifacts_by_thread
from api.deps import get_current_user_id
from core.decorators import handle_errors
from core.response import ok
from db import get_db
from db.models import Conversation
from db.models.ai_model import AIModel
from db.models.chat_attachment import ChatAttachment
from db.models.chat_usage import ChatUsage

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["conversations"])

# ---- 辅助函数 ----


def _message_to_dict(msg) -> dict:
    """将 LangChain 消息对象转换为通用字典格式 {"role": ..., "content": ...}。

    处理三种 content 类型的 AIMessage：
    - 字符串：直接使用，不变
    - 列表（含 tool_call 块的场景）：只提取 text 块并拼接
    - 列表（纯 tool_call，无文本）：返回空字符串

    ToolMessage 格式化为与实时对话 normal 模式一致的 markdown 标签。
    """
    type_map = {
        SystemMessage: "system",
        HumanMessage: "user",
        AIMessage: "assistant",
        ToolMessage: "tool",
    }
    role = "unknown"
    for msg_type, name in type_map.items():
        if isinstance(msg, msg_type):
            role = name
            break

    raw_content = getattr(msg, "content", "")

    # AIMessage 列表 content（工具调用场景）：只提取 text 块
    if role == "assistant" and isinstance(raw_content, list):
        text_parts: list[str] = []
        for block in raw_content:
            if isinstance(block, dict) and block.get("type") == "text":
                text_parts.append(str(block.get("text", "")))
        return {"role": role, "content": "".join(text_parts)}

    # ToolMessage：格式化为可读的 markdown 标签
    if role == "tool":
        tool_name = getattr(msg, "name", "") or "工具"
        output = str(raw_content) if raw_content else ""
        return {
            "role": role,
            "content": f"\n\n---\n**{tool_name}** 输出：\n{output}\n",
        }

    return {"role": role, "content": str(raw_content) if raw_content else ""}


def _extract_text(msg: Any) -> str:
    """提取消息的纯文本内容（list content 只取 text 块）."""
    content = getattr(msg, "content", "")
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
        return "".join(parts)
    return str(content) if content else ""


def _extract_tool_calls(msg: Any) -> list[dict]:
    """提取 AIMessage 的工具调用（优先 tool_calls 字段，回退 list content 的 tool_call 块）."""
    calls = list(getattr(msg, "tool_calls", None) or [])
    if calls:
        return calls
    content = getattr(msg, "content", None)
    if isinstance(content, list):
        return [b for b in content if isinstance(b, dict) and b.get("type") == "tool_call"]
    return []


def _dump_tool_args(args: Any) -> str:
    """序列化工具入参，与实时对话 tool_start 事件的 input 字段保持一致."""
    if not args:
        return ""
    return json.dumps(args, ensure_ascii=False, default=str)


def _assistant_blocks(msg: Any, index: int) -> list[dict]:
    """把 AIMessage 转成前端执行块（text / tool_call）.

    工具输出由后续 ToolMessage 回填，见 _apply_tool_output()。
    """
    blocks: list[dict] = []
    text = _extract_text(msg)
    if text:
        blocks.append({"type": "text", "content": text})

    msg_id = str(getattr(msg, "id", None) or f"assistant-{index}")
    for idx, call in enumerate(_extract_tool_calls(msg)):
        if not isinstance(call, dict):
            continue
        blocks.append({
            "type": "tool_call",
            "tool_call": {
                "call_id": str(call.get("id") or f"{msg_id}-{idx}"),
                "name": str(call.get("name") or "工具"),
                "input": _dump_tool_args(call.get("args")),
                "output": "",
                "status": "completed",
            },
        })
    return blocks


def _apply_tool_output(pending_calls: list[dict], tool_msg: Any) -> None:
    """把 ToolMessage 输出回填到对应工具调用块；call_id 缺失时按先后顺序兜底."""
    call_id = str(getattr(tool_msg, "tool_call_id", "") or "")
    target: dict | None = None
    if call_id:
        target = next(
            (c for c in pending_calls if c["call_id"] == call_id and not c["output"]),
            None,
        )
    if target is None:
        target = next((c for c in pending_calls if not c["output"]), None)
    if target is None:
        return

    target["output"] = str(getattr(tool_msg, "content", "") or "")
    target["status"] = (
        "failed" if getattr(tool_msg, "status", None) == "error" else "completed"
    )


async def _model_names(db: AsyncSession, model_ids: set[str]) -> dict[str, str]:
    """按模型记录 id 查询展示名称（无记录或查询异常时返回空表）."""
    if not model_ids:
        return {}
    try:
        rows = await db.execute(
            select(AIModel.id, AIModel.name, AIModel.display_name).where(
                AIModel.id.in_(model_ids)
            )
        )
        return {mid: (display or name) for mid, name, display in rows.all()}
    except Exception:
        logger.exception("Failed to load model names for conversation messages")
        return {}


async def _attach_turn_meta(
    db: AsyncSession, thread_id: str, messages: list[dict]
) -> None:
    """按 chat_usages 审计记录补充助手轮次的模型名、耗时与时间.

    仅在审计记录条数与助手消息条数一致时回填，避免错位映射出错误数据。
    """
    assistant_msgs = [m for m in messages if m.get("role") == "assistant"]
    if not assistant_msgs:
        return

    try:
        rows = (
            await db.execute(
                select(ChatUsage)
                .where(ChatUsage.thread_id == thread_id)
                .order_by(ChatUsage.created_at)
            )
        ).scalars().all()
    except Exception:
        logger.exception("Failed to load chat usage for thread %s", thread_id)
        return

    if len(rows) != len(assistant_msgs):
        return

    names = await _model_names(db, {r.model_id for r in rows if r.model_id})
    for msg, usage in zip(assistant_msgs, rows):
        if usage.duration_ms:
            msg["duration_ms"] = int(usage.duration_ms)
        if usage.created_at:
            created = usage.created_at
            if created.tzinfo is None:
                created = created.replace(tzinfo=UTC)
            msg["created_at"] = int(created.timestamp() * 1000)
        if usage.model_id and names.get(usage.model_id):
            msg["model"] = names[usage.model_id]


async def create_conversation(
    db: AsyncSession,
    user_id: str,
    thread_id: str,
    title: str,
    attachment_ids: list[str] | None = None,
):
    """创建对话记录，供 chat 端点在新对话时调用。"""
    import uuid

    conv = Conversation(
        id=str(uuid.uuid4()),
        user_id=user_id,
        thread_id=thread_id,
        title=title[:30] if len(title) > 30 else title,
        attachment_ids=attachment_ids,
    )

    db.add(conv)
    await db.commit()
    await db.refresh(conv)
    return conv


# ---- Response schemas ----


class ConversationItem(BaseModel):
    thread_id: str
    title: str
    updated_at: str


class AttachmentItem(BaseModel):
    id: str
    filename: str
    file_path: str
    file_size: int
    file_type: str


class MessageItem(BaseModel):
    role: str
    content: str
    attachments: list[AttachmentItem] | None = None
    blocks: list[dict] | None = None
    model: str | None = None
    created_at: int | None = None
    duration_ms: int | None = None


class ConversationDetail(BaseModel):
    thread_id: str
    title: str
    messages: list[MessageItem]


class RenameRequest(BaseModel):
    title: str


# ---- 端点 ----


@router.get("/conversations")
@handle_errors
async def list_conversations(
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """获取当前用户的对话列表，按更新时间倒序。"""
    result = await db.execute(
        select(Conversation)
        .where(Conversation.user_id == user_id)
        .order_by(Conversation.updated_at.desc())
    )
    conversations = result.scalars().all()
    return ok([
        {
            "thread_id": c.thread_id,
            "title": c.title,
            "updated_at": c.updated_at.isoformat() if c.updated_at else "",
        }
        for c in conversations
    ])


@router.get("/conversations/{thread_id}")
@handle_errors
async def get_conversation(
    thread_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """获取某个对话的消息列表，包含附件元数据。"""
    # 1. 查询 Conversation
    result = await db.execute(
        select(Conversation)
        .where(Conversation.thread_id == thread_id)
    )
    conv = result.scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if conv.user_id != user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    # 2. 查询关联的附件元数据
    attachment_map: dict[str, dict] = {}
    if conv.attachment_ids and isinstance(conv.attachment_ids, list):
        try:
            att_result = await db.execute(
                select(ChatAttachment).where(
                    ChatAttachment.id.in_(conv.attachment_ids),
                    ChatAttachment.status == "success",
                )
            )
            for att in att_result.scalars():
                attachment_map[f"/{att.file_path}"] = {
                    "id": att.id,
                    "filename": att.filename,
                    "file_path": att.file_path,
                    "file_size": att.file_size,
                    "file_type": att.file_type,
                }
        except Exception:
            logger.exception("Failed to load attachment metadata for conversation %s", thread_id)

    # 3. 从 graph state 获取消息
    config: RunnableConfig = {"configurable": {"thread_id": thread_id}}
    state = await get_graph().aget_state(config)
    raw_messages: list = state.values.get("messages", []) if (state and state.values) else []

    # 4. 为每条用户消息匹配附件，并剥离注入的附件提示前缀；assistant 额外保留结构化执行块
    raw_list: list[dict] = []
    pending_calls: list[dict] = []
    for m in raw_messages:
        msg_dict = _message_to_dict(m)
        if msg_dict["role"] == "assistant":
            blocks = _assistant_blocks(m, len(raw_list))
            if blocks:
                msg_dict["blocks"] = blocks
                pending_calls.extend(
                    block["tool_call"]
                    for block in blocks
                    if block["type"] == "tool_call"
                )
        elif msg_dict["role"] == "tool":
            _apply_tool_output(pending_calls, m)
        elif msg_dict["role"] == "user" and attachment_map:
            paths = re.findall(r"/chat_upload/[\w./-]+", msg_dict["content"])
            matched = [attachment_map[p] for p in paths if p in attachment_map]
            if matched:
                msg_dict["attachments"] = matched
                content = msg_dict["content"]
                marker = "用户消息："
                if marker in content:
                    content = content.split(marker, 1)[1].strip()
                msg_dict["content"] = content
        raw_list.append(msg_dict)

    # 5. 合并连续的 assistant 消息，与实时正常模式的展示一致（结构化块同步合并）
    messages: list[dict] = []
    for m in raw_list:
        if m["role"] == "system":
            continue

        # tool 消息合并到前一条 assistant 消息（工具输出上下文）
        if m["role"] == "tool":
            if messages and messages[-1]["role"] == "assistant":
                messages[-1]["content"] += m["content"]
            continue

        if (
            m["role"] == "assistant"
            and messages
            and messages[-1]["role"] == "assistant"
        ):
            messages[-1]["content"] += "\n\n" + m["content"]
            if m.get("blocks"):
                messages[-1]["blocks"] = messages[-1].get("blocks", []) + m["blocks"]
        else:
            messages.append(m)

    # 6. 补充助手轮次的模型名 / 耗时 / 时间（历史回显的元信息展示）
    await _attach_turn_meta(db, thread_id, messages)

    return ok({
        "thread_id": thread_id,
        "title": conv.title,
        "messages": messages,
    })


@router.patch("/conversations/{thread_id}")
@handle_errors
async def rename_conversation(
    thread_id: str,
    req: RenameRequest,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """重命名对话。"""
    result = await db.execute(
        select(Conversation).where(Conversation.thread_id == thread_id)
    )
    conv = result.scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if conv.user_id != user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    conv.title = req.title[:255]
    await db.commit()

    return ok({
        "thread_id": thread_id,
        "title": conv.title,
    })


@router.delete("/conversations/{thread_id}")
@handle_errors
async def delete_conversation(
    thread_id: str,
    user_id: str = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """删除对话记录（DB 记录 + LangGraph checkpoints）。"""
    # 1. 查 Conversation 确认归属
    result = await db.execute(
        select(Conversation).where(Conversation.thread_id == thread_id)
    )
    conv = result.scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if conv.user_id != user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    # 2. 先删除 checkpoints（避免删除了 DB 但 checkpoint 残留）
    try:
        checkpointer = get_checkpointer()
        await checkpointer.adelete_thread(thread_id)
    except Exception:
        # checkpoint 可能不存在（新对话还没消息），忽略错误
        pass

    # 3. 删除 DB 记录
    await db.delete(conv)
    await db.commit()

    # 级联清理该会话的产物记录与持久化文件（避免遗留孤儿文件）
    try:
        await delete_artifacts_by_thread(thread_id)
    except Exception:
        logger.exception("Failed to delete artifacts for thread %s", thread_id)

    return ok(None)
