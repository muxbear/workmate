import logging
import re

from fastapi import APIRouter, Depends, HTTPException
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agent import get_checkpointer, get_graph
from api.deps import get_current_user_id
from core.decorators import handle_errors
from core.response import ok
from db import get_db
from db.models import Conversation
from db.models.chat_attachment import ChatAttachment

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

    # 4. 为每条用户消息匹配附件，并剥离注入的附件提示前缀
    raw_list: list[dict] = []
    for m in raw_messages:
        msg_dict = _message_to_dict(m)
        if msg_dict["role"] == "user" and attachment_map:
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

    # 5. 合并连续的 assistant 消息，与实时正常模式的展示一致
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
        else:
            messages.append(m)

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

    return ok(None)
