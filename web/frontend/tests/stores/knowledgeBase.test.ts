import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBase'
import * as api from '@/services/knowledgeBaseApi'
import type { KB, KBDoc, KBShare } from '@/types/knowledgeBase'

vi.mock('@/services/knowledgeBaseApi', () => ({
  fetchKBPage: vi.fn(),
  fetchKnowledgeBases: vi.fn(),
  fetchKnowledgeBase: vi.fn(),
  createKnowledgeBase: vi.fn(),
  updateKnowledgeBase: vi.fn(),
  deleteKnowledgeBase: vi.fn(),
  fetchStats: vi.fn(),
  fetchKbShares: vi.fn(),
  createKbShares: vi.fn(),
  deleteKbShare: vi.fn(),
  cancelKbShares: vi.fn(),
  fetchShareInvitations: vi.fn(),
  fetchSharesByMe: vi.fn(),
  searchShareCandidates: vi.fn(),
  acceptKbShare: vi.fn(),
  rejectKbShare: vi.fn(),
  updateKbVisibility: vi.fn(),
  // 组织（迭代 6 T6.2）
  pinKnowledgeBase: vi.fn(),
  moveKnowledgeBase: vi.fn(),
  copyKnowledgeBase: vi.fn(),
  assignKbGroup: vi.fn(),
  fetchKbGroups: vi.fn(),
  createKbGroup: vi.fn(),
  renameKbGroup: vi.fn(),
  deleteKbGroup: vi.fn(),
  exportKnowledgeBaseConfig: vi.fn(),
  downloadKnowledgeBaseConfig: vi.fn(),
  // 文档管理（迭代 6 T6.1）
  uploadDocument: vi.fn(),
  createTextDocument: vi.fn(),
  importFromUrl: vi.fn(),
  batchDocumentOp: vi.fn(),
  downloadDocument: vi.fn(),
}))

function kb(overrides: Partial<KB> = {}): KB {
  return {
    id: 'kb-1',
    name: '产品手册',
    description: '内部产品文档',
    status: 'ready',
    docs: 1,
    chunks: 10,
    entities: 2,
    relations: 1,
    size: '1.0 KB',
    updatedAt: '2026-09-01',
    config: {} as KB['config'],
    documents: [],
    entitiesData: [],
    relationsData: [],
    tags: [],
    visibility: 'private',
    isOwner: true,
    ownerName: null,
    ...overrides,
  }
}

function share(overrides: Partial<KBShare> = {}): KBShare {
  return {
    id: 'share-1',
    kbId: 'kb-1',
    kbName: '产品手册',
    userId: 'user-b',
    username: 'bob',
    nickname: '鲍勃',
    avatar: '',
    status: 'pending',
    permission: 'read',
    createdAt: '2026-09-01T10:00:00',
    acceptedAt: null,
    ...overrides,
  }
}

const STATS = {
  totalKbs: 1, totalDocs: 1, totalChunks: 10, totalEntities: 2, indexing: 0,
}

const mocked = vi.mocked(api)

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocked.fetchStats.mockResolvedValue(STATS)
  mocked.fetchKBPage.mockResolvedValue({
    items: [], total: 0, page: 1, page_size: 12,
  })
  mocked.fetchShareInvitations.mockResolvedValue({ items: [], total: 0 })
  mocked.fetchSharesByMe.mockResolvedValue({ items: [], total: 0 })
})

describe('知识库 store —— 左栏导航', () => {
  it('默认停在概览，四个分组默认展开', () => {
    const store = useKnowledgeBaseStore()
    expect(store.activeNav).toBe('overview')
    expect(store.groupExpanded).toMatchObject({
      public: true, personal: true, sharedByMe: true, sharedWithMe: true,
    })
  })

  it('切换分组会折叠 / 展开', () => {
    const store = useKnowledgeBaseStore()
    store.toggleGroup('public')
    expect(store.groupExpanded.public).toBe(false)
    store.toggleGroup('public')
    expect(store.groupExpanded.public).toBe(true)
  })
})

