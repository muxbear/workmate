import { ref, type Ref } from 'vue'
import { useKnowledgeStore } from '@store/knowledge'
import type { KnowledgeFolder } from '@renderer/components/knowledge/knowledgeList'
import type { KnowledgeNode } from '@renderer/components/knowledge/knowledgeTree'

/**
 * 文档与知识库头部的变更操作（R6：自 KnowledgePage 外提）。
 *
 * - 文件行：重建索引 / 失败重试 / 重抽图谱 / 取消索引 / 删除文件（二次确认）；
 * - 检索调试与图谱可视化弹窗开关；
 * - 知识库头部菜单：重命名 / 打开所在目录 / 索引设置 / 删除（后两者经回调交回页面）；
 * - 共享弹窗状态（知识库 / 文件夹 / 文件共用）。
 *
 * 标签与进度目标的级联清理经 Ref/回调注入（页面仍是单一事实源）。
 */

/** 共享的对象类型 */
export type ShareKind = 'library' | 'folder' | 'file'

export interface KbDocOpsDeps {
  /** 当前选中知识库 id（'' = 未选择） */
  selectedKbId: Ref<string>
  /** 当前选中知识库（头部菜单目标） */
  selectedLibrary: Ref<KnowledgeFolder>
  /** 打开的标签页（删除文件后级联清理） */
  openTabs: Ref<string[]>
  /** 当前激活标签（被删节点属于其路径时回到「问答」） */
  activeTab: Ref<string>
  /** 索引进度目标（被删节点是它或其祖先文件夹时关闭） */
  pipelineTarget: Ref<{ kbId: string; relPath: string } | null>
  /** 关闭文件行三点菜单 */
  closeFileMenu: () => void
  /** 关闭「索引进度」标签（页面包装 closeTab(INDEX_TAB)） */
  closeIndexTab: () => void
  /** 关闭知识库头部菜单（页面持有 libraryMenuOpen） */
  closeLibraryHeaderMenu: () => void
  /** 打开「索引设置」（知识库条目操作区） */
  openLibrarySettings: (library: KnowledgeFolder) => void
  /** 发起知识库删除确认（知识库条目操作区） */
  askDeleteLibrary: (library: KnowledgeFolder) => void
  /** 轻提示（toast） */
  notify: (text: string) => void
}

/** 标签是否属于某节点路径（自身或其子孙） */
const tabBelongsTo = (tab: string, key: string): boolean =>
  tab === key || tab.startsWith(`${key}/`)

