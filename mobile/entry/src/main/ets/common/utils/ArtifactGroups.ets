/**
 * 会话产物按交付轮次分组与挂载。
 *
 * 与 Web 前端 web/frontend/src/utils/artifactGroups.ts 同规则:
 * 交付目录形如 /artifacts/<thread>/turn-<n>/,一轮回答的产物天然成为一个 bundle。
 */

import { ChatArtifact } from '../types/Models'

/** 一轮交付物分组 */
export interface ArtifactTurnGroup {
  /** 交付轮次目录名(turn-<n>);历史数据可能为空串 */
  turn: string
  items: Array<ChatArtifact>
}

/** 可挂载产物的消息(移动端消息模型的最小约束) */
export interface ArtifactCarrier {
  role: string
  artifacts?: Array<ChatArtifact>
}

/** 按交付轮次分组(保序;无轮次的产物并入当前分组) */
export function groupArtifactsByTurn(artifacts: Array<ChatArtifact>): Array<ArtifactTurnGroup> {
  const groups: Array<ArtifactTurnGroup> = []
  for (let i = 0; i < artifacts.length; i++) {
    const item: ChatArtifact = artifacts[i]
    const turn: string = item.turn === undefined ? '' : item.turn
    if (groups.length > 0) {
      const last: ArtifactTurnGroup = groups[groups.length - 1]
      if (turn === '' || last.turn === turn) {
        last.items.push(item)
        continue
      }
    }
    groups.push({ turn: turn, items: [item] } as ArtifactTurnGroup)
  }
  return groups
}

/** 交付轮次展示名:turn-3 → 第 3 轮交付物 */
export function turnLabel(turn?: string): string {
  if (turn === undefined) {
    return ''
  }
  const match: RegExpExecArray | null = /^turn-(\d+)$/.exec(turn)
  return match === null ? '' : '第 ' + match[1] + ' 轮交付物'
}

/**
 * 把会话产物按轮次挂到对应助手消息上(就地修改并返回同一数组)。
 *
 * 轮次目录与助手回复数量一致时精确挂载;数量不匹配(例如中途重答)时
 * 全部挂到最后一条助手回复,保证产物不丢失。
 * 说明:ArkTS 不支持对象展开,这里直接写回消息字段,由上层触发 UI 刷新。
 */
export function attachArtifactsToMessages(
  messages: Array<ArtifactCarrier>,
  artifacts: Array<ChatArtifact>
): Array<ArtifactCarrier> {
  if (artifacts.length === 0 || messages.length === 0) {
    return messages
  }

  const assistantIndexes: Array<number> = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant') {
      assistantIndexes.push(i)
    }
  }
  if (assistantIndexes.length === 0) {
    return messages
  }

  const groups: Array<ArtifactTurnGroup> = groupArtifactsByTurn(artifacts)
  if (groups.length === assistantIndexes.length) {
    for (let i = 0; i < groups.length; i++) {
      messages[assistantIndexes[i]].artifacts = groups[i].items
    }
    return messages
  }

  const merged: Array<ChatArtifact> = []
  for (let i = 0; i < groups.length; i++) {
    const items: Array<ChatArtifact> = groups[i].items
    for (let j = 0; j < items.length; j++) {
      merged.push(items[j])
    }
  }
  messages[assistantIndexes[assistantIndexes.length - 1]].artifacts = merged
  return messages
}