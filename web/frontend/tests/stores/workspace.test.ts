import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useWorkspaceStore, HISTORY_TAB_KEY } from '@/stores/workspace'
import type { ChatArtifact } from '@/types/chat'

function artifact(over: Partial<ChatArtifact> = {}): ChatArtifact {
  return {
    path: '/workspace/报告.md',
    name: '报告.md',
    source_tool: 'write_file',
    created_at: 1,
    ...over,
  }
}

describe('workspaceStore 文档标签页', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('点击产物后新增标签页并用产物 ID 作为键', () => {
    const store = useWorkspaceStore()
    expect(store.openDocument(artifact({ artifact_id: 'a1' }), 't1')).toBe(true)
    expect(store.tabs).toHaveLength(1)
    expect(store.tabs[0].artifactId).toBe('a1')
    expect(store.activeKey).toBe('t1::a1')
  })

  it('同一路径的不同产物 ID 生成两个标签页', () => {
    const store = useWorkspaceStore()
    store.openDocument(artifact({ artifact_id: 'a1' }), 't1')
    store.openDocument(artifact({ artifact_id: 'a2' }), 't1')
    expect(store.tabs).toHaveLength(2)
  })

  it('缺少产物 ID 时回退为路径作为键', () => {
    const store = useWorkspaceStore()
    store.openDocument(artifact(), 't1')
    expect(store.tabs[0].key).toBe('t1::/workspace/报告.md')
  })

  it('关闭当前标签页后回到历史对话', () => {
    const store = useWorkspaceStore()
    store.openDocument(artifact({ artifact_id: 'a1' }), 't1')
    store.closeTab('t1::a1')
    expect(store.tabs).toHaveLength(0)
    expect(store.activeKey).toBe(HISTORY_TAB_KEY)
  })

  it('刷新页面后可从本地存储恢复标签页', () => {
    const store = useWorkspaceStore()
    store.openDocument(artifact({ artifact_id: 'a1' }), 't1')

    // 模拟刷新：重建 Pinia，store 会从 localStorage 恢复
    setActivePinia(createPinia())
    const restored = useWorkspaceStore()

    expect(restored.tabs).toHaveLength(1)
    expect(restored.tabs[0].artifactId).toBe('a1')
    expect(restored.activeKey).toBe('t1::a1')
  })

  it('本地存储数据损坏时回退为历史对话', () => {
    localStorage.setItem('ke-work:workspace-tabs', '{ not json')

    const store = useWorkspaceStore()

    expect(store.tabs).toHaveLength(0)
    expect(store.activeKey).toBe(HISTORY_TAB_KEY)
  })
})