describe('知识库 store —— 分组加载', () => {
  it('公共知识库走 public scope', async () => {
    const store = useKnowledgeBaseStore()
    mocked.fetchKBPage.mockResolvedValue({
      items: [kb({ id: 'kb-pub', visibility: 'public', isOwner: false })],
      total: 1,
      page: 1,
      page_size: 12,
    })

    await store.loadGroup('public', 1)

    expect(mocked.fetchKBPage).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'public' }),
    )
    expect(store.groups.public.items).toHaveLength(1)
    expect(store.groups.public.total).toBe(1)
    expect(store.groups.public.loaded).toBe(true)
  })

  it('个人知识库走 personal scope', async () => {
    const store = useKnowledgeBaseStore()
    await store.loadGroup('personal', 1)
    expect(mocked.fetchKBPage).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'personal' }),
    )
  })

  it('「共享给我的」列表取服务端已接受结果，邀请记录独立维护', async () => {
    const store = useKnowledgeBaseStore()
    // 邀请接口同时返回待接受与已接受；列表接口只返回已接受的库
    mocked.fetchShareInvitations.mockResolvedValue({
      items: [
        share({ id: 's-accepted', kbId: 'kb-a', status: 'accepted' }),
        share({ id: 's-pending', kbId: 'kb-b', status: 'pending' }),
      ],
      total: 2,
    })
    mocked.fetchKBPage.mockResolvedValue({
      items: [kb({ id: 'kb-a', isOwner: false })],
      total: 1,
      page: 1,
      page_size: 12,
    })

    await store.loadGroup('sharedWithMe', 1)

    expect(mocked.fetchKBPage).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'shared_with_me' }),
    )
    expect(store.groups.sharedWithMe.items.map((k) => k.id)).toEqual(['kb-a'])
    expect(store.groups.sharedWithMe.total).toBe(1)
    // 待接受的邀请仍进入角标与接受/拒绝入口
    expect(store.pendingInvitationCount).toBe(1)
    expect(store.acceptedInvitations().map((s) => s.kbId)).toEqual(['kb-a'])
  })

  it('「我的共享知识」只收录我分享出去的库', async () => {
    const store = useKnowledgeBaseStore()
    mocked.fetchSharesByMe.mockResolvedValue({
      items: [share({ kbId: 'kb-shared', status: 'accepted' })],
      total: 1,
    })
    mocked.fetchKBPage.mockResolvedValue({
      items: [kb({ id: 'kb-shared' }), kb({ id: 'kb-private-only' })],
      total: 2,
      page: 1,
      page_size: 100,
    })

    await store.loadGroup('sharedByMe', 1)

    expect(store.groups.sharedByMe.items.map((k) => k.id)).toEqual(['kb-shared'])
    expect(store.ownedSharesFor('kb-shared')).toHaveLength(1)
  })

  it('分组预览按 8 条截断并暴露「还有更多」', async () => {
    const store = useKnowledgeBaseStore()
    const items = Array.from({ length: 20 }, (_, i) => kb({ id: `kb-${i}` }))
    mocked.fetchKBPage.mockResolvedValue({
      items, total: 20, page: 1, page_size: 12,
    })

    await store.loadGroup('personal', 1)

    expect(store.groupPreview('personal')).toHaveLength(8)
    expect(store.groupHasMore('personal')).toBe(true)
  })
})

