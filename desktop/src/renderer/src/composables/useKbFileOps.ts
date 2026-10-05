import { computed, ref, type Ref } from 'vue'
import { useKnowledgeStore } from '@store/knowledge'
import {
  collectFileNodes,
  parentKeyOf,
  remapKey,
  type KnowledgeNode
} from '@renderer/components/knowledge/knowledgeTree'

/**
 * 文件行操作（R6：自 KnowledgePage 外提）：查看详情 / 重新命名 / 打开所在目录。
 *
 * 重命名后的标签重映射依赖页面侧三个 UI 状态（打开的标签、当前标签、索引进度目标），
 * 经 Ref 注入保持单点更新；弹窗开关与目标节点由本组合件持有。
 */

export interface KbFileOpsDeps {
  /** 当前选中知识库 id（'' = 未选择） */
  selectedKbId: Ref<string>
  /** 打开的标签页（重命名后重映射） */
  openTabs: Ref<string[]>
  /** 当前激活标签（非「问答」时重映射） */
  activeTab: Ref<string>
  /** 索引进度目标（同库时 relPath 重映射） */
  pipelineTarget: Ref<{ kbId: string; relPath: string } | null>
  /** 轻提示（toast） */
  notify: (text: string) => void
  /** 收起文件行三点菜单 */
  closeFileMenu: () => void
}

export function useKbFileOps(deps: KbFileOpsDeps) {
  const kbStore = useKnowledgeStore()

  /** 索引状态文案（详情弹窗用） */
  const indexStateText = (node: KnowledgeNode): string => {
    const file = node.file
    if (!file) return '未建立索引'
    if (file.status === 'failed') return `索引失败：${file.errorMessage || '未知原因'}`
    if (file.status === 'indexing') return `建立索引中 ${Math.round(file.progress ?? 0)}%`
    if (file.status === 'queued') return '排队中'
    if (file.indexState === 'none') return '未建立索引'
    if (file.indexState === 'custom') return '自定义索引'
    return '已建立索引'
  }

  // ── 查看详情 ──
  const detailNode = ref<KnowledgeNode | null>(null)
  const detailOpen = ref(false)

  const detailTitle = computed(() => detailNode.value?.name ?? '')

  /** 详情弹窗的信息行（文件夹与文件展示不同字段） */
  const detailItems = computed<Array<{ label: string; value: string }>>(() => {
    const node = detailNode.value
    if (!node) return []
    const location = parentKeyOf(node.key) || '知识库根目录'
    if (node.kind === 'folder') {
      return [
        { label: '名称', value: node.name },
        { label: '类型', value: '文件夹' },
        { label: '包含文件', value: `${collectFileNodes(node.children ?? []).length} 个` },
        { label: '所在位置', value: location },
        { label: '索引状态', value: '随其中的文件一起建立索引' }
      ]
    }
    const file = node.file
    const items: Array<{ label: string; value: string }> = [
      { label: '名称', value: node.name },
      { label: '类型', value: file?.type ?? '文件' },
      { label: '大小', value: file?.size ?? '—' },
      { label: '更新时间', value: file?.updated ?? '—' },
      { label: '所在位置', value: location },
      { label: '索引状态', value: indexStateText(node) }
    ]
    if (file?.status === 'indexed' || file?.status === 'failed') {
      items.push({ label: '切片数', value: `${file.chunksCount ?? 0} 段` })
      if (file.charCount) {
        items.push({
          label: '索引文本',
          value: `${Math.round(file.charCount / 1000)} 千字${file.truncated ? '（已截断）' : ''}`
        })
      }
      items.push({
        label: '图谱',
        value: `${file.entitiesCount ?? 0} 实体 · ${file.relationsCount ?? 0} 关系`
      })
      if (file.graphError) items.push({ label: '图谱错误', value: file.graphError })
    }
    return items
  })

  const openFileDetail = (node: KnowledgeNode): void => {
    deps.closeFileMenu()
    detailNode.value = node
    detailOpen.value = true
  }

  // ── 重新命名（文件 / 文件夹）──
  const renameTarget = ref<KnowledgeNode | null>(null)
  const fileRenameOpen = ref(false)

  const openFileRename = (node: KnowledgeNode): void => {
    deps.closeFileMenu()
    renameTarget.value = node
    fileRenameOpen.value = true
  }

  /** 打开文件所在目录：主进程解析真实路径并在资源管理器中定位该文件 */
  const openFileDir = async (node: KnowledgeNode): Promise<void> => {
    deps.closeFileMenu()
    if (!deps.selectedKbId.value) return
    const ok = await kbStore.openFileDir(deps.selectedKbId.value, node.key)
    if (!ok) deps.notify(kbStore.lastError || '打开文件夹失败')
  }

  const submitFileRename = async (name: string): Promise<void> => {
    const target = renameTarget.value
    renameTarget.value = null
    if (!target || name === target.name) return
    if (!deps.selectedKbId.value) return
    const result = await kbStore.renameDocument(deps.selectedKbId.value, target.key, name)
    if (!result) {
      deps.notify(kbStore.lastError || '重命名失败')
      return
    }
    // 已打开的标签页跟着改名，避免指向不存在的 key
    const remap = (tab: string): string => remapKey(tab, target.key, result.relPath)
    deps.openTabs.value = deps.openTabs.value.map(remap)
    if (deps.activeTab.value !== '问答') deps.activeTab.value = remap(deps.activeTab.value)
    // 流水线目标同库才重映射（跨库的旧目标已在切库时关闭）
    if (deps.pipelineTarget.value && deps.pipelineTarget.value.kbId === deps.selectedKbId.value) {
      deps.pipelineTarget.value = {
        ...deps.pipelineTarget.value,
        relPath: remap(deps.pipelineTarget.value.relPath)
      }
    }
    deps.notify(`已重命名为「${name}」`)
  }

  return {
    detailNode,
    detailOpen,
    detailTitle,
    detailItems,
    openFileDetail,
    renameTarget,
    fileRenameOpen,
    openFileRename,
    openFileDir,
    submitFileRename
  }
}
