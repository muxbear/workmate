import { ref } from 'vue'
import { MAX_ATTACH_FILES, classifyPath, getFileName, limitForKind } from '../../../shared/file-kinds'

/**
 * 文件附件管线（R6：自 PromptInput 外提）：选中/拖入 → 逐个即时校验 → 通过者在光标处插入文件 token。
 *
 * 校验为主进程权威（`file:inspect`），渲染层复用共享分类（file-kinds）做 UX 前置：
 * 类型不支持 / 文件不存在 / 超体积上限都在此拦截并提示，避免把非法附件带进消息部件。
 */

export interface FileAttachDeps {
  /** 当前输入框元素（拖放光标定位与 token 插入目标；await 期间可能卸载，插入前需 isConnected 守卫） */
  getInputEl: () => HTMLElement | null
  /** 通过校验的文件路径 → 在输入框光标处插入文件 token（useRichTokens.insertFileTokenAtCaret） */
  insertFileToken: (el: HTMLElement, path: string) => void
  /** 校验过程中的用户提示（toast） */
  notify: (text: string) => void
}

export function useFileAttach(deps: FileAttachDeps): {
  /** 拖拽悬停高亮（输入框 --dragging 态） */
  inputDragging: ReturnType<typeof ref<boolean>>
  onSelectFiles: (paths: string[]) => Promise<void>
  onInputDragEnter: (e: DragEvent) => void
  onInputDragOver: (e: DragEvent) => void
  onInputDragLeave: (e: DragEvent) => void
  onInputDrop: (e: DragEvent) => void
} {
  // ── 拖拽文件入输入框（效果与「+ → 添加文件 → 本地文件」一致） ──
  const inputDragging = ref(false)
  let fileDragDepth = 0

  /** PlusMenu 选中本地文件 → 逐个即时校验（UX 前置），通过的在光标处插入文件 token */
  const onSelectFiles = async (paths: string[]): Promise<void> => {
    const el = deps.getInputEl()
    if (!el) return
    // 去重：同一文件多次选择只插一个 token
    const uniquePaths = [...new Set(paths)]
    if (uniquePaths.length > MAX_ATTACH_FILES) {
      deps.notify('单次最多选择 ' + MAX_ATTACH_FILES + ' 个文件')
      return
    }
    const accepted: string[] = []
    for (const p of uniquePaths) {
      const name = getFileName(p)
      if (classifyPath(p) === 'unsupported') {
        deps.notify('暂不支持该文件类型：' + name)
        continue
      }
      const res = await window.api.inspectFile(p)
      if (!res.success) {
        deps.notify(res.error ?? '文件校验失败')
        continue
      }
      const data = res.data
      if (!data || !data.exists) {
        deps.notify('文件不存在：' + name)
        continue
      }
      if (data.kind === 'unsupported') {
        deps.notify('暂不支持该文件类型：' + name)
        continue
      }
      const limit = data.maxBytes ?? limitForKind(data.kind)
      if (data.size > limit) {
        deps.notify('文件过大（上限 ' + Math.round(limit / 1024 / 1024) + 'MB）：' + name)
        continue
      }
      accepted.push(p)
    }
    // await 期间输入框可能已卸载（弹窗关闭），守卫防插入到游离 DOM
    if (!el.isConnected) return
    for (const p of accepted) deps.insertFileToken(el, p)
  }

  /** 仅响应文件拖拽（文本拖拽保留浏览器默认插入） */
  const isFileDrag = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files')

  /** 拖入输入框：高亮提示可放置（dragenter/dragleave 在子节点间冒泡，用深度计数防闪烁） */
  const onInputDragEnter = (e: DragEvent): void => {
    e.preventDefault()
    if (!isFileDrag(e)) return
    fileDragDepth++
    inputDragging.value = true
  }

  /** 持续派发时阻止默认（否则 drop 不被允许） */
  const onInputDragOver = (e: DragEvent): void => {
    e.preventDefault()
  }

  const onInputDragLeave = (e: DragEvent): void => {
    if (!isFileDrag(e)) return
    fileDragDepth = Math.max(0, fileDragDepth - 1)
    if (fileDragDepth === 0) inputDragging.value = false
  }

  /** 松手：光标定位到拖放点，解析真实路径后复用 onSelectFiles 的校验与插入管线 */
  const onInputDrop = (e: DragEvent): void => {
    fileDragDepth = 0
    inputDragging.value = false
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (!files.length) return // 文本拖拽：不做拦截，保留浏览器默认插入
    e.preventDefault()
    const el = deps.getInputEl()
    if (!el) return
    // 光标定位到拖放点（caretRangeFromPoint 为 Chromium 扩展 API，Electron 可用）
    const range = document.caretRangeFromPoint(e.clientX, e.clientY)
    if (range) {
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
    // Electron 39 起 File.path 已移除：经 preload 的 webUtils.getPathForFile 解析真实路径
    const paths = files.map((f) => window.api.getPathForFile(f)).filter((p): p is string => !!p)
    if (!paths.length) {
      deps.notify('无法读取文件，请从本地文件夹重新拖入')
      return
    }
    void onSelectFiles(paths)
  }

  return { inputDragging, onSelectFiles, onInputDragEnter, onInputDragOver, onInputDragLeave, onInputDrop }
}
