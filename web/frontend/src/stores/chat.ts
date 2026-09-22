import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { fetchThreadArtifacts, sendStreamRequest } from '@/services/request'
import { useUiStore } from '@/stores/ui'
import { useWorkspaceStore } from '@/stores/workspace'
import {
  downloadArtifact as downloadArtifactFile,
  downloadBundle as downloadBundleFile,
  fetchArtifactBlob as fetchArtifactBlobApi,
} from '@/services/artifactApi'
import type {
  ChatMessage,
  ExecutionBlock,
  AttachmentDisplayInfo,
  ChatInputPart,
  ChatSelection,
  SelectionEcho,
  ChatArtifact,
} from '@/types/chat'
import { createEmptySelection } from '@/types/chat'
import type { StreamCallbacks, DoneInfo } from '@/services/request'
import type { Attachment } from '@/types/chat'
import { uploadAttachment, deleteAttachment } from '@/services/attachmentApi'
import type { ConversationBlock } from '@/services/conversationApi'
import { attachArtifactsToMessages } from '@/utils/artifactGroups'

export type { ChatMessage }

/** 把服务端执行块映射为前端展示块（历史回显：工具调用卡片） */
function toExecutionBlocks(rawBlocks?: ConversationBlock[]): ExecutionBlock[] {
  if (!rawBlocks || rawBlocks.length === 0) return []

  const blocks: ExecutionBlock[] = []
  for (const raw of rawBlocks) {
    if (raw.type === 'tool_call' && raw.tool_call) {
      blocks.push({
        type: 'tool_call',
        toolCall: {
          callId: raw.tool_call.call_id,
          name: raw.tool_call.name,
          input: raw.tool_call.input ?? '',
          output: raw.tool_call.output ?? '',
          status: raw.tool_call.status ?? 'completed',
        },
      })
    } else if (raw.type === 'text' && raw.content) {
      blocks.push({ type: 'text', content: raw.content })
    }
  }
  return blocks
}