describe('知识库 store —— 分享', () => {
  it('邀请后按服务端结果刷新「我的共享知识」', async () => {
    const store = useKnowledgeBaseStore()
    mocked.createKbShares.mockResolvedValue({
      items: [share({ status: 'pending' })],
      total: 1,
    })
    mocked.fetchSharesByMe.mockResolvedValue({
      items: [share({ status: 'pending' })],
      total: 1,
    })
    mocked.fetchKBPage.mockResolvedValue({
      items: [kb({ id: 'kb-1' })], total: 1, page: 1, page_size: 100,
    })

    await store.inviteShares('kb-1', ['user-b'])

    expect(mocked.createKbShares).toHaveBeenCalledWith('kb-1', ['user-b'])
    expect(store.ownedSharesFor('kb-1')).toHaveLength(1)
    expect(store.sharesByMe['kb-1'][0].status).toBe('pending')
    expect(store.groups.sharedByMe.items.map((k) => k.id)).toEqual(['kb-1'])
  })

  it('删除单个被分享用户后该库不再出现在「我的共享」', async () => {
    const store = useKnowledgeBaseStore()
    mocked.deleteKbShare.mockResolvedValue(undefined)
    // 移除后服务端不再返回该分享记录
    mocked.fetchSharesByMe.mockResolvedValue({ items: [], total: 0 })
    mocked.fetchKBPage.mockResolvedValue({
      items: [kb({ id: 'kb-1' })], total: 1, page: 1, page_size: 100,
    })

    await store.removeShare('kb-1', 'share-1')

    expect(mocked.deleteKbShare).toHaveBeenCalledWith('kb-1', 'share-1')
    expect(store.ownedSharesFor('kb-1')).toHaveLength(0)
    expect(store.groups.sharedByMe.items).toHaveLength(0)
  })

  it('取消全部分享后清空该库的分享记录', async () => {
    const store = useKnowledgeBaseStore()
    mocked.cancelKbShares.mockResolvedValue(1)
    mocked.fetchSharesByMe.mockResolvedValue({ items: [], total: 0 })
    mocked.fetchKBPage.mockResolvedValue({
      items: [kb({ id: 'kb-1' })], total: 1, page: 1, page_size: 100,
    })

    await store.cancelShares('kb-1')

    expect(mocked.cancelKbShares).toHaveBeenCalledWith('kb-1')
    expect(store.ownedSharesFor('kb-1')).toHaveLength(0)
    expect(store.groups.sharedByMe.items).toHaveLength(0)
  })

  it('接受 / 拒绝邀请会刷新「共享给我的」', async () => {
    const store = useKnowledgeBaseStore()
    mocked.acceptKbShare.mockResolvedValue(share({ status: 'accepted' }))
    mocked.rejectKbShare.mockResolvedValue(share({ status: 'rejected' }))

    await store.respondInvitation('share-1', true)
    expect(mocked.acceptKbShare).toHaveBeenCalledWith('share-1')

    await store.respondInvitation('share-2', false)
    expect(mocked.rejectKbShare).toHaveBeenCalledWith('share-2')
    expect(mocked.fetchShareInvitations).toHaveBeenCalled()
  })

  it('发布公共库会同步概览列表与公共栏目', async () => {
    const store = useKnowledgeBaseStore()
    mocked.updateKbVisibility.mockResolvedValue(
      kb({ visibility: 'public' }),
    )
    store.selectedKb = kb()

    await store.setVisibility('kb-1', 'public')

    expect(mocked.updateKbVisibility).toHaveBeenCalledWith('kb-1', 'public')
    expect(store.selectedKb?.visibility).toBe('public')
    expect(mocked.fetchKBPage).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'public' }),
    )
  })
})

describe('知识库 store —— 概览', () => {
  it('概览拉取全部可见范围与全局统计', async () => {
    const store = useKnowledgeBaseStore()
    mocked.fetchKBPage.mockResolvedValue({
      items: [kb({ id: 'kb-mine' }), kb({ id: 'kb-pub', isOwner: false })],
      total: 2,
      page: 1,
      page_size: 100,
    })
    mocked.fetchStats.mockResolvedValue({ ...STATS, totalKbs: 2 })

    await store.fetchKbs()

    expect(mocked.fetchKBPage).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'all' }),
    )
    expect(mocked.fetchStats).toHaveBeenCalledWith('all')
    expect(store.kbs).toHaveLength(2)
    expect(store.stats.totalKbs).toBe(2)
  })

  it('检索与筛选走服务端（不再拉 100 条在前端过滤）', async () => {
    const store = useKnowledgeBaseStore()
    mocked.fetchKBPage.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 24 })

    store.searchQuery = '代码'
    store.tagFilter = '运维'
    await store.fetchKbs()

    expect(mocked.fetchKBPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: '代码', tag: '运维', page: 1 }),
    )
  })

  it('标签筛选变化时回到第一页重新取', async () => {
    const store = useKnowledgeBaseStore()
    mocked.fetchKBPage.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 24 })

    await store.setTagFilter('运维')

    expect(mocked.fetchKBPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ tag: '运维', page: 1 }),
    )
  })

  it('分页参数随页大小一起传给服务端', async () => {
    const store = useKnowledgeBaseStore()
    mocked.fetchKBPage.mockResolvedValue({ items: [], total: 50, page: 2, page_size: 24 })

    await store.setKbPage(2)

    expect(mocked.fetchKBPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 2, page_size: 24 }),
    )
    expect(store.kbTotal).toBe(50)
  })
})

