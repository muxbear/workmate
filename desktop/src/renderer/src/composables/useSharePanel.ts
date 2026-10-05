import { computed, ref, type Ref } from 'vue'
import QRCode from 'qrcode'

/**
 * 分享选择模式 + 分享二维码（R6：自 NewTaskPage 外提）。
 *
 * - 面板开启时消息列表出现复选框（选中态在 `shareSelected`），底部出现操作面板；
 * - 分享链接为本地自定义协议（未来云端模式可切换 https 分享服务地址）；
 * - 微信/朋友圈分享 = 复制选中对话文本，由用户粘贴发送（不依赖平台 SDK）；
 * - 二维码按分享链接即席生成（qrcode 库，仅存 dataURL）。
 *
 * 交互依赖（toast/剪贴板/打开外链/与搜索互斥）经 Deps 注入，保持可测与零隐含全局。
 */

export interface ShareMessage {
  id: string
  role: string
  content: string
}

export interface SharePanelDeps {
  /** 消息列表（全选计数与拼文本的数据源） */
  messages: Ref<ShareMessage[]>
  /** 当前会话 id（分享链接主体） */
  conversationId: Ref<string | null>
  /** 打开面板前的互斥动作（如收起对话内搜索，避免视觉叠加） */
  onBeforeOpen?: () => void
  /** 轻提示（toast） */
  notify: (text: string) => void
  /** 复制文本（成功态文案由本模块给出；实现由页面注入，与消息复制共用） */
  copy: (text: string, okText: string) => Promise<void> | void
}

export function useSharePanel(deps: SharePanelDeps) {
  /** 分享面板开启：每条消息左侧出现复选框，底部出现操作面板 */
  const shareMode = ref(false)
  const shareSelected = ref<string[]>([])

  const shareAllChecked = computed(
    () => deps.messages.value.length > 0 && shareSelected.value.length === deps.messages.value.length
  )
  const shareAllIndeterminate = computed(
    () =>
      shareSelected.value.length > 0 && shareSelected.value.length < deps.messages.value.length
  )

  const isShareSelected = (id: string): boolean => shareSelected.value.includes(id)

  const toggleShareSelected = (id: string): void => {
    const i = shareSelected.value.indexOf(id)
    if (i >= 0) shareSelected.value.splice(i, 1)
    else shareSelected.value.push(id)
  }

  /** 全选/取消全选（收敛为方法，避免模板内多语句表达式） */
  const toggleShareAll = (): void => {
    shareSelected.value = shareAllChecked.value ? [] : deps.messages.value.map((m) => m.id)
  }

  /** 打开分享面板（同时收起对话内搜索，避免视觉叠加） */
  const openSharePanel = (): void => {
    deps.onBeforeOpen?.()
    shareMode.value = true
  }

  /** 关闭分享面板并清空选中（收敛为方法，避免模板内多语句表达式） */
  const closeSharePanel = (): void => {
    shareMode.value = false
    shareSelected.value = []
  }

  /** 分享链接：本地自定义协议（未来云端模式可切换 https 分享服务地址） */
  const shareLink = computed(
    () => `kework://conversation/${deps.conversationId.value ?? 'new'}`
  )

  /** 选中消息拼文本（用户/AI 前缀，过滤空内容） */
  const shareSelectedText = (): string =>
    deps.messages.value
      .filter((m) => shareSelected.value.includes(m.id))
      .map((m) => (m.role === 'user' ? `[用户] ${m.content}` : `[AI] ${m.content}`))
      .filter((t) => t.trim().length > 0)
      .join('\n\n')

  /** 分享到微信：复制选中对话文本，由用户粘贴到微信发送 */
  const shareToWechat = (): void => {
    const text = shareSelectedText()
    if (!text) return deps.notify('请先选择要分享的消息')
    void deps.copy(text, '已复制，请在微信中粘贴分享')
  }

  /** 分享到朋友圈：同微信，复制文本 */
  const shareToMoments = (): void => {
    const text = shareSelectedText()
    if (!text) return deps.notify('请先选择要分享的消息')
    void deps.copy(text, '已复制，请在朋友圈中粘贴分享')
  }

  /** 复制分享链接 */
  const copyShareLink = (): void => {
    void deps.copy(shareLink.value, '分享链接已复制')
  }

  /** 浏览器打开分享链接（本地自定义协议，未注册时由系统提示） */
  const openShareInBrowser = (): void => {
    window.api.openExternal(shareLink.value)
  }

  // ── 分享二维码 ──
  const qrModalOpen = ref(false)
  const qrDataUrl = ref('')
  const qrGenerating = ref(false)

  /** 生成分享链接二维码并弹出展示 */
  const generateQr = async (): Promise<void> => {
    qrModalOpen.value = true
    qrGenerating.value = true
    qrDataUrl.value = ''
    try {
      qrDataUrl.value = await QRCode.toDataURL(shareLink.value, { width: 240, margin: 1 })
    } catch (err) {
      console.error('[share] 二维码生成失败:', err)
      qrDataUrl.value = ''
    } finally {
      qrGenerating.value = false
    }
  }

  /** 关闭二维码弹窗（收敛为方法，避免模板内多语句表达式） */
  const closeQrModal = (): void => {
    qrModalOpen.value = false
    qrDataUrl.value = ''
  }

  return {
    shareMode,
    shareSelected,
    shareAllChecked,
    shareAllIndeterminate,
    isShareSelected,
    toggleShareSelected,
    toggleShareAll,
    openSharePanel,
    closeSharePanel,
    shareLink,
    shareToWechat,
    shareToMoments,
    copyShareLink,
    openShareInBrowser,
    qrModalOpen,
    qrDataUrl,
    qrGenerating,
    generateQr,
    closeQrModal
  }
}
