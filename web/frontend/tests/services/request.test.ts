import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sendStreamRequest } from '@/services/request'
import type { StreamCallbacks } from '@/services/request'
import type { ChatArtifact, ChatInputPart, SelectionEcho } from '@/types/chat'

function sse(event: string, data: Record<string, unknown>): string {
  return 'data: ' + JSON.stringify({ event, data }) + '\n\n'
}

function responseWith(text: string): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
  return { ok: true, body: stream } as unknown as Response
}

function makeCallbacks(overrides: Partial<StreamCallbacks> = {}): StreamCallbacks {
  return {
    onToken: () => {},
    onReasoning: () => {},
    onAgentStart: () => {},
    onAgentEnd: () => {},
    onToolStart: () => {},
    onToolOutput: () => {},
    onToolEnd: () => {},
    onThreadId: () => {},
    onDone: () => {},
    onError: () => {},
    ...overrides,
  }
}

describe('sendStreamRequest', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('下发选择项与保序部件', async () => {
    let captured: Record<string, unknown> = {}
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body)) as Record<string, unknown>
      return responseWith(sse('done', { thread_id: 't-1', duration_ms: 128 }))
    })

    const parts: ChatInputPart[] = [
      { type: 'text', text: '看下' },
      { type: 'file', attachmentId: 'a1', filename: '报表.xlsx' },
    ]

    await sendStreamRequest('看下', {
      callbacks: makeCallbacks(),
      attachmentIds: ['a1'],
      parts,
      selection: {
        expertId: 'e1',
        expertName: '财务专家',
        expertPrompt: '',
        skillIds: ['s1'],
        kbIds: ['kb1'],
        mode: 'knowledge',
        model: 'deepseek-v4-pro',
        modelId: 'm-1',
        providerId: 'p1',
        webSearch: true,
        workspaceId: 'my-files',
        allowNetwork: false,
        allowShell: true,
      },
    })

    expect(captured.message).toBe('看下')
    expect(captured.attachment_ids).toEqual(['a1'])
    expect(captured.expert_id).toBe('e1')
    expect(captured.skill_ids).toEqual(['s1'])
    expect(captured.kb_ids).toEqual(['kb1'])
    expect(captured.mode).toBe('knowledge')
    expect(captured.model).toBe('deepseek-v4-pro')
    expect(captured.model_id).toBe('m-1')
    expect(captured.provider_id).toBe('p1')
    expect(captured.web_search).toBe(true)
    expect(captured.workspace_id).toBe('my-files')
    expect(captured.allow_network).toBe(false)
    expect(captured.allow_shell).toBe(true)
  })

  it('解析 selection 事件与 done 耗时', async () => {
    vi.stubGlobal('fetch', async () => {
      return responseWith(
        sse('selection', { expert_name: '财务专家', mode: 'knowledge' }) +
          sse('done', { thread_id: 't-1', duration_ms: 128 }),
      )
    })

    const seen: { selection?: SelectionEcho; duration?: number } = {}
    await sendStreamRequest('你好', {
      callbacks: makeCallbacks({
        onSelection: (data) => {
          seen.selection = data
        },
        onDone: (info) => {
          seen.duration = info?.durationMs
        },
      }),
    })

    expect(seen.selection?.expert_name).toBe('财务专家')
    expect(seen.duration).toBe(128)
  })

  it('解析 artifact 产物事件', async () => {
    vi.stubGlobal('fetch', async () => {
      return responseWith(
        sse('artifact', {
          path: '/workspace/report.md',
          name: 'report.md',
          source_tool: 'write_file',
          created_at: 1,
        }) + sse('done', { thread_id: 't-3' }),
      )
    })

    const seen: { artifact?: ChatArtifact } = {}
    await sendStreamRequest('写个报告', {
      callbacks: makeCallbacks({
        onArtifact: (artifact) => {
          seen.artifact = artifact
        },
      }),
    })

    expect(seen.artifact?.name).toBe('report.md')
    expect(seen.artifact?.source_tool).toBe('write_file')
  })

  it('未传选择项时请求体保持精简', async () => {
    let captured: Record<string, unknown> = {}
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body)) as Record<string, unknown>
      return responseWith(sse('done', { thread_id: 't-2' }))
    })

    await sendStreamRequest('你好', { callbacks: makeCallbacks() })

    expect(Object.keys(captured)).toEqual(['message'])
  })
})