describe('知识库 store —— 逐文件上传（迭代 6 T6.1）', () => {
  function doc(name: string): KBDoc {
    return {
      id: `doc-${name}`, name, type: 'md', size: '1 KB', status: 'queued',
      progress: 0, chunks: 0, entities: 0, relations: 0, uploadedAt: '2026-09-26',
    }
  }

  function file(name: string): File {
    return new File(['内容'], name, { type: 'text/markdown' })
  }

  it('每个文件一个请求，而不是一次带多个', async () => {
    const seen: string[] = []
    mocked.uploadDocument.mockImplementation(async (_kb: string, f: File) => {
      seen.push(f.name)
      return { created: [doc(f.name)], skipped: [] }
    })
    const store = useKnowledgeBaseStore()

    await store.uploadDocs('kb-1', [file('a.md'), file('b.md'), file('c.md')])

    expect(seen.sort()).toEqual(['a.md', 'b.md', 'c.md'])
  })

  it('单个文件失败不中断其余，并逐条汇总', async () => {
    mocked.uploadDocument.mockImplementation(async (_kb: string, f: File) => {
      if (f.name === 'bad.md') throw new Error('超过大小上限')
      return { created: [doc(f.name)], skipped: [] }
    })
    const store = useKnowledgeBaseStore()

    const summary = await store.uploadDocs('kb-1', [file('a.md'), file('bad.md'), file('c.md')])

    expect(summary.created).toBe(2)
    expect(summary.failed).toEqual([{ name: 'bad.md', message: '超过大小上限' }])
  })

  it('重复文件计入"跳过"而不是"失败"', async () => {
    mocked.uploadDocument.mockResolvedValue({
      created: [],
      skipped: [{ name: 'a.md', reason: 'duplicate', existingDocName: '旧版.md' }],
    })
    const store = useKnowledgeBaseStore()

    const summary = await store.uploadDocs('kb-1', [file('a.md')])

    expect(summary.created).toBe(0)
    expect(summary.failed).toEqual([])
    expect(summary.skipped[0].existingDocName).toBe('旧版.md')
  })

  it('并发不超过上限（默认 2）', async () => {
    let inFlight = 0
    let peak = 0
    mocked.uploadDocument.mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return { created: [doc('x')], skipped: [] }
    })
    const store = useKnowledgeBaseStore()

    await store.uploadDocs('kb-1', [file('a.md'), file('b.md'), file('c.md'), file('d.md')])

    expect(peak).toBeLessThanOrEqual(2)
  })

  it('成功的文件立刻并入当前知识库的文档列表', async () => {
    mocked.uploadDocument.mockResolvedValue({ created: [doc('新来的.md')], skipped: [] })
    const store = useKnowledgeBaseStore()
    store.selectedKb = { ...kb({ id: 'kb-1' }), documents: [], docs: 0 }

    await store.uploadDocs('kb-1', [file('新来的.md')])

    expect(store.selectedKb?.documents.map((d) => d.name)).toEqual(['新来的.md'])
    expect(store.selectedKb?.docs).toBe(1)
  })

  it('上传状态回调按文件回报进度与终态', async () => {
    mocked.uploadDocument.mockImplementation(async (_kb: string, _f: File, _cfg: unknown, onProgress?: (p: number) => void) => {
      onProgress?.(42)
      return { created: [doc('a.md')], skipped: [] }
    })
    const store = useKnowledgeBaseStore()
    const states: { name: string; status: string; percent: number }[] = []

    await store.uploadDocs('kb-1', [file('a.md')], undefined, {
      onFileState: (s) => states.push({ name: s.name, status: s.status, percent: s.percent }),
    })

    expect(states[0]).toMatchObject({ name: 'a.md', status: 'uploading', percent: 0 })
    expect(states.some((s) => s.percent === 42)).toBe(true)
    expect(states[states.length - 1]).toMatchObject({ status: 'done', percent: 100 })
  })
})

