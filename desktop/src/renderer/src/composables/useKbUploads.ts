import { ref, type Ref } from 'vue'
import { useKnowledgeStore } from '@store/knowledge'
import type { KnowledgeUploadPayload } from '@renderer/components/knowledge/uploadIndex'

/**
 * 知识库上传流程（R6：自 KnowledgePage 外提）。
 *
 * 三条入口共用同一套「绝对路径 + 相对路径」落盘协议：
 * - 「上传文件」弹窗（选处理方式：默认索引 / 自定义向导 / 只上传）；
 * - 「上传文件夹」系统目录选择器（webkitRelativePath 还原目录结构，直传默认索引）；
 * - 弹窗内拖入文件夹（由上传弹窗组件汇总进 payload.items）。
 *
 * 目录选择器 input 元素 ref 由页面持有并绑定在模板上（字符串模板 ref 语义），随参数注入。
 */

export interface KbUploadsDeps {
  /** 当前选中知识库 id（'' = 未选择） */
  selectedKbId: Ref<string>
  /** 轻提示（toast） */
  notify: (text: string) => void
  /** 「上传文件夹」目录选择器 input 元素 ref（页面临时挂载，随页面持有） */
  folderUploadRef: Ref<HTMLInputElement | null>
}

export function useKbUploads(deps: KbUploadsDeps) {
  const kbStore = useKnowledgeStore()

  /** 上传弹窗：选文件 → 选择上传后处理方式 → 需要时进入索引配置向导 */
  const uploadOpen = ref(false)

  /** 上传文件夹：只允许选文件夹，按 webkitRelativePath 还原原始目录结构 */
  const onFolderChange = (event: Event): void => {
    const input = event.target as HTMLInputElement
    const picked = Array.from(input.files ?? [])
    // 复位，同一个文件夹可以再次选择
    input.value = ''
    if (!picked.length) return
    void addFolderUpload(picked)
  }

  /** 上传文件夹：按 webkitRelativePath 还原目录结构，绝对路径交主进程落盘 */
  const addFolderUpload = async (picked: File[]): Promise<void> => {
    if (!deps.selectedKbId.value) {
      deps.notify('请先创建或选择一个知识库')
      return
    }
    let items: Array<{ srcPath: string; relPath: string }> = []
    try {
      items = picked
        .map((file) => ({
          srcPath: window.api.getPathForFile(file),
          relPath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
        }))
        .filter((item) => !!item.srcPath)
    } catch (err) {
      deps.notify(`读取文件路径失败：${(err as Error).message}`)
      return
    }
    if (!items.length) {
      deps.notify('未能解析文件路径，请重新选择文件夹')
      return
    }
    // 文件夹直传没有索引方式选择步骤：与上传弹窗的默认项保持一致（创建默认索引）；
    // 想只留文件或走自定义向导的用户从「上传文件」弹窗进入
    const result = await kbStore.importDocuments(deps.selectedKbId.value, items, {
      indexState: 'default'
    })
    deps.notify(result ? result.message : kbStore.lastError || '上传失败')
  }

  /** 「上传文件」按钮：打开上传弹窗 */
  const openUploadModal = (): void => {
    uploadOpen.value = true
  }

  /**
   * 上传弹窗确定后的落地：渲染层把 `File` 转成「绝对路径 + 相对路径」交主进程落盘。
   *
   * - Electron 39 起 `File.path` 已移除，必须走 preload 暴露的 `getPathForFile`；
   * - 三种处理方式（默认索引 / 自定义索引 / 只上传文件）随提交带上索引状态与配置快照。
   */
  const onUploadSubmit = async (payload: KnowledgeUploadPayload): Promise<void> => {
    if (!deps.selectedKbId.value) {
      deps.notify('请先创建或选择一个知识库')
      return
    }
    let items: Array<{ srcPath: string; relPath: string }> = []
    try {
      // 带相对路径的待上传项优先（拖入文件夹时保留目录结构），缺省退回文件名
      const queued = payload.items?.length
        ? payload.items
        : payload.files.map((file) => ({ file, relPath: file.name }))
      items = queued
        .map((entry) => ({
          srcPath: window.api.getPathForFile(entry.file),
          relPath: entry.relPath || entry.file.name
        }))
        .filter((item) => !!item.srcPath)
    } catch (err) {
      deps.notify(`读取文件路径失败：${(err as Error).message}`)
      return
    }
    if (!items.length) {
      deps.notify('未能解析文件路径，请重新选择文件')
      return
    }
    const result = await kbStore.importDocuments(deps.selectedKbId.value, items, {
      indexState: payload.mode,
      // 自定义索引提交向导快照（主进程会再校验一次）；默认索引由主进程取生效配置
      config: payload.mode === 'custom' ? payload.config : null
    })
    deps.notify(result ? result.message : kbStore.lastError || '上传失败')
  }

  /** 「上传文件夹」按钮：只打开目录选择器（webkitdirectory 挂在输入框上） */
  const uploadFolder = (): void => {
    deps.folderUploadRef.value?.click()
  }

  return {
    uploadOpen,
    onFolderChange,
    addFolderUpload,
    openUploadModal,
    onUploadSubmit,
    uploadFolder
  }
}
