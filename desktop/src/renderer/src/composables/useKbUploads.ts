import { ref, type Ref } from 'vue'
import { useKnowledgeStore } from '@store/knowledge'
import type { KnowledgeUploadPayload } from '@renderer/components/knowledge/uploadIndex'

/** useKbUploads 返回组合件（KbFileTree / KbModalsHost 注入的类型来源） */
export interface KbUploadsApi {
  /** 上传弹窗开关 */
  uploadOpen: Ref<boolean>
  /** 「上传文件/文件夹」按钮：打开上传弹窗 */
  openUploadModal: () => void
  /** 上传弹窗确定后的落地（转「绝对路径 + 相对路径」交主进程） */
  onUploadSubmit: (payload: KnowledgeUploadPayload) => Promise<void>
}

/**
 * 知识库上传流程（R6：自 KnowledgePage 外提）。
 *
 * 单入口：文件区的「上传文件/文件夹」打开上传弹窗，弹窗内可点击选择文件、
 * 选择文件夹（webkitRelativePath 还原目录结构）或拖入文件/文件夹，
 * 统一进同一队列后选处理方式（默认索引 / 自定义向导 / 只上传）提交。
 * 渲染层只传「绝对路径 + 相对路径」，字节读取与落盘由主进程负责。
 */

export interface KbUploadsDeps {
  /** 当前选中知识库 id（'' = 未选择） */
  selectedKbId: Ref<string>
  /** 轻提示（toast） */
  notify: (text: string) => void
}

export function useKbUploads(deps: KbUploadsDeps): KbUploadsApi {
  const kbStore = useKnowledgeStore()

  /** 上传弹窗：选文件/文件夹 → 选择上传后处理方式 → 需要时进入索引配置向导 */
  const uploadOpen = ref(false)

  /** 「上传文件/文件夹」按钮：打开上传弹窗 */
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

  return {
    uploadOpen,
    openUploadModal,
    onUploadSubmit
  }
}
