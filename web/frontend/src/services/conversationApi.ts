import instance from "./request"

export interface ConversationItem {
    thread_id: string
    title: string
    updated_at: string
}

export interface AttachmentItem {
    id: string
    filename: string
    file_path: string
    file_size: number
    file_type: string
}

export interface ConversationToolCall {
    call_id: string
    name: string
    input: string
    output: string
    status: 'running' | 'completed' | 'failed'
}

export interface ConversationBlock {
    type: 'text' | 'tool_call'
    content?: string
    tool_call?: ConversationToolCall
}

export interface MessageItem {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string
    attachments?: AttachmentItem[]
    /** 执行过程结构化块（text / tool_call），用于历史回显工具卡片 */
    blocks?: ConversationBlock[]
    /** 本次回复使用的模型名 */
    model?: string | null
    /** 消息创建时间（毫秒时间戳） */
    created_at?: number | null
    /** 本次回复耗时（毫秒） */
    duration_ms?: number | null
}

export interface ConversationDetail {
    thread_id: string
    title: string
    messages: MessageItem[]
}

export async function fetchConversations(): Promise<ConversationItem[]> {
    const res = await instance.get('/conversations')
    return res.data.data as ConversationItem[]
}

export async function fetchConversationMessages(thread_id: string): Promise<ConversationDetail> {
    const res = await instance.get(`/conversations/${thread_id}`)
    return res.data.data as ConversationDetail
}

export async function rename_conversation(thread_id: string, title: string): Promise<{ thread_id: string, title: string}> {
    const res = await instance.patch(`/conversations/${thread_id}`, { title })
    return res.data.data
}

export async function deleteConversation(threadId: string): Promise<void> {
    await instance.delete(`/conversations/${threadId}`)
}