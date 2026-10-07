import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '../../../src/renderer/src/store/workspace'
import type { Workspace } from '../../../src/shared/contracts'

/** 最小工作空间记录桩 */
function ws(
  id: string,
  source: Workspace['source'] = 'created',
  sortOrder = 0
): Workspace {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    source,
    userId: source === 'default' ? null : 'u1',
    createdAt: 1,
    sortOrder
  }
}

/** 用最小 window.api 桩驱动 store（只提供被测方法） */
function setWindowApi(api: Record<string, unknown>): void {
  ;(globalThis as Record<string, unknown>).window = { api, localStorage: undefined }
}

describe('useWorkspaceStore（rename / reorder）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // store 顶层读 localStorage 恢复 currentId（测试环境无 localStorage）
    ;(globalThis as Record<string, unknown>).localStorage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined
    }
  })

  it('rename：成功后采用主进程回传的名字（sanitize 后的值）', async () => {
    setWindowApi({
      renameWorkspace: vi.fn(async () => ({ success: true, data: ws('a') }))
    })
    const store = useWorkspaceStore()
    store.workspaces = [ws('default', 'default'), ws('a')]
    await store.rename('a', '  新名  ')
    expect(store.workspaces[1].name).toBe('a') // 以回传对象为准（桩里名字仍是 a）
    expect(store.workspaces).toHaveLength(2)
  })

  it('rename：失败回滚本地名字并抛出主进程文案', async () => {
    setWindowApi({
      renameWorkspace: vi.fn(async () => ({ success: false, error: '工作空间已存在：B' }))
    })
    const store = useWorkspaceStore()
    store.workspaces = [ws('default', 'default'), ws('a')]
    await expect(store.rename('a', 'B')).rejects.toThrow('工作空间已存在：B')
    expect(store.workspaces[1].name).toBe('a')
  })

  it('reorder：成功后采用服务端返回的全量顺序（默认空间仍首位）', async () => {
    const serverOrder = [ws('default', 'default'), ws('c'), ws('a'), ws('b')]
    setWindowApi({
      reorderWorkspaces: vi.fn(async () => ({ success: true, data: serverOrder }))
    })
    const store = useWorkspaceStore()
    store.workspaces = [ws('default', 'default'), ws('a'), ws('b'), ws('c')]
    await store.reorder(['c', 'a', 'b'])
    expect(store.workspaces.map((w) => w.id)).toEqual(['default', 'c', 'a', 'b'])
  })

  it('reorder：本地乐观顺序在等待期即生效（默认空间不参与排序，恒在首位）', async () => {
    let resolveCall: ((value: unknown) => void) | null = null
    setWindowApi({
      reorderWorkspaces: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveCall = resolve
          })
      )
    })
    const store = useWorkspaceStore()
    store.workspaces = [ws('default', 'default'), ws('a'), ws('b')]
    const pending = store.reorder(['b', 'a'])
    expect(store.workspaces.map((w) => w.id)).toEqual(['default', 'b', 'a'])
    resolveCall!({ success: true, data: [ws('default', 'default'), ws('b'), ws('a')] })
    await pending
    expect(store.workspaces.map((w) => w.id)).toEqual(['default', 'b', 'a'])
  })

  it('reorder：失败回滚原顺序并抛出主进程文案', async () => {
    setWindowApi({
      reorderWorkspaces: vi.fn(async () => ({
        success: false,
        error: '排序列表与工作空间列表不一致，请刷新后重试'
      }))
    })
    const store = useWorkspaceStore()
    store.workspaces = [ws('default', 'default'), ws('a'), ws('b')]
    await expect(store.reorder(['b', 'a'])).rejects.toThrow('不一致')
    expect(store.workspaces.map((w) => w.id)).toEqual(['default', 'a', 'b'])
  })

  it('create：新空间插到默认空间之后（不能挤掉置顶的默认空间）', async () => {
    setWindowApi({
      createWorkspace: vi.fn(async () => ({ success: true, data: ws('新建') }))
    })
    const store = useWorkspaceStore()
    store.workspaces = [ws('default', 'default'), ws('a')]
    await store.create('新建')
    expect(store.workspaces.map((w) => w.id)).toEqual(['default', '新建', 'a'])
    expect(store.currentId).toBe('新建')
  })

  it('create：无默认空间记录时插到首位', async () => {
    setWindowApi({
      createWorkspace: vi.fn(async () => ({ success: true, data: ws('新建') }))
    })
    const store = useWorkspaceStore()
    store.workspaces = [ws('a')]
    await store.create('新建')
    expect(store.workspaces.map((w) => w.id)).toEqual(['新建', 'a'])
  })
})
