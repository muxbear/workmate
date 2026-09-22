import { describe, expect, it } from 'vitest'
import {
  attachArtifactsToMessages,
  groupArtifactsByTurn,
  turnLabel,
} from '@/utils/artifactGroups'
import type { ChatArtifact } from '@/types/chat'

function artifact(path: string, turn?: string): ChatArtifact {
  return {
    path,
    name: path.split('/').pop() ?? path,
    source_tool: 'write_file',
    created_at: 1,
    turn,
  }
}

describe('artifactGroups（交付物按轮分组）', () => {
  it('按轮次保序分组；无轮次的产物并入当前分组', () => {
    const groups = groupArtifactsByTurn([
      artifact('/artifacts/t1/turn-1/a.md', 'turn-1'),
      artifact('/artifacts/t1/turn-1/a/f1.png', 'turn-1'),
      artifact('/artifacts/t1/turn-2/b.md', 'turn-2'),
      artifact('/workspace/legacy.txt'),
    ])
    expect(groups.map((group) => group.turn)).toEqual(['turn-1', 'turn-2'])
    expect(groups[0].items).toHaveLength(2)
    expect(groups[1].items).toHaveLength(2)
    expect(groups[1].items[1].path).toContain('legacy')
  })

  it('轮次数与助手消息数一致时精确挂载', () => {
    const messages = [
      { role: 'user' },
      { role: 'assistant' },
      { role: 'user' },
      { role: 'assistant' },
    ]
    const result = attachArtifactsToMessages(messages, [
      artifact('/artifacts/t1/turn-1/a.md', 'turn-1'),
      artifact('/artifacts/t1/turn-2/b.md', 'turn-2'),
    ])
    expect(result[1].artifacts).toHaveLength(1)
    expect(result[1].artifacts?.[0].path).toContain('turn-1')
    expect(result[3].artifacts?.[0].path).toContain('turn-2')
  })

  it('轮次数不匹配时全部挂到最后一条助手消息', () => {
    const messages = [{ role: 'assistant' }, { role: 'assistant' }]
    const result = attachArtifactsToMessages(messages, [
      artifact('/artifacts/t1/turn-1/a.md', 'turn-1'),
    ])
    expect(result[0].artifacts).toBeUndefined()
    expect(result[1].artifacts).toHaveLength(1)
  })

  it('无产物或无助手消息时原样返回', () => {
    const messages = [{ role: 'user' }]
    expect(attachArtifactsToMessages(messages, [])).toBe(messages)
    expect(attachArtifactsToMessages([], [artifact('/a.md', 'turn-1')])).toEqual([])
  })

  it('turnLabel 解析轮次展示名', () => {
    expect(turnLabel('turn-3')).toBe('第 3 轮交付物')
    expect(turnLabel('')).toBe('')
    expect(turnLabel(undefined)).toBe('')
    expect(turnLabel('bad')).toBe('')
  })
})
