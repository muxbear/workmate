import type { ChatArtifact } from '@/types/chat'

/** 一轮交付物分组（turn-<n>） */
export interface ArtifactTurnGroup {
  /** 交付轮次目录名；历史数据可能为空串 */
  turn: string
  items: ChatArtifact[]
}

/** 按交付轮次分组（保序；无轮次的产物并入当前分组） */
export function groupArtifactsByTurn(artifacts: ChatArtifact[]): ArtifactTurnGroup[] {
  const groups: ArtifactTurnGroup[] = []
  for (const item of artifacts ?? []) {
    const turn = item.turn ?? ''
    const last = groups[groups.length - 1]
    if (last && (turn === '' || last.turn === turn)) {
      last.items.push(item)
      continue
    }
    groups.push({ turn, items: [item] })
  }
  return groups
}

/** 交付轮次展示名：turn-3 → 第 3 轮交付物 */
export function turnLabel(turn?: string | null): string {
  const match = /^turn-(\d+)$/.exec(turn ?? '')
  return match ? '第 ' + match[1] + ' 轮交付物' : ''
}

/**
 * 把会话产物按轮次挂到对应助手消息上（历史回显用）。
 *
 * 轮次目录与助手回复一一对应时精确挂载；数量不匹配（例如中途重答）时
 * 退化为"全部挂到最后一条助手回复"，保证产物不会丢失。
 */
export function attachArtifactsToMessages<
  T extends { role: string; artifacts?: ChatArtifact[] },
>(messages: T[], artifacts: ChatArtifact[]): T[] {
  if (!artifacts?.length || !messages?.length) return messages

  const assistantIndexes = messages
    .map((message, index) => (message.role === 'assistant' ? index : -1))
    .filter((index) => index >= 0)
  if (!assistantIndexes.length) return messages

  const groups = groupArtifactsByTurn(artifacts)
  const next = [...messages]
  if (groups.length === assistantIndexes.length) {
    groups.forEach((group, i) => {
      const index = assistantIndexes[i]
      next[index] = { ...next[index], artifacts: group.items }
    })
    return next
  }

  const lastIndex = assistantIndexes[assistantIndexes.length - 1]
  next[lastIndex] = { ...next[lastIndex], artifacts: groups.flatMap((group) => group.items) }
  return next
}
