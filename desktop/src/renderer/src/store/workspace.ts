import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { registerResettable } from './sessionReset'
// 渲染层 window.api 类型（preload 的全局声明）
import type {
  Workspace,
  WorkspaceFileBinary,
  WorkspaceFileContent,
  WorkspaceFileEntry
} from '../../../shared/contracts'

/** localStorage 键：当前选中的工作空间 id（重启后恢复） */
const CURRENT_ID_KEY = 'ke-work.current-workspace-id'

/**
 * 工作空间状态管理
 * 工作空间 = 当前任务的工作文件夹；数据经 IPC 落库（主进程 workspaces 表）
 */
export const useWorkspaceStore = defineStore('workspace', () => {
  // ====== 状态(State) ======
  const workspaces = ref<Workspace[]>([])
  const currentId = ref<string | null>(localStorage.getItem(CURRENT_ID_KEY))
  /** 上拉菜单中的搜索词 */
  const query = ref('')

  // ====== 计算属性(Getters) ======
  const currentWorkspace = computed(
    () => workspaces.value.find((w) => w.id === currentId.value) ?? null
  )

  /** 默认工作空间（系统设置配置的目录，机器级共享；未选择任何空间时的兜底） */
  const defaultWorkspace = computed(
    () => workspaces.value.find((w) => w.source === 'default') ?? null
  )

  /**
   * 输入卡上拉菜单的空间列表（顺序直接沿用服务端顺序：默认空间恒置顶 → 拖拽位 → 创建时间降序）。
   * 排序规则单点在主进程 listForUser 的 ORDER BY，本层不再二次排序（避免两套规则漂移）
   */
  const filteredWorkspaces = computed(() => {
    const keyword = query.value.trim().toLowerCase()
    return keyword
      ? workspaces.value.filter((w) => w.name.toLowerCase().includes(keyword))
      : [...workspaces.value]
  })

  // ====== 方法(Actions) ======

  /** 持久化当前选中（localStorage，重启恢复） */
  function persistCurrentId(): void {
    if (currentId.value) {
      localStorage.setItem(CURRENT_ID_KEY, currentId.value)
    } else {
      localStorage.removeItem(CURRENT_ID_KEY)
    }
  }

  /** 从列表中删除工作空间（主进程仅删记录，磁盘文件夹保留）；失败抛错 */
  async function remove(id: string): Promise<void> {
    const result = await window.api.deleteWorkspace(id)
    if (!result.success) {
      throw new Error(result.error || '删除工作空间失败')
    }
    workspaces.value = workspaces.value.filter((w) => w.id !== id)
    if (currentId.value === id) {
      currentId.value = null
      persistCurrentId()
    }
  }

  /** 从主进程加载当前用户的工作空间列表；currentId 未设置/失效则回落默认空间 */
  async function load(): Promise<void> {
    const result = await window.api.listWorkspaces()
    if (result.success && result.data) {
      workspaces.value = result.data
      if (!currentId.value || !workspaces.value.some((w) => w.id === currentId.value)) {
        currentId.value = defaultWorkspace.value?.id ?? null
        persistCurrentId()
      }
    }
  }

  /** 选中一个工作空间（当前任务使用） */
  async function select(id: string): Promise<void> {
    if (!workspaces.value.some((w) => w.id === id)) return
    currentId.value = id
    persistCurrentId()
  }

  /**
   * 新空间插入「可排序区最前」（默认空间恒在首位，不能被挤掉）。
   * 排序规则单点在主进程，这里只保证本地立即一致（不依赖重新拉取）
   */
  function insertAfterDefault(ws: Workspace): void {
    if (workspaces.value.some((w) => w.id === ws.id)) return
    const defIndex = workspaces.value.findIndex((w) => w.source === 'default')
    workspaces.value.splice(defIndex + 1, 0, ws)
  }

  /** 新建工作空间（主进程在默认工作空间目录下创建同名文件夹）；失败抛错（渲染层展示 error） */
  async function create(name: string): Promise<Workspace> {
    const result = await window.api.createWorkspace(name)
    if (!result.success || !result.data) {
      throw new Error(result.error || '新建工作空间失败')
    }
    insertAfterDefault(result.data)
    currentId.value = result.data.id
    persistCurrentId()
    return result.data
  }

  /**
   * 重命名工作空间（仅展示名，不动磁盘目录）。
   * 乐观更新 → 失败回滚并抛错（主进程 sanitize/默认空间/同名守卫是权威，文案原样透出）
   */
  async function rename(id: string, name: string): Promise<void> {
    const index = workspaces.value.findIndex((w) => w.id === id)
    const prev = index >= 0 ? workspaces.value[index] : null
    if (prev) workspaces.value[index] = { ...prev, name: name.trim() }
    const result = await window.api.renameWorkspace(id, name)
    if (!result.success || !result.data) {
      if (prev) workspaces.value[index] = prev
      throw new Error(result.error || '重命名工作空间失败')
    }
    // 以主进程回传为准（sanitize 规范化后的名字）
    if (index >= 0) workspaces.value[index] = result.data
  }

  /**
   * 拖拽排序：orderedIds 为非默认空间的全量 id（顺序即目标顺序）。
   * 乐观重排本地（默认空间仍置顶）→ 失败回滚并抛错 → 成功直接采用服务端返回的全量顺序
   */
  async function reorder(orderedIds: string[]): Promise<void> {
    const prev = workspaces.value
    const byId = new Map(prev.map((w) => [w.id, w]))
    const sortable = orderedIds.map((id) => byId.get(id)).filter((w): w is Workspace => !!w)
    const defaultWs = prev.find((w) => w.source === 'default')
    workspaces.value = defaultWs ? [defaultWs, ...sortable] : sortable
    const result = await window.api.reorderWorkspaces(orderedIds)
    if (!result.success || !result.data) {
      workspaces.value = prev
      throw new Error(result.error || '保存排序失败')
    }
    workspaces.value = result.data
  }

  /** 打开本地文件夹作为工作空间；返回是否已选中（用户取消为 false） */
  async function selectExternal(): Promise<boolean> {
    const result = await window.api.selectWorkspaceDir()
    if (!result.success || !result.data) return false
    insertAfterDefault(result.data)
    currentId.value = result.data.id
    persistCurrentId()
    return true
  }

  /** 使用默认工作空间：~/KeWork/DefaultWorkspace（未选择任何空间时的兜底目录） */
  async function useDefault(): Promise<void> {
    const result = await window.api.useDefaultWorkspace()
    if (!result.success || !result.data) {
      console.error('[workspace] useDefault failed:', result.error)
      return
    }
    insertAfterDefault(result.data)
    currentId.value = result.data.id
    persistCurrentId()
  }

  /** 清空状态（登出时调用，防切换账号残留上一用户的空间列表/选中态） */
  function reset(): void {
    workspaces.value = []
    currentId.value = null
    query.value = ''
    persistCurrentId()
  }

  /** 在系统资源管理器中打开工作空间目录 */
  async function open(id?: string): Promise<void> {
    const target = id ?? currentId.value
    if (!target) return
    await window.api.openWorkspace(target)
  }

  /** 列出工作空间下相对路径目录的条目（顶层传空串）；失败抛错（组件捕获展示） */
  async function listFiles(workspaceId: string, relPath?: string): Promise<WorkspaceFileEntry[]> {
    const result = await window.api.listWorkspaceFiles(workspaceId, relPath)
    if (!result.success || !result.data) {
      throw new Error(result.error || '读取目录失败')
    }
    return result.data
  }

  /** 读取工作空间下文件文本内容；失败抛错（组件捕获展示） */
  async function readFile(
    workspaceId: string,
    relPath: string,
    cursor?: number
  ): Promise<WorkspaceFileContent> {
    const result = await window.api.readWorkspaceFile(workspaceId, relPath, cursor)
    if (!result.success || !result.data) {
      throw new Error(result.error || '读取文件失败')
    }
    return result.data
  }

  /** 读取工作空间下 Word 文件原始字节，供 WordEditor 查看/编辑。 */
  async function readFileBytes(
    workspaceId: string,
    relPath: string
  ): Promise<WorkspaceFileBinary> {
    const result = await window.api.readWorkspaceFileBytes(workspaceId, relPath)
    if (!result.success || !result.data) {
      throw new Error(result.error || '读取文件失败')
    }
    return result.data
  }

  /** 保存工作空间下 Word 文件字节。 */
  async function saveFile(
    workspaceId: string,
    relPath: string,
    bytes: Uint8Array | ArrayBuffer
  ): Promise<void> {
    const result = await window.api.writeWorkspaceFile(workspaceId, relPath, bytes)
    if (!result.success) {
      throw new Error(result.error || '保存文件失败')
    }
  }

  return {
    workspaces,
    currentId,
    query,
    currentWorkspace,
    defaultWorkspace,
    filteredWorkspaces,
    load,
    select,
    create,
    rename,
    reorder,
    remove,
    selectExternal,
    useDefault,
    reset,
    open,
    listFiles,
    readFile,
    readFileBytes,
    saveFile
  }
})

// 登出 / 会话失效时重置本域（session-reset 注册表；惰性取实例）
registerResettable(() => useWorkspaceStore().reset())
