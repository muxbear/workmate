import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import {
  ArtifactCollector,
  type AgentRunHandle,
  type AgentToolCallHandle
} from '../../../src/main/agent/artifact-collector'

function makeWin(): BrowserWindow {
  return { webContents: { send: vi.fn() } } as unknown as BrowserWindow
}

async function* callsOf(...calls: AgentToolCallHandle[]): AsyncIterable<AgentToolCallHandle> {
  for (const call of calls) yield call
}

function collector(win: BrowserWindow, workspaceId: string | null = 'ws1'): ArtifactCollector {
  return new ArtifactCollector({ win, workspaceId })
}

describe('ArtifactCollector（工具名 → 处理器注册表）', () => {
  it('未注册的工具名（如 write_todos）不产生任何事件与产物', async () => {
    const win = makeWin()
    const c = collector(win)
    await c.walkTools({
      toolCalls: callsOf({ name: 'write_todos', input: { todos: [] } })
    } as AgentRunHandle)
    const send = win.webContents.send as ReturnType<typeof vi.fn>
    expect(send).not.toHaveBeenCalled()
    expect(c.artifacts).toHaveLength(0)
  })

  it('递归遍历 subagents：子智能体内的 write_file 同样登记产物', async () => {
    const win = makeWin()
    const c = collector(win)
    const sub: AgentRunHandle = {
      toolCalls: callsOf({
        name: 'write_file',
        input: { file_path: '/子报告.md', content: '子内容' },
        output: Promise.resolve('ok')
      })
    }
    await c.walkTools({
      toolCalls: callsOf(),
      subagents: (async function* () {
        yield sub
      })()
    })
    expect(c.artifacts).toHaveLength(1)
    expect(c.artifacts[0].relPath).toBe('子报告.md')
  })

  it('pushArtifact 去重：同 relPath+ext 只登记一次、只推一轮事件', async () => {
    const win = makeWin()
    const c = collector(win)
    const artifact = { name: '方案.md', relPath: '方案.md', ext: 'md', preview: 'text' } as never
    await c.pushArtifact(artifact, '正文', undefined)
    await c.pushArtifact(artifact, '正文', undefined)
    const send = win.webContents.send as ReturnType<typeof vi.fn>
    expect(send.mock.calls.filter((call) => call[0] === 'agent:artifact-start')).toHaveLength(1)
    expect(c.artifacts).toHaveLength(1)
  })

  it('done 失败时推 artifact-error 且不入产物清单', async () => {
    const win = makeWin()
    const c = collector(win)
    const artifact = { name: '方案.md', relPath: '方案.md', ext: 'md', preview: 'video' } as never
    await c.pushArtifact(artifact, '', Promise.reject(new Error('落盘失败')))
    const send = win.webContents.send as ReturnType<typeof vi.fn>
    const errors = send.mock.calls.filter((call) => call[0] === 'agent:artifact-error')
    expect(errors).toHaveLength(1)
    expect((errors[0][1] as { error: string }).error).toBe('落盘失败')
    expect(c.artifacts).toHaveLength(0)
  })
})