describe('知识库 store —— 组织动作（迭代 6 T6.2）', () => {
  function group(id: string, name: string, kbCount = 0) {
    return { id, name, sortOrder: 0, kbCount }
  }

  it('置顶后整页重取（顺序由服务端决定）', async () => {
    mocked.fetchKBPage.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 24 })
    mocked.pinKnowledgeBase.mockResolvedValue(kb({ isPinned: true }))
    const store = useKnowledgeBaseStore()

    await store.togglePin('kb-1', true)

    expect(mocked.pinKnowledgeBase).toHaveBeenCalledWith('kb-1', true)
    expect(mocked.fetchKBPage).toHaveBeenCalled()
  })

  it('上移 / 下移调用对应方向', async () => {
    mocked.fetchKBPage.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 24 })
    mocked.moveKnowledgeBase.mockResolvedValue(kb())
    const store = useKnowledgeBaseStore()

    await store.moveKb('kb-1', 'up')

    expect(mocked.moveKnowledgeBase).toHaveBeenCalledWith('kb-1', 'up')
  })

  it('复制后回到第一页', async () => {
    mocked.copyKnowledgeBase.mockResolvedValue(kb({ id: 'kb-copy', name: '副本' }))
    mocked.fetchKBPage.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 24 })
    const store = useKnowledgeBaseStore()

    const created = await store.copyKb('kb-1')

    expect(created.name).toBe('副本')
    expect(mocked.fetchKBPage).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }))
  })

  it('导出走下载接口，带上库名', async () => {
    mocked.downloadKnowledgeBaseConfig.mockResolvedValue(undefined)
    const store = useKnowledgeBaseStore()

    await store.exportKb('kb-1', '产品手册')

    expect(mocked.downloadKnowledgeBaseConfig).toHaveBeenCalledWith('kb-1', '产品手册')
  })

  it('分组：创建后进入本地列表，删除后本地也移除', async () => {
    mocked.createKbGroup.mockResolvedValue(group('g1', '产品资料'))
    mocked.deleteKbGroup.mockResolvedValue(true)
    const store = useKnowledgeBaseStore()

    await store.createGroup('产品资料')
    expect(store.kbGroups.map((g) => g.name)).toEqual(['产品资料'])

    await store.removeGroup('g1')
    expect(store.kbGroups).toEqual([])
  })

  it('删除分组后本地把这些库的归属清掉（服务端已 SET NULL）', async () => {
    mocked.deleteKbGroup.mockResolvedValue(true)
    const store = useKnowledgeBaseStore()
    store.kbs = [kb({ id: 'kb-1', groupId: 'g1' }), kb({ id: 'kb-2', groupId: 'g2' })]

    await store.removeGroup('g1')

    expect(store.kbs.map((k) => k.groupId)).toEqual([null, 'g2'])
  })

  it('归组后就地更新该库并刷新分组计数', async () => {
    mocked.assignKbGroup.mockResolvedValue(kb({ id: 'kb-1', groupId: 'g1' }))
    mocked.fetchKbGroups.mockResolvedValue([group('g1', '产品资料', 1)])
    const store = useKnowledgeBaseStore()
    store.kbs = [kb({ id: 'kb-1' })]

    await store.assignGroup('kb-1', 'g1')

    expect(store.kbs[0].groupId).toBe('g1')
    expect(store.kbGroups[0].kbCount).toBe(1)
  })
})
