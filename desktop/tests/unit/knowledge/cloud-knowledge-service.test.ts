import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import axios, { type AxiosInstance } from 'axios'
import MockAdapter from 'axios-mock-adapter'
import { describe, expect, it, vi } from 'vitest'

import {
  CloudAuthRequiredError,
  CloudKnowledgeService,
  type CloudKnowledgeServiceDeps
} from '../../../src/main/knowledge/CloudKnowledgeService'

const API_BASE = 'http://api.test'

function fakeAuthorization(
  overrides: Partial<CloudKnowledgeServiceDeps['authorization']> = {}
): CloudKnowledgeServiceDeps['authorization'] {
  return {
    getSnapshot: vi.fn(() => ({ status: 'authorized' as const, webUser: { id: 'u1' } })),
    hasScopes: vi.fn(() => true),
    tryEnsureAccessToken: vi.fn(async () => 'access-token'),
    ...overrides
  }
}

interface Harness {
  service: CloudKnowledgeService
  mock: MockAdapter
  http: AxiosInstance
  cacheDir: string
  authorization: CloudKnowledgeServiceDeps['authorization']
}

function createHarness(
  overrides: Partial<CloudKnowledgeServiceDeps['authorization']> = {}
): Harness {
  const http = axios.create({ baseURL: API_BASE })
  const mock = new MockAdapter(http)
  const cacheDir = mkdtempSync(join(tmpdir(), 'kw-cloud-kb-'))
  const authorization = fakeAuthorization(overrides)
  const service = new CloudKnowledgeService({ authorization, apiBaseUrl: API_BASE, cacheDir, http })
  return { service, mock, http, cacheDir, authorization }
}

function envelope(data: unknown, code = 0, message = ''): [number, unknown] {
  return [200, { code, data, message }]
}

const RAW_KB = {
  id: 'kb-1',
  name: '公共资料',
  description: '全站可见',
  docs_count: 12,
  chunks_count: 340,
  size_display: '12.3 MB',
  visibility: 'public',
  is_owner: false,
  owner_name: '张三',
  access: 'read',
  updated_at: '2026-09-27T01:02:03'
}

const RAW_DOC = {
  id: 'doc-1',
  name: '规范.md',
  type: 'md',
  size_display: '2.1 KB',
  status: 'indexed',
  chunks_count: 8,
  folder: null,
  uploaded_at: '2026-09-27T01:00:00',
  indexed_at: '2026-09-27T01:01:00',
  error_message: null
}

describe('CloudKnowledgeService · 列表与授权', () => {
  it('按 scope 拉取并映射字段，带上 Bearer token', async () => {
    const { service, mock } = createHarness()
    mock.onGet('/api/knowledge-bases').reply((config) => {
      expect(config.params).toMatchObject({ scope: 'public', page: 1, page_size: 50 })
      expect(config.headers?.Authorization).toBe('Bearer access-token')
      return envelope({ items: [RAW_KB], total: 1, page: 1, page_size: 50 })
    })

    const result = await service.listBases('u1', 'public', { pageSize: 50 })

    expect(result.items[0]).toMatchObject({
      id: 'kb-1',
      name: '公共资料',
      docsCount: 12,
      chunksCount: 340,
      visibility: 'public',
      isOwner: false,
      ownerName: '张三',
      access: 'read'
    })
    expect(result.total).toBe(1)
  })

  it('pageSize 超过后端上限时夹取到 100', async () => {
    const { service, mock } = createHarness()
    let seen = 0
    mock.onGet('/api/knowledge-bases').reply((config) => {
      seen = Number((config.params as { page_size: number }).page_size)
      return envelope({ items: [], total: 0 })
    })

    await service.listBases('u1', 'personal', { pageSize: 500 })

    expect(seen).toBe(100)
  })

  it('信封 code 非 0 时抛出服务端 message', async () => {
    const { service, mock } = createHarness()
    mock.onGet('/api/knowledge-bases').reply(...envelope(null, 4001, '参数错误'))

    await expect(service.listBases('u1', 'personal')).rejects.toThrow('参数错误')
  })

  it('缺 scope 时抛 CloudAuthRequiredError，且**不**调用取 token（后台路径不弹授权）', async () => {
    const { service, authorization, mock } = createHarness({ hasScopes: vi.fn(() => false) })
    mock.onGet('/api/knowledge-bases').reply(200, {})

    await expect(service.listBases('u1', 'personal')).rejects.toBeInstanceOf(CloudAuthRequiredError)
    expect(authorization.tryEnsureAccessToken).not.toHaveBeenCalled()
  })

  it('静默取 token 失败同样表达为「需要授权」', async () => {
    const { service } = createHarness({
      tryEnsureAccessToken: vi.fn(async () => null)
    })

    await expect(service.listBases('u1', 'personal')).rejects.toBeInstanceOf(CloudAuthRequiredError)
  })

  it('服务端 401/403 归一为「需要授权」，其余错误带出后端文案', async () => {
    const forbidden = createHarness()
    forbidden.mock.onGet('/api/knowledge-bases').reply(403, { detail: 'Insufficient scope' })
    await expect(forbidden.service.listBases('u1', 'personal')).rejects.toBeInstanceOf(
      CloudAuthRequiredError
    )

    const broken = createHarness()
    broken.mock.onGet('/api/knowledge-bases').reply(500, { detail: '数据库连接失败' })
    await expect(broken.service.listBases('u1', 'personal')).rejects.toThrow('数据库连接失败')
  })

  it('getStatus 汇总登录与授权状态', () => {
    const authed = createHarness()
    expect(authed.service.getStatus('u1')).toEqual({ linked: true, hasScope: true })

    const anonymous = createHarness({
      getSnapshot: vi.fn(() => ({ status: 'unauthorized' as const, webUser: null })),
      hasScopes: vi.fn(() => false)
    })
    expect(anonymous.service.getStatus('u1')).toEqual({ linked: false, hasScope: false })
  })
})

