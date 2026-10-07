import { computed, ref, watch } from 'vue'
import { useAgentStore, type Conversation } from '@renderer/store/agent'
import { useWorkspaceStore } from '@renderer/store/workspace'
import {
  buildSpaceDeleteMessage,
  countTasksBySpace,
  resolveConversationSpaceId
} from '@renderer/components/space/spaceList'
import type { Workspace } from '../../../shared/contracts'

/** 重命名弹窗的目标：空间或任务（两者共用一套弹窗状态） */
type RenameTarget = { kind: 'space'; space: Workspace } | { kind: 'task'; task: Conversation }

export interface SpaceManageDeps {
  /** 打开某条任务（会话）：由页面负责选会话并切到「新建任务」 */
  onOpenTask: (id: string) => Promise<void> | void
}

/**
 * 空间管理页的行为层（R6 风格的组合式外提）：选中态、弹窗状态、改名/删除/新建/排序动作。
 *
 * 硬约束：**页内选中（selectedId）是浏览态，绝不调用 workspaceStore.select()** ——
 * 否则用户浏览空间列表会悄悄改变「新建任务」的工作空间落点。当前工作空间只用微标区分。
 */
export function useSpaceManage(deps: SpaceManageDeps) {
  const workspaceStore = useWorkspaceStore()
  const agentStore = useAgentStore()

  // ── 列表与选中 ──
  /** 全量列表（顺序 = 服务端顺序：默认空间置顶 → 拖拽位 → 创建时间降序） */
  const spaces = computed(() => workspaceStore.workspaces)
  const defaultSpace = computed(() => spaces.value.find((w) => w.source === 'default') ?? null)
  /** 可排序空间（默认空间不参与排序） */
  const sortableSpaces = computed(() => spaces.value.filter((w) => w.source !== 'default'))
  const spaceIds = computed(() => new Set(spaces.value.map((w) => w.id)))

  const taskCounts = computed(() =>
    countTasksBySpace(agentStore.sortedConversations, spaceIds.value, defaultSpace.value?.id ?? null)
  )

  /** 页内选中：默认优先当前工作空间，其次默认空间，再次首项 */
  const selectedId = ref('')
  watch(
    spaces,
    (list) => {
      if (list.some((w) => w.id === selectedId.value)) return
      selectedId.value =
        list.find((w) => w.id === workspaceStore.currentId)?.id ??
        defaultSpace.value?.id ??
        list[0]?.id ??
        ''
    },
    { immediate: true }
  )

  function selectSpace(id: string): void {
    selectedId.value = id
  }

  const selectedSpace = computed(() => spaces.value.find((w) => w.id === selectedId.value) ?? null)

  const selectedTasks = computed(() =>
    agentStore.sortedConversations.filter(
      (c) => resolveConversationSpaceId(c, spaceIds.value, defaultSpace.value?.id ?? null) === selectedId.value
    )
  )

  /** 选中空间的当前任务数（删除确认文案用） */
  function taskCountOf(spaceId: string): number {
    return taskCounts.value.get(spaceId) ?? 0
  }

  // ── 新建空间 ──
  const createOpen = ref(false)

  /** 新建成功后选中它（左列立即聚焦到刚建的空间） */
  function onCreated(space: Workspace): void {
    selectedId.value = space.id
  }

  // ── 改名（空间 / 任务共用弹窗）──
  const renameTarget = ref<RenameTarget | null>(null)
  const renameError = ref('')
  const renaming = ref(false)

  const renameTitle = computed(() =>
    renameTarget.value?.kind === 'task' ? '重命名任务' : '重命名空间'
  )
  const renameLabel = computed(() => (renameTarget.value?.kind === 'task' ? '任务标题' : '空间名称'))
  const renameCurrent = computed(() => {
    const target = renameTarget.value
    if (!target) return ''
    return target.kind === 'space' ? target.space.name : target.task.title
  })
  /** 任务标题上限沿用侧栏重命名弹窗的 50；空间名上限与主进程 NAME_MAX_LEN 对齐 */
  const renameMaxlength = computed(() => (renameTarget.value?.kind === 'task' ? 50 : 50))

  function openRenameSpace(space: Workspace): void {
    renameError.value = ''
    renameTarget.value = { kind: 'space', space }
  }

  function openRenameTask(task: Conversation): void {
    renameError.value = ''
    renameTarget.value = { kind: 'task', task }
  }

  function closeRename(): void {
    if (renaming.value) return
    renameTarget.value = null
    renameError.value = ''
  }

  /** 提交改名：失败文案（主进程权威）留在弹窗里展示，成功才关闭 */
  async function submitRename(name: string): Promise<void> {
    const target = renameTarget.value
    if (!target || renaming.value) return
    renaming.value = true
    renameError.value = ''
    try {
      if (target.kind === 'space') {
        await workspaceStore.rename(target.space.id, name)
      } else {
        await agentStore.renameConversation(target.task.id, name)
      }
      renameTarget.value = null
    } catch (err) {
      renameError.value = err instanceof Error ? err.message : '重命名失败'
    } finally {
      renaming.value = false
    }
  }

  // ── 删除空间 ──
  const deleteSpaceTarget = ref<Workspace | null>(null)
  const deleteSpaceMessage = computed(() =>
    buildSpaceDeleteMessage(deleteSpaceTarget.value ? taskCountOf(deleteSpaceTarget.value.id) : 0)
  )
  const deletingSpace = ref(false)

  function openDeleteSpace(space: Workspace): void {
    deleteSpaceTarget.value = space
  }

  function closeDeleteSpace(): void {
    deleteSpaceTarget.value = null
  }

  async function confirmDeleteSpace(): Promise<void> {
    const target = deleteSpaceTarget.value
    if (!target || deletingSpace.value) return
    deleteSpaceTarget.value = null
    deletingSpace.value = true
    try {
      await workspaceStore.remove(target.id)
      // 主进程已级联删除该空间下全部会话，重拉列表（失效会话由 loadConversations 校验清空）
      await agentStore.loadConversations()
    } catch (err) {
      console.error('[space-manage] delete space failed:', err)
    } finally {
      deletingSpace.value = false
    }
  }

  // ── 删除任务 ──
  const deleteTaskTarget = ref<Conversation | null>(null)
  const deletingTask = ref(false)

  function openDeleteTask(task: Conversation): void {
    deleteTaskTarget.value = task
  }

  function closeDeleteTask(): void {
    deleteTaskTarget.value = null
  }

  async function confirmDeleteTask(): Promise<void> {
    const target = deleteTaskTarget.value
    if (!target || deletingTask.value) return
    deleteTaskTarget.value = null
    deletingTask.value = true
    try {
      await agentStore.deleteConversation(target.id)
    } catch (err) {
      console.error('[space-manage] delete task failed:', err)
    } finally {
      deletingTask.value = false
    }
  }

  // ── 排序 / 打开 ──
  /** 拖拽排序：只传可排序空间的全量 id（默认空间不在其中），失败提示后由 store 回滚 */
  const reorderError = ref('')

  async function reorder(orderedIds: string[]): Promise<void> {
    reorderError.value = ''
    try {
      await workspaceStore.reorder(orderedIds)
    } catch (err) {
      reorderError.value = err instanceof Error ? err.message : '保存排序失败'
    }
  }

  function openDir(space: Workspace): void {
    void workspaceStore.open(space.id)
  }

  async function openTask(id: string): Promise<void> {
    await deps.onOpenTask(id)
  }

  return {
    spaces,
    sortableSpaces,
    defaultSpace,
    currentId: computed(() => workspaceStore.currentId),
    selectedSpace,
    selectedTasks,
    taskCounts,
    selectSpace,
    createOpen,
    onCreated,
    renameTarget,
    renameTitle,
    renameLabel,
    renameCurrent,
    renameMaxlength,
    renameError,
    renaming,
    openRenameSpace,
    openRenameTask,
    closeRename,
    submitRename,
    deleteSpaceTarget,
    deleteSpaceMessage,
    openDeleteSpace,
    closeDeleteSpace,
    confirmDeleteSpace,
    deleteTaskTarget,
    openDeleteTask,
    closeDeleteTask,
    confirmDeleteTask,
    reorderError,
    reorder,
    openDir,
    openTask
  }
}
