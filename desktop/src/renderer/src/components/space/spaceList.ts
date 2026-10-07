import type { Workspace } from '../../../../shared/contracts'

/**
 * 空间（工作空间）列表的纯函数工具箱（无 Vue 依赖，单测对象）。
 *
 * 侧栏空间分组、空间管理页、删除确认文案都从这里取值 —— 归属规则与文案只有一处实现，
 * 避免侧栏与管理页算出不同的任务数/不同的提示语。
 */

/**
 * 归属判定所需的最小会话形状（结构化类型：store 的 Conversation 天然满足）。
 * 刻意不 import 渲染层 store —— 本模块保持零依赖，才能被 node 侧单测直接引用。
 */
export interface SpaceConversationRef {
  workspace?: { id: string; name?: string } | null
}

/**
 * 拖拽排序：把 from 位置的空间移动到 to 位置（to 为移动后的目标下标，越界自动夹取）。
 * 返回新数组，原数组不变；起点非法或位置未变化时原样返回（镜像 knowledgeList.moveLibrary）。
 */
export function moveSpace(items: Workspace[], from: number, to: number): Workspace[] {
  if (from < 0 || from >= items.length) return items
  const target = Math.min(items.length - 1, Math.max(0, to))
  if (target === from) return items
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(target, 0, moved)
  return next
}

/**
 * 会话归属的空间 id：绑定空间仍在列表中 → 它；无绑定 / 绑定空间已被删除 → 默认空间 id。
 * 返回 null 表示既无绑定也无默认空间（数据异常，调用方按"不展示"处理）。
 */
export function resolveConversationSpaceId(
  conversation: SpaceConversationRef,
  spaceIds: ReadonlySet<string>,
  defaultSpaceId: string | null
): string | null {
  const boundId = conversation.workspace?.id
  if (boundId && spaceIds.has(boundId)) return boundId
  return defaultSpaceId
}

/** 各空间下的任务数（spaceId → 任务数；空空间不出现在结果里，读取方用 ?? 0 兜底） */
export function countTasksBySpace(
  conversations: SpaceConversationRef[],
  spaceIds: ReadonlySet<string>,
  defaultSpaceId: string | null
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const conversation of conversations) {
    const spaceId = resolveConversationSpaceId(conversation, spaceIds, defaultSpaceId)
    if (!spaceId) continue
    counts.set(spaceId, (counts.get(spaceId) ?? 0) + 1)
  }
  return counts
}

/** 移除空间确认文案（侧栏与管理页共用同一串，防两处文案漂移） */
export function buildSpaceDeleteMessage(taskCount: number): string {
  return `该工作空间下有 ${taskCount} 个任务，移除工作空间后这些任务将被同时删除且无法恢复，确认移除？`
}