describe('CloudKnowledgeService · 共享给我的', () => {
  it('邀请映射出 owner 展示名与待接受状态', async () => {
    const { service, mock } = createHarness()
    mock.onGet('/api/knowledge-bases/shares/invitations').reply(
      ...envelope({
        items: [
          {
            id: 'share-1',
            kb_id: 'kb-9',
            kb_name: '被分享的库',
            username: 'lisi',
            nickname: '李四',
            status: 'pending',
            permission: 'read',
            expires_at: null,
            created_at: '2026-09-20T08:00:00'
          }
        ]
      })
    )

    const items = await service.listInvitations('u1')

    expect(items[0]).toMatchObject({
      shareId: 'share-1',
      kbId: 'kb-9',
      kbName: '被分享的库',
      ownerName: '李四',
      status: 'pending',
      permission: 'read'
    })
  })

  it('接受邀请打 accept 端点；拒绝打 reject 端点', async () => {
    const accept = createHarness()
    accept.mock.onPost('/api/knowledge-bases/shares/share-1/accept').reply(...envelope(null))
    await accept.service.respondInvitation('u1', 'share-1', true)
    expect(accept.mock.history.post).toHaveLength(1)

    const reject = createHarness()
    reject.mock.onPost('/api/knowledge-bases/shares/share-1/reject').reply(...envelope(null))
    await reject.service.respondInvitation('u1', 'share-1', false)
    expect(reject.mock.history.post[0].url).toContain('/reject')
  })
})

describe('CloudKnowledgeService · 文档与缓存', () => {
  function mockDocDetail(h: Harness, name = RAW_DOC.name): void {
    h.mock
      .onGet('/api/knowledge-bases/kb-1/documents/doc-1')
      .reply(...envelope({ ...RAW_DOC, name }))
  }

  function mockDownload(h: Harness, content: string): void {
    h.mock
      .onPost('/api/knowledge-bases/kb-1/documents/doc-1/download')
      .reply(200, Buffer.from(content), { 'content-type': 'application/octet-stream' })
  }

  it('文档列表映射 folder=null 与时间字段', async () => {
    const { service, mock } = createHarness()
    mock
      .onGet('/api/knowledge-bases/kb-1/documents')
      .reply(...envelope({ items: [RAW_DOC], total: 1, page: 1, page_size: 100 }))

    const page = await service.listDocuments('u1', 'kb-1')

    expect(page.items[0]).toMatchObject({
      id: 'doc-1',
      name: '规范.md',
      sizeDisplay: '2.1 KB',
      status: 'indexed',
      chunksCount: 8,
      folder: null,
      uploadedAt: '2026-09-27T01:00:00'
    })
  })

  it('读取原文：先拉取到缓存再按本地同款解析器取文本；二次读取命中缓存', async () => {
    const h = createHarness()
    mockDocDetail(h)
    mockDownload(h, '# 标题\n正文')

    const first = await h.service.readDocument('u1', 'kb-1', 'doc-1', 'text')
    expect(first.name).toBe('规范.md')
    expect(first.ext).toBe('md')
    expect(first.content).toContain('正文')
    expect(h.mock.history.post).toHaveLength(1)

    const second = await h.service.readDocument('u1', 'kb-1', 'doc-1', 'text')
    expect(second.content).toContain('正文')
    // 命中缓存：不再下载
    expect(h.mock.history.post).toHaveLength(1)
    expect(existsSync(join(h.cacheDir, 'kb-1', 'doc-1', '规范.md'))).toBe(true)
  })

  it('同一文档并发读取只下载一次', async () => {
    const h = createHarness()
    mockDocDetail(h)
    mockDownload(h, 'body')

    await Promise.all([
      h.service.readDocument('u1', 'kb-1', 'doc-1', 'text'),
      h.service.readDocument('u1', 'kb-1', 'doc-1', 'text'),
      h.service.readDocument('u1', 'kb-1', 'doc-1', 'bytes')
    ])

    expect(h.mock.history.post).toHaveLength(1)
  })

  it('服务端给的文件名带路径穿越时被净化', async () => {
    const h = createHarness()
    mockDocDetail(h, '../../evil.md')
    mockDownload(h, 'x')

    const result = await h.service.readDocument('u1', 'kb-1', 'doc-1', 'text')

    expect(result.name).not.toContain('..')
    expect(result.name).not.toContain('/')
    // 文件仍落在该文档自己的缓存目录内
    expect(existsSync(join(h.cacheDir, 'kb-1', 'doc-1', 'evil.md'))).toBe(true)
  })

  it('另存为把缓存原文拷到目标路径', async () => {
    const h = createHarness()
    mockDocDetail(h)
    mockDownload(h, 'saved-body')
    const target = join(h.cacheDir, 'saved-copy.md')

    await h.service.saveDocumentAs('u1', 'kb-1', 'doc-1', target)

    expect(existsSync(target)).toBe(true)
  })
})