export const useChatStore = defineStore('chat', () => {
  const messages = ref<ChatMessage[]>([])
  const loading = ref(false)
  const threadId = ref<string | null>(null)
  const traceEnabled = ref(false)
  const attachments = ref<Attachment[]>([])
  let nextId = 1
  let abortController: AbortController | null = null

  const selection = ref<ChatSelection>(createEmptySelection())
  const inputParts = ref<ChatInputPart[]>([])
  const activeSelection = ref<SelectionEcho | null>(null)
  /** 当前会话产物（SSE artifact 事件与接口回填） */
  const threadArtifacts = ref<ChatArtifact[]>([])

  /** 分享面板开关与已勾选消息 */
  const shareMode = ref(false)
  const shareSelected = ref<number[]>([])
  const shareAllChecked = computed(
    () => messages.value.length > 0 && shareSelected.value.length === messages.value.length,
  )

  /** 对话内搜索关键词与命中消息 */
  const searchKeyword = ref('')
  const searchMatchIds = computed(() => {
    const keyword = searchKeyword.value.trim().toLowerCase()
    if (!keyword) return []
    return messages.value
      .filter((message) => (message.content ?? '').toLowerCase().includes(keyword))
      .map((message) => message.id)
  })

  function setSelection(patch: Partial<ChatSelection>) {
    selection.value = { ...selection.value, ...patch }
  }

  function setExpert(expert: { id: string; name: string } | null) {
    selection.value = {
      ...selection.value,
      expertId: expert ? expert.id : null,
      expertName: expert ? expert.name : null,
    }
  }

  function toggleSkillId(id: string) {
    const ids = selection.value.skillIds
    selection.value = {
      ...selection.value,
      skillIds: ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id],
    }
  }

  function setMode(mode: ChatSelection['mode']) {
    selection.value = { ...selection.value, mode }
  }

  function setModel(name: string | null, providerId: string | null, modelId: string | null = null) {
    selection.value = { ...selection.value, model: name, providerId, modelId }
  }

  function setInputParts(parts: ChatInputPart[]) {
    inputParts.value = parts
  }

  /** 登记一条产物：挂到对应回复消息上，并加入当前会话产物列表（按路径去重） */
  /** 切换点赞 / 点踩（本地状态，按消息 id） */
  function setFeedback(messageId: number, kind: 'up' | 'down') {
    const entry = byId(messageId)
    if (!entry) return
    messages.value[entry.idx] = {
      ...entry.msg,
      feedback: entry.msg.feedback === kind ? null : kind,
    }
  }

  function registerArtifact(assistantId: number, artifact: ChatArtifact) {
    if (!threadArtifacts.value.some((item) => item.path === artifact.path)) {
      threadArtifacts.value = [...threadArtifacts.value, artifact]
    }
    const entry = byId(assistantId)
    if (entry) {
      const existing = entry.msg.artifacts ?? []
      if (!existing.some((item) => item.path === artifact.path)) {
        messages.value[entry.idx] = {
          ...entry.msg,
          artifacts: [...existing, artifact],
        }
      }
    }
  }

  /** 从服务端拉取会话产物（切换会话时回填） */
  /** 更新已登记产物的元信息（流结束后补全物化状态与大小） */
  function updateArtifact(artifact: ChatArtifact) {
    const isSame = (item: ChatArtifact) =>
      (artifact.artifact_id && item.artifact_id === artifact.artifact_id) ||
      item.path === artifact.path
    if (threadArtifacts.value.some(isSame)) {
      threadArtifacts.value = threadArtifacts.value.map((item) =>
        isSame(item) ? { ...item, ...artifact } : item,
      )
    } else {
      threadArtifacts.value = [...threadArtifacts.value, artifact]
    }
    messages.value = messages.value.map((msg) => {
      if (!msg.artifacts?.length || !msg.artifacts.some(isSame)) return msg
      return {
        ...msg,
        artifacts: msg.artifacts.map((item) => (isSame(item) ? { ...item, ...artifact } : item)),
      }
    })
  }

  async function loadThreadArtifacts(tid: string) {
    if (!tid) {
      threadArtifacts.value = []
      return
    }
    threadArtifacts.value = await fetchThreadArtifacts(tid)
  }

  /** 点击消息中的产物卡片：在右侧工作区新开（或激活）一个文档标签页 */
  function openArtifact(artifact: ChatArtifact) {
    const uiStore = useUiStore()
    const workspaceStore = useWorkspaceStore()
    workspaceStore.openDocument(artifact, threadId.value ?? uiStore.activeThreadId ?? '')
    uiStore.rightPanelCollapsed = false
    // 打开文档时左右两侧按 1:1 展示；用户已拖拽出更宽的右栏则保持不变
    if (uiStore.rightPanelRatio < 0.5) uiStore.setRightPanelRatio(0.5)
  }

  function clearArtifacts() {
    threadArtifacts.value = []
  }

  /** 判断某条消息是否命中当前搜索关键词 */
  function isSearchHit(id: number): boolean {
    return searchMatchIds.value.includes(id)
  }

  /** 打开分享面板（清空历史勾选） */
  function openSharePanel() {
    shareMode.value = true
    shareSelected.value = []
  }

  /** 关闭分享面板并清空勾选 */
  function closeSharePanel() {
    shareMode.value = false
    shareSelected.value = []
  }

  function toggleShareSelect(id: number) {
    const index = shareSelected.value.indexOf(id)
    if (index >= 0) shareSelected.value.splice(index, 1)
    else shareSelected.value.push(id)
  }

  function toggleShareAll() {
    shareSelected.value = shareAllChecked.value ? [] : messages.value.map((item) => item.id)
  }

  /** 已勾选消息拼文本（用户 / AI 前缀，过滤空内容） */
  function shareSelectedText(): string {
    return messages.value
      .filter((item) => shareSelected.value.includes(item.id))
      .map((item) => (item.role === 'user' ? '[用户] ' : '[AI] ') + item.content)
      .filter((text) => text.trim().length > 0)
      .join('\n\n')
  }

  /** 会话分享链接（Web 路由，打开后自动加载该会话） */
  function shareLink(): string {
    const tid = threadId.value ?? uiStoreActiveThread()
    return window.location.origin + '/chat?thread=' + (tid ?? '')
  }

  /** 取当前会话 id（优先 chat store，其次 ui store） */
  function uiStoreActiveThread(): string | null {
    return useUiStore().activeThreadId
  }

  /** 带鉴权拉取产物内容（沿用当前会话，供消息卡片等场景使用） */
  async function fetchArtifactBlob(artifact: ChatArtifact): Promise<Blob | null> {
    const tid = threadId.value
    if (!tid) return null
    const result = await fetchArtifactBlobApi(tid, artifact.path, 'inline')
    return result.blob
  }

  /** 下载产物到本地 */
  async function downloadArtifact(artifact: ChatArtifact) {
    const tid = threadId.value
    if (!tid) return
    await downloadArtifactFile(tid, artifact.path, artifact.name)
  }

  /** 打包下载交付物：scope=turn 本轮 / scope=thread 整个会话 */
  async function downloadBundle(scope: 'turn' | 'thread', turn?: string) {
    const tid = threadId.value
    if (!tid) return
    await downloadBundleFile(tid, scope, turn)
  }

  function resetSelection() {
    selection.value = createEmptySelection()
    inputParts.value = []
    activeSelection.value = null
  }

  function generateId(): string {
    return crypto.randomUUID()
  }

  function addMessage(role: 'user' | 'assistant', content = '', streaming = false): ChatMessage {
    const msg: ChatMessage = { id: nextId++, role, content, streaming }
    messages.value.push(msg)
    return msg
  }

  /** Look up the reactive proxy of a message by ID */
  function byId(id: number): { idx: number; msg: ChatMessage } | null {
    const idx = messages.value.findIndex((m) => m.id === id)
    if (idx === -1) return null
    return { idx, msg: messages.value[idx] }
  }

  /** Build callbacks for trace-enabled mode: construct execution block tree */
  function buildTraceCallbacks(assistantId: number): StreamCallbacks {
    const blocks: ExecutionBlock[] = []

    // Initialize blocks on the reactive message
    const init = byId(assistantId)
    if (init) {
      messages.value[init.idx] = { ...init.msg, blocks }
    }

    // Track agent_name → blocks[] for token routing
    const agentBlocks = new Map<string, ExecutionBlock[]>()
    agentBlocks.set('main', blocks)

    // Track call_id → ExecutionBlock for tool_end / agent_end lookups
    const activeBlocks = new Map<string, ExecutionBlock>()

    return {
      onArtifact(artifact: ChatArtifact) {
        registerArtifact(assistantId, artifact)
      },
      onArtifactUpdated(artifact: ChatArtifact) {
        updateArtifact(artifact)
      },
      onSelection(data: SelectionEcho) {
        activeSelection.value = data
      },
      onToken(agentName: string, content: string) {
        const target = agentBlocks.get(agentName) || blocks
        const last = target[target.length - 1]
        if (last && last.type === 'text') {
          last.content += content
        } else {
          target.push({ type: 'text', content })
        }
        // Trigger Vue reactivity by touching the reactive message
        const entry = byId(assistantId)
        if (entry) {
          messages.value[entry.idx] = { ...entry.msg, blocks: [...blocks] }
        }
      },

      onReasoning(_agentName: string, content: string) {
        const entry = byId(assistantId)
        if (entry) {
          messages.value[entry.idx] = {
            ...entry.msg,
            reasoning: (entry.msg.reasoning || '') + content,
          }
        }
      },

      onAgentStart(data) {
        if (data.agent_type === 'sub') {
          const block: ExecutionBlock = {
            type: 'sub_agent',
            subAgent: {
              callId: data.call_id,
              name: data.agent_name,
              status: 'running',
              blocks: [],
            },
          }
          agentBlocks.set(data.agent_name, block.subAgent.blocks)
          const parent = agentBlocks.get('main') || blocks
          parent.push(block)
          activeBlocks.set(data.call_id, block)
          const entry = byId(assistantId)
          if (entry) {
            messages.value[entry.idx] = { ...entry.msg, blocks: [...blocks] }
          }
        }
      },

      onAgentEnd(data) {
        const block = activeBlocks.get(data.call_id)
        if (block && block.type === 'sub_agent') {
          block.subAgent.status = data.status === 'completed' ? 'completed' : 'failed'
        }
        agentBlocks.delete(data.agent_name)
        const entry = byId(assistantId)
        if (entry) {
          messages.value[entry.idx] = { ...entry.msg, blocks: [...blocks] }
        }
      },

      onToolStart(data) {
        const block: ExecutionBlock = {
          type: 'tool_call',
          toolCall: {
            callId: data.call_id,
            name: data.tool_name,
            input: data.input,
            output: '',
            status: 'running',
          },
        }
        blocks.push(block)
        activeBlocks.set(data.call_id, block)
        const entry = byId(assistantId)
        if (entry) {
          messages.value[entry.idx] = { ...entry.msg, blocks: [...blocks] }
        }
      },

      onToolOutput(callId: string, content: string) {
        const block = activeBlocks.get(callId)
        if (block && block.type === 'tool_call') {
          block.toolCall.output += content
          const entry = byId(assistantId)
          if (entry) {
            messages.value[entry.idx] = { ...entry.msg, blocks: [...blocks] }
          }
        }
      },

      onToolEnd(data) {
        const block = activeBlocks.get(data.call_id)
        if (block && block.type === 'tool_call') {
          block.toolCall.output = data.output || block.toolCall.output
          block.toolCall.status = 'completed'
          const entry = byId(assistantId)
          if (entry) {
            messages.value[entry.idx] = { ...entry.msg, blocks: [...blocks] }
          }
        }
      },

      onThreadId(id: string) {
        threadId.value = id
      },

      onDone(info?: DoneInfo) {
        const entry = byId(assistantId)
        if (entry) {
          messages.value[entry.idx] = {
            ...entry.msg,
            streaming: false,
            durationMs: info?.durationMs,
          }
        }
        loading.value = false
        const uiStore = useUiStore()
        uiStore.activeThreadId = threadId.value
        uiStore.fetchHistories()
      },

      onError(errorMsg: string) {
        const entry = byId(assistantId)
        if (entry) {
          const sep = entry.msg.content ? '\n\n' : ''
          messages.value[entry.idx] = {
            ...entry.msg,
            content: entry.msg.content + `${sep}${errorMsg}`,
            streaming: false,
          }
        }
        loading.value = false
      },
    }
  }

  /** Build callbacks for normal mode: merge all agent tokens into content */
  function buildNormalCallbacks(assistantId: number): StreamCallbacks {
    return {
      onArtifact(artifact: ChatArtifact) {
        registerArtifact(assistantId, artifact)
      },
      onArtifactUpdated(artifact: ChatArtifact) {
        updateArtifact(artifact)
      },
      onSelection(data: SelectionEcho) {
        activeSelection.value = data
      },
      onToken(agentName: string, content: string) {
        const entry = byId(assistantId)
        if (entry) {
          messages.value[entry.idx] = {
            ...entry.msg,
            content: entry.msg.content + content,
          }
        }
      },

      onReasoning(_agentName: string, content: string) {
        const entry = byId(assistantId)
        if (entry) {
          messages.value[entry.idx] = {
            ...entry.msg,
            reasoning: (entry.msg.reasoning || '') + content,
          }
        }
      },

      onAgentStart() {},
      onAgentEnd() {},
      onToolStart() {},
      onToolOutput() {},

      onToolEnd(data) {
        if (!data.output) return
        const entry = byId(assistantId)
        if (entry) {
          const label = `\n\n---\n**${data.tool_name}** 输出：\n${data.output}\n`
          messages.value[entry.idx] = {
            ...entry.msg,
            content: entry.msg.content + label,
          }
        }
      },

      onThreadId(id: string) {
        threadId.value = id
      },

      onDone(info?: DoneInfo) {
        const entry = byId(assistantId)
        if (entry) {
          messages.value[entry.idx] = {
            ...entry.msg,
            streaming: false,
            durationMs: info?.durationMs,
          }
        }
        loading.value = false
        const uiStore = useUiStore()
        uiStore.activeThreadId = threadId.value
        uiStore.fetchHistories()
      },

      onError(errorMsg: string) {
        const entry = byId(assistantId)
        if (entry) {
          const sep = entry.msg.content ? '\n\n' : ''
          messages.value[entry.idx] = {
            ...entry.msg,
            content: entry.msg.content + `${sep}${errorMsg}`,
            streaming: false,
          }
        }
        loading.value = false
      },
    }
  }

  function buildAttachmentDisplayInfo(): AttachmentDisplayInfo[] {
    return attachments.value
      .filter((a) => a.status === 'success')
      .map((a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        thumbnailUrl: URL.createObjectURL(a.file),
      }))
  }

  function clearAttachments() {
    attachments.value = []
  }

  async function sendMessage(text: string) {
    if (loading.value) return

    // 输入框快照：正文 + 保序部件 + 选择项（发送后立即清空，语义与桌面版一致）
    const partsSnapshot = [...inputParts.value]
    const selectionSnapshot = { ...selection.value }
    const attIds = [...activeAttachmentIds.value]
    const hasBody = text.trim().length > 0 || partsSnapshot.length > 0 || attIds.length > 0
    if (!hasBody) return

    loading.value = true

    // Capture attachment display info before clearing
    const displayInfo = buildAttachmentDisplayInfo()

    // Clear input-area attachments
    clearAttachments()
    inputParts.value = []

    // Add user message with attachment display info
    const userMsg = addMessage('user', text.trim())
    const userIdx = messages.value.findIndex((m) => m.id === userMsg.id)
    if (userIdx !== -1) {
      messages.value[userIdx] = { ...messages.value[userIdx], createdAt: Date.now() }
    }
    if (displayInfo.length > 0) {
      const idx = messages.value.findIndex((m) => m.id === userMsg.id)
      if (idx !== -1) {
        messages.value[idx] = { ...messages.value[idx], attachments: displayInfo }
      }
    }

    const assistantMsg = addMessage('assistant', '', true)
    const assistantIdx = messages.value.findIndex((m) => m.id === assistantMsg.id)
    if (assistantIdx !== -1) {
      messages.value[assistantIdx] = {
        ...messages.value[assistantIdx],
        model: selectionSnapshot.model ?? '默认模型',
        createdAt: Date.now(),
      }
    }

    const callbacks = traceEnabled.value
      ? buildTraceCallbacks(assistantMsg.id)
      : buildNormalCallbacks(assistantMsg.id)

    abortController = new AbortController()

    try {
      await sendStreamRequest(text.trim(), {
        threadId: threadId.value,
        callbacks,
        attachmentIds: attIds.length > 0 ? attIds : undefined,
        parts: partsSnapshot,
        selection: selectionSnapshot,
        signal: abortController.signal,
      })
    } catch {
      const entry = byId(assistantMsg.id)
      if (entry) {
        const sep = entry.msg.content ? '\n\n' : ''
        messages.value[entry.idx] = {
          ...entry.msg,
          content: entry.msg.content + `${sep}抱歉，网络连接失败，请检查网络后重试。`,
          streaming: false,
        }
      }
      loading.value = false
    } finally {
      abortController = null
    }
  }

  function stopGeneration() {
    if (abortController) {
      abortController.abort()
      abortController = null
      loading.value = false
    }
  }

  function clearMessages() {
    messages.value = []
    loading.value = false
    threadId.value = null
    clearArtifacts()
    // 新建对话 / 删除会话时同步关闭右侧已打开的文档标签页
    useWorkspaceStore().closeAllTabs()
  }

  async function uploadFile(file: File): Promise<void> {
    const id = generateId()
    const att: Attachment = {
      id,
      file,
      filename: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      status: 'uploading',
      progress: 0,
    }
    attachments.value.push(att)

    try {
      const result = await uploadAttachment(file, (percent) => {
        const idx = attachments.value.findIndex((a) => a.id === id)
        if (idx !== -1) {
          attachments.value[idx] = { ...attachments.value[idx], progress: percent }
        }
      })
      const idx = attachments.value.findIndex((a) => a.id === id)
      if (idx !== -1) {
        attachments.value[idx] = {
          ...attachments.value[idx],
          serverId: result.id,
          status: 'success',
          progress: 100,
        }
      }
    } catch {
      const idx = attachments.value.findIndex((a) => a.id === id)
      if (idx !== -1) {
        attachments.value[idx] = { ...attachments.value[idx], status: 'failed' }
      }
    }
  }

  function removeAttachment(id: string): void {
    const att = attachments.value.find((a) => a.id === id)
    if (att?.serverId) {
      deleteAttachment(att.serverId).catch(() => {})
    }
    attachments.value = attachments.value.filter((a) => a.id !== id)
  }

  async function retryUpload(id: string): Promise<void> {
    const idx = attachments.value.findIndex((a) => a.id === id)
    if (idx === -1) return
    const file = attachments.value[idx].file
    attachments.value = attachments.value.filter((a) => a.id !== id)
    await uploadFile(file)
  }

  const activeAttachmentIds = computed<string[]>(() => {
    return attachments.value
      .filter((a) => a.status === 'success' && a.serverId)
      .map((a) => a.serverId!)
  })

  async function loadConversation(tid: string) {
    const { fetchConversationMessages } = await import('@/services/conversationApi')
    threadId.value = tid
    loading.value = true
    await loadThreadArtifacts(tid)
    try {
      const detail = await fetchConversationMessages(tid)

      messages.value = detail.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m, idx) => {
          const message: ChatMessage = {
            id: idx + 1,
            role: m.role as 'user' | 'assistant',
            content: m.content,
            streaming: false,
            attachments: m.attachments?.map((att) => ({
              filename: att.filename,
              mimeType: att.file_type,
              size: att.file_size,
              thumbnailUrl: `/api/chat/files/${att.id}`,
            })),
          }

          // 历史回显：执行过程块与轮次元信息（模型 / 耗时 / 时间）
          const blocks = toExecutionBlocks(m.blocks)
          if (blocks.length > 0) message.blocks = blocks
          if (m.model) message.model = m.model
          if (typeof m.created_at === 'number') message.createdAt = m.created_at
          if (typeof m.duration_ms === 'number') message.durationMs = m.duration_ms
          return message
        })
      // 历史回显：会话产物按交付轮次挂到对应的 AI 回复上，点击文件即可在右侧标签页中打开
      messages.value = attachArtifactsToMessages(messages.value, [...threadArtifacts.value])
      nextId = messages.value.length + 1
    } catch {
      // ignore
    }

    loading.value = false
  }

  /** 重答：删除指定 AI 回复，用上一条用户消息重新请求 */
  async function regenerate(assistantMsgId: number) {
    if (loading.value) return

    const assistantIdx = messages.value.findIndex((m) => m.id === assistantMsgId)
    if (assistantIdx === -1) return

    // 向前查找最近的用户消息
    let userIdx = -1
    for (let i = assistantIdx - 1; i >= 0; i--) {
      if (messages.value[i].role === 'user') {
        userIdx = i
        break
      }
    }
    if (userIdx === -1) return

    const userText = messages.value[userIdx].content

    // 删除旧的 AI 回复
    messages.value.splice(assistantIdx, 1)

    loading.value = true
    const newAssistantMsg = addMessage('assistant', '', true)

    const callbacks = traceEnabled.value
      ? buildTraceCallbacks(newAssistantMsg.id)
      : buildNormalCallbacks(newAssistantMsg.id)

    abortController = new AbortController()

    try {
      await sendStreamRequest(userText, {
        threadId: threadId.value,
        callbacks,
        selection: { ...selection.value },
        signal: abortController.signal,
      })
    } catch {
      const entry = byId(newAssistantMsg.id)
      if (entry) {
        const sep = entry.msg.content ? '\n\n' : ''
        messages.value[entry.idx] = {
          ...entry.msg,
          content: entry.msg.content + `${sep}抱歉，重答失败，请稍后重试。`,
          streaming: false,
        }
      }
      loading.value = false
    } finally {
      abortController = null
    }
  }

  return {
    messages,
    loading,
    threadId,
    traceEnabled,
    attachments,
    selection,
    inputParts,
    activeSelection,
    threadArtifacts,
    loadThreadArtifacts,
    openArtifact,
    registerArtifact,
    updateArtifact,
    setFeedback,
    clearArtifacts,
    shareMode,
    shareSelected,
    shareAllChecked,
    openSharePanel,
    closeSharePanel,
    toggleShareSelect,
    toggleShareAll,
    shareSelectedText,
    shareLink,
    searchKeyword,
    searchMatchIds,
    isSearchHit,
    fetchArtifactBlob,
    downloadArtifact,
    downloadBundle,
    setSelection,
    setExpert,
    toggleSkillId,
    setMode,
    setModel,
    setInputParts,
    resetSelection,
    activeAttachmentIds,
    sendMessage,
    clearMessages,
    stopGeneration,
    loadConversation,
    uploadFile,
    removeAttachment,
    retryUpload,
    regenerate,
  }
})