export function useKbDocOps(deps: KbDocOpsDeps) {
  const kbStore = useKnowledgeStore()

  // ── 重建索引 / 重试 / 取消（真实 IPC；进度走 knowledge:import-progress 事件） ──
  const rebuildIndex = async (node: KnowledgeNode): Promise<void> => {
    deps.closeFileMenu()
    if (!deps.selectedKbId.value) return
    // node.key 即库内 relPath：文件节点 = 单文件，文件夹节点 = 按前缀批量重建
    const queued = await kbStore.reindex(deps.selectedKbId.value, [node.key])
    deps.notify(
      queued > 0
        ? `已加入索引队列：${queued} 个文件`
        : kbStore.lastError || '没有可重建的文件（「只上传文件」的条目不参与索引）'
    )
  }

  /** 失败重试（仅 status = failed 的条目在菜单里出现） */
  const retryIndex = async (node: KnowledgeNode): Promise<void> => {
    deps.closeFileMenu()
    if (!deps.selectedKbId.value) return
    const ok = await kbStore.retryDocument(deps.selectedKbId.value, node.key)
    deps.notify(ok ? '已重新加入索引队列' : kbStore.lastError || '重试失败')
  }

  /** 重抽图谱（只跑抽取；失败过的文档也可以补抽） */
  const reextractGraph = async (node: KnowledgeNode): Promise<void> => {
    deps.closeFileMenu()
    if (!deps.selectedKbId.value) return
    const queued = await kbStore.reextractGraph(deps.selectedKbId.value, [node.key])
    deps.notify(queued > 0 ? '已加入图谱抽取队列' : kbStore.lastError || '没有可重抽的文件')
  }

  /** 取消该条目正在进行的索引任务 */
  const cancelIndexing = async (node: KnowledgeNode): Promise<void> => {
    deps.closeFileMenu()
    if (!deps.selectedKbId.value) return
    const canceled = await kbStore.cancelIndex(deps.selectedKbId.value, [node.key])
    deps.notify(canceled > 0 ? '已取消索引' : kbStore.lastError || '没有正在进行的索引任务')
  }

  /** 重建社区摘要（GraphRAG 全局检索侧；供「整体性提问」用） */
  const rebuildCommunities = async (): Promise<void> => {
    deps.closeLibraryHeaderMenu()
    const kbId = deps.selectedKbId.value
    if (!kbId) return
    deps.notify('正在按实体关系聚类生成主题摘要…')
    const count = await kbStore.rebuildCommunities(kbId)
    deps.notify(
      count > 0
        ? `已生成 ${count} 条社区主题摘要`
        : kbStore.lastError || '实体关系不足以形成社区（先在「知识库设置」开启图谱抽取并重建索引）'
    )
  }

  // ── 检索调试 / 图谱可视化（只读弹窗） ──
  /** 检索调试面板开关 */
  const searchOpen = ref(false)
  /** 图谱可视化弹窗开关 */
  const graphOpen = ref(false)

  /** 打开检索调试面板（只读：走与问答同源的检索实现，附分阶段耗时与各路分数） */
  const openSearchDebug = (): void => {
    deps.closeLibraryHeaderMenu()
    searchOpen.value = true
  }

  /** 打开图谱可视化（只读：实体-关系图，数据由主进程跨文档聚合） */
  const openGraphView = (): void => {
    deps.closeLibraryHeaderMenu()
    graphOpen.value = true
  }

  // ── 创建共享（知识库 / 文件夹 / 文件共用同一个弹窗） ──
  const shareOpen = ref(false)
  const shareName = ref('')
  const shareKind = ref<ShareKind>('file')
  const shareTargetId = ref('')

  const openShare = (name: string, kind: ShareKind, targetId = ''): void => {
    deps.closeFileMenu()
    deps.closeLibraryHeaderMenu()
    shareName.value = name
    shareKind.value = kind
    shareTargetId.value = targetId || deps.selectedKbId.value
    shareOpen.value = true
  }

  const onShareCreated = (name: string): void => {
    deps.notify(`已创建「${name}」的共享链接`)
  }

  // ── 删除文件 / 文件夹：二次确认 ──
  const deleteFileNode = ref<KnowledgeNode | null>(null)

  const askDeleteFile = (node: KnowledgeNode): void => {
    deps.closeFileMenu()
    deleteFileNode.value = node
  }

  const confirmDeleteFile = async (): Promise<void> => {
    const target = deleteFileNode.value
    deleteFileNode.value = null
    if (!target) return
    if (!deps.selectedKbId.value) return
    const ok = await kbStore.removeDocument(deps.selectedKbId.value, target.key)
    if (!ok) {
      deps.notify(kbStore.lastError || '删除失败')
      return
    }
    deps.openTabs.value = deps.openTabs.value.filter((tab) => !tabBelongsTo(tab, target.key))
    if (tabBelongsTo(deps.activeTab.value, target.key)) deps.activeTab.value = '问答'
    // 被删的是流水线指向的文档（或它的祖先文件夹）时一并关闭
    if (
      deps.pipelineTarget.value &&
      tabBelongsTo(deps.pipelineTarget.value.relPath, target.key)
    ) {
      deps.closeIndexTab()
    }
    deps.notify(`已删除「${target.name}」`)
  }

  // ── 知识库名字右侧的操作菜单：重命名 / 创建共享 / 索引设置 / 删除 ──
  const libraryRenameOpen = ref(false)

  const openLibraryRename = (): void => {
    deps.closeLibraryHeaderMenu()
    libraryRenameOpen.value = true
  }

  /** 打开知识库所在目录：路径由主进程解析并在系统文件管理器中打开 */
  const openLibraryDir = async (): Promise<void> => {
    deps.closeLibraryHeaderMenu()
    if (!deps.selectedKbId.value) {
      deps.notify('请先创建或选择一个知识库')
      return
    }
    const ok = await kbStore.openBaseDir(deps.selectedKbId.value)
    if (!ok) deps.notify(kbStore.lastError || '打开文件夹失败')
  }

  /** 只改名称，描述沿用原值（描述编辑仍在「知识库编辑」弹窗里） */
  const submitLibraryRename = async (name: string): Promise<void> => {
    libraryRenameOpen.value = false
    const target = deps.selectedLibrary.value
    if (!target.id || name === target.name) return
    const ok = await kbStore.updateBase(target.id, { name })
    deps.notify(ok ? `已重命名为「${name}」` : kbStore.lastError || '重命名失败')
  }

  const openLibrarySettingsFromHeader = (): void => {
    deps.closeLibraryHeaderMenu()
    deps.openLibrarySettings(deps.selectedLibrary.value)
  }

  const deleteLibraryFromHeader = (): void => {
    deps.closeLibraryHeaderMenu()
    deps.askDeleteLibrary(deps.selectedLibrary.value)
  }

  return {
    rebuildIndex,
    retryIndex,
    reextractGraph,
    cancelIndexing,
    rebuildCommunities,
    searchOpen,
    graphOpen,
    openSearchDebug,
    openGraphView,
    shareOpen,
    shareName,
    shareKind,
    shareTargetId,
    openShare,
    onShareCreated,
    deleteFileNode,
    askDeleteFile,
    confirmDeleteFile,
    libraryRenameOpen,
    openLibraryRename,
    openLibraryDir,
    submitLibraryRename,
    openLibrarySettingsFromHeader,
    deleteLibraryFromHeader
  }
}
