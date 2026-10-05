import { showToast } from './useToast'

/**
 * 复制文本到剪贴板（R6：自 NewTaskPage 外提；消息操作栏与分享面板共用）。
 * clipboard API 不可用（非安全上下文等）时退回 execCommand；成功提示走全局 toast。
 */
export async function copyText(text: string, okText = '已复制'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
  showToast(okText)
}
