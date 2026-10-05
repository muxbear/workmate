import { computed, ref, watch, type Ref } from 'vue'
import { useCloudKnowledgeStore } from '@store/cloudKnowledge'
import { mergeUploads, type KnowledgeNode } from '@renderer/components/knowledge/knowledgeTree'
import {
  FILE_TINTS,
  formatTimestamp,
  pickFileIcon
} from '@renderer/components/knowledge/kb-display'
import type { KnowledgeFolder } from '@renderer/components/knowledge/knowledgeList'
import type { KnowledgeFileMeta } from '@renderer/components/knowledge/knowledgeTree'
import type { CloudDocMeta } from '../../../shared/contracts'

/**
 * 云知识库：在同一套工作台里渲染（R6：自 KnowledgePage 外提）。
 *
 * 数据源换成云端文档，模板与本地完全共用：本组合件持有云文档列表状态、
 * 云端时间/路径归一、树构建与加载/刷新/下载流程；IPC 走 cloudKnowledge store
 * （页内不再直连 knowledgeCloud 通道）。切换云库的**页面侧**清理（标签页/展开态/
 * 管线目标）经 `onCloudSwitch` 回调交回页面。
 */

/** 后端文档列表分页大小（服务端上限 100） */
const CLOUD_DOC_PAGE_SIZE = 100

export interface CloudDocsDeps {
  /** 当前浏览的云库（null=本地视图；本组合件的一切只在云库内生效） */
  cloudKb: Ref<KnowledgeFolder | null>
  /** 轻提示（toast） */
  notify: (text: string) => void
  /** 切换云库时的页面侧状态重置（进入=id，回到本地=null） */
  onCloudSwitch: (id: string | null) => void
  /** 关闭行内「⋯」菜单（下载动作前收起） */
  closeFileMenu: () => void
}

export function useCloudDocs(deps: CloudDocsDeps) {
  const cloudKbStore = useCloudKnowledgeStore()

  const cloudDocs = ref<CloudDocMeta[]>([])
  const cloudDocsTotal = ref(0)
  const cloudDocsLoading = ref(false)
  /** 云库的加载提示（未授权 / 拉取失败 / 已加载数不足） */
  const cloudDocsMessage = ref('')
  /** 相对路径 → 云端文档 id（预览与下载按 id 请求） */
  const cloudDocIds = ref<Record<string, string>>({})

  /** 当前是否在浏览云知识库 */
  const isCloudView = computed(() => deps.cloudKb.value !== null)

  /** 云端文档的相对路径（folder + name，与服务端 folder 语义一致） */
  function cloudRelPath(doc: CloudDocMeta): string {
    const folder = (doc.folder ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    return folder ? `${folder}/${doc.name}` : doc.name
  }

  /**
   * 云端时间（后端朴素 UTC ISO）→ 时间戳。
   *
   * 补 `Z` 按 UTC 解析后再交给 `formatTimestamp`，与本地行得到同一种展示
   * （今天 HH:mm / 昨天 HH:mm / M 月 D 日）。
   */
  function cloudTimestamp(iso: string): number {
    if (!iso) return 0
    const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso)
    const ms = Date.parse(hasZone ? iso : `${iso}Z`)
    return Number.isNaN(ms) ? 0 : ms
  }

  /** 云端文档 → 列表条目（图标/配色/大小/时间与本地行同一套规则） */
  function cloudMetaOf(doc: CloudDocMeta): KnowledgeFileMeta {
    const ext = doc.name.split('.').pop()?.toLowerCase() ?? ''
    return {
      name: doc.name,
      type: doc.type,
      size: doc.sizeDisplay || '—',
      updated: formatTimestamp(cloudTimestamp(doc.uploadedAt)),
      icon: pickFileIcon(ext),
      tint: FILE_TINTS[ext] ?? '#64748b',
      // 云端文档没有「自定义索引」这回事：已索引 / 未索引两态
      indexState: doc.status === 'indexed' ? 'default' : 'none',
      // 「分片」列与本地同源；实体/关系云端接口不提供，列表里显示 —
      chunksCount: doc.chunksCount
    }
  }

  /** 云文档树（复用 mergeUploads：文件夹层级来自文档的 folder 字段） */
  const cloudTree = computed<KnowledgeNode[]>(() => {
    if (!deps.cloudKb.value) return []
    const entries = cloudDocs.value.map((doc) => ({
      dirs: cloudRelPath(doc).split('/').slice(0, -1),
      file: cloudMetaOf(doc)
    }))
    return mergeUploads([], entries)
  })

  /** 拉取云库文档；append = true 时接着下一页加载 */
  async function loadCloudDocs(append = false): Promise<void> {
    const kb = deps.cloudKb.value
    if (!kb) return
    const page = append ? Math.floor(cloudDocs.value.length / CLOUD_DOC_PAGE_SIZE) + 1 : 1
    cloudDocsLoading.value = true
    cloudDocsMessage.value = ''
    try {
      const result = await window.api.knowledgeCloud.listDocuments({
        kbId: kb.id,
        page,
        pageSize: CLOUD_DOC_PAGE_SIZE
      })
      if (!result.success || !result.data) {
        cloudDocsMessage.value = result.error || '读取云端文档失败'
        return
      }
      const data = result.data
      if (data.state !== 'ok') {
        cloudDocsMessage.value = data.message
        return
      }
      cloudDocs.value = append ? [...cloudDocs.value, ...data.items] : data.items
      cloudDocsTotal.value = data.total
      const ids = { ...cloudDocIds.value }
      for (const doc of data.items) ids[cloudRelPath(doc)] = doc.id
      cloudDocIds.value = ids
    } finally {
      cloudDocsLoading.value = false
    }
  }

  /** 刷新云库文档（头部 ⋯ 菜单与工具栏按钮共用） */
  async function refreshCloudDocs(): Promise<void> {
    await loadCloudDocs(false)
    deps.notify(cloudDocsMessage.value || '已刷新云端文档')
  }

  /** 云文档「下载」= 另存为（文件名只作对话框默认值，主进程会自行净化） */
  async function downloadCloudDoc(node: KnowledgeNode): Promise<void> {
    const kb = deps.cloudKb.value
    const docId = cloudDocIds.value[node.key]
    deps.closeFileMenu()
    if (!kb || !docId) return
    const result = await cloudKbStore.downloadDocument(kb.id, docId, node.name)
    if (!result) {
      deps.notify(cloudKbStore.message || '下载失败')
      return
    }
    if (result.saved) deps.notify(`已保存到 ${result.path}`)
  }

  /** 切换云库：清空并按需拉取；回到本地库时回交页面恢复常驻「问答」标签 */
  watch(
    () => deps.cloudKb.value?.id,
    async (id) => {
      if (!id) {
        deps.onCloudSwitch(null)
        return
      }
      cloudDocs.value = []
      cloudDocsTotal.value = 0
      cloudDocIds.value = {}
      cloudDocsMessage.value = ''
      deps.onCloudSwitch(id)
      await loadCloudDocs(false)
    }
  )

  return {
    cloudDocs,
    cloudDocsTotal,
    cloudDocsLoading,
    cloudDocsMessage,
    cloudDocIds,
    isCloudView,
    cloudTree,
    loadCloudDocs,
    refreshCloudDocs,
    downloadCloudDoc
  }
}
