import { ref, watch, type Ref } from 'vue'
import { useKnowledgeStore } from '@store/knowledge'
import { mergeUploads, type KnowledgeFileMeta, type KnowledgeNode } from '@renderer/components/knowledge/knowledgeTree'
import { FILE_TINTS, formatTimestamp, pickFileIcon } from '@renderer/components/knowledge/kb-display'
import type { KnowledgeDocumentMeta } from '../../../shared/contracts'

/**
 * 本地知识库文件树（R6：自 KnowledgePage 外提）。
 *
 * 由主进程文档元信息（relPath）还原层级（复用 mergeUploads：文件夹是逻辑结构），
 * 文档列表变化（切换知识库 / 上传 / 删除 / 重命名后）自动重建；
 * 文件夹展开状态缺省折叠（只有显式展开过的目录才展开），由模板点击与 rows 共用。
 *
 * 排序与筛选派生列表（sortedTree/rows/allFiles）仍留在页面：它们跨本地/云端两棵树，
 * 由页面把 activeTree 合流后再派生。
 */

/** 文件大小展示（与上传弹窗保持一致） */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${bytes} B`
}

export interface KbFilesDeps {
  /** 当前选中知识库 ID（无知识库时为空串） */
  selectedKbId: Ref<string>
}

export function useKbFiles(deps: KbFilesDeps) {
  const kbStore = useKnowledgeStore()

  /** 文件树：由主进程文档元信息（relPath）还原层级，key 即相对路径 */
  const fileTree = ref<KnowledgeNode[]>([])

  /** 主进程文档元信息 → 列表条目（图标/配色与上传结果保持同一套规则） */
  function metaOf(doc: KnowledgeDocumentMeta): KnowledgeFileMeta {
    const ext = doc.name.split('.').pop()?.toLowerCase() ?? ''
    return {
      name: doc.name,
      type: doc.type,
      size: formatSize(doc.sizeBytes),
      sizeBytes: doc.sizeBytes,
      updated: formatTimestamp(doc.updatedAt),
      icon: pickFileIcon(ext),
      tint: FILE_TINTS[ext] ?? '#64748b',
      indexState: doc.indexState,
      status: doc.status,
      stage: doc.stage,
      progress: doc.progress,
      errorMessage: doc.errorMessage,
      chunksCount: doc.chunksCount,
      entitiesCount: doc.entitiesCount,
      relationsCount: doc.relationsCount,
      charCount: doc.charCount,
      truncated: doc.truncated,
      graphError: doc.graphError,
      indexedAt: doc.indexedAt
    }
  }

  /** 用文档列表重建文件树（复用 mergeUploads：文件夹是逻辑结构，来自 relPath） */
  function rebuildFileTree(docs: KnowledgeDocumentMeta[]): void {
    const entries = docs.map((doc) => ({
      dirs: doc.relPath.split('/').slice(0, -1),
      file: metaOf(doc)
    }))
    fileTree.value = mergeUploads([], entries)
    // 目录结构由 relPath 还原（与上传的文件夹层级一致）；
    // 这里**不**自动展开：文件夹默认折叠，由用户点击展开
  }

  // 文档列表变化（切换知识库 / 上传 / 删除 / 重命名后）重建树
  watch(
    () => kbStore.documentsOf(deps.selectedKbId.value),
    (docs) => rebuildFileTree(docs),
    { immediate: true, deep: true }
  )

  /** 文件夹展开状态（缺省折叠：只有显式展开过的目录才展开） */
  const folderExpanded = ref<Record<string, boolean>>({})

  /** 文件夹是否展开（缺省折叠；rows 与模板的折叠箭头共用同一判定） */
  function isFolderExpanded(key: string): boolean {
    return folderExpanded.value[key] === true
  }

  const toggleFolder = (key: string): void => {
    folderExpanded.value = { ...folderExpanded.value, [key]: !isFolderExpanded(key) }
  }

  return {
    fileTree,
    metaOf,
    rebuildFileTree,
    folderExpanded,
    isFolderExpanded,
    toggleFolder
  }
}
