import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExpertJsonStore } from '../../../src/main/experts/ExpertJsonStore'
import type { DesktopExpert } from '../../../src/preload/index.d'

function createBaseDir(): string {
  return mkdtempSync(join(tmpdir(), 'kw-expert-store-'))
}

function makeExpert(id = 'e1'): DesktopExpert {
  return {
    id,
    name: `专家${id}`,
    title: `标题${id}`,
    tags: [],
    desc: '描述',
    color: 'linear-gradient(135deg,#0891b2,#0e7490)',
    icon: 'Zap',
    category: 'custom',
    rating: 4.8,
    users: '1k',
    initials: '专',
    systemPrompt: '',
    tools: [],
    providerId: null,
    modelId: null,
    modelName: null,
    modelType: null,
    skills: [],
    mcpConfigs: [],
    promptTemplate: '',
    expertiseAreas: [],
    isExpert: true
  }
}

describe('ExpertJsonStore', () => {
  let baseDir: string
  let store: ExpertJsonStore

  beforeEach(() => {
    baseDir = createBaseDir()
    store = new ExpertJsonStore(baseDir)
  })

  it('EJS-01: 缺失文件返回 null', async () => {
    await expect(store.read()).resolves.toBeNull()
  })

  it('EJS-02: 写入后可按 { version, syncedAt, syncedBy, experts } 读回', async () => {
    const experts = [makeExpert('e1'), makeExpert('e2')]
    await store.write({
      version: 1,
      syncedAt: 1757068800000,
      syncedBy: { webUserId: 'u1', nickname: 'demo' },
      experts
    })

    const raw = JSON.parse(readFileSync(join(baseDir, 'experts.json'), 'utf-8')) as Record<
      string,
      unknown
    >
    expect(raw.version).toBe(1)
    expect(raw.syncedAt).toBe(1757068800000)
    expect(raw.syncedBy).toEqual({ webUserId: 'u1', nickname: 'demo' })
    expect(Array.isArray(raw.experts)).toBe(true)

    const data = await store.read()
    expect(data).not.toBeNull()
    expect(data?.experts).toHaveLength(2)
    expect(data?.experts[0]?.id).toBe('e1')
  })

  it('EJS-03: JSON 损坏时返回 null 且不删除旧文件', async () => {
    const file = join(baseDir, 'experts.json')
    writeFileSync(file, '{ broken json', 'utf-8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(store.read()).resolves.toBeNull()
    expect(existsSync(file)).toBe(true)
    warn.mockRestore()
  })

  it('EJS-04: 版本/结构不匹配时返回 null', async () => {
    const file = join(baseDir, 'experts.json')
    writeFileSync(file, JSON.stringify({ version: 99, syncedAt: 1, experts: [] }), 'utf-8')
    await expect(store.read()).resolves.toBeNull()

    writeFileSync(
      file,
      JSON.stringify({ version: 1, syncedAt: 1, experts: [{ id: 'x' }] }),
      'utf-8'
    )
    await expect(store.read()).resolves.toBeNull()
  })

  it('EJS-05: 新实例重建后仍可读（持久化）', async () => {
    await store.write({ version: 1, syncedAt: 123, syncedBy: null, experts: [makeExpert('e1')] })
    const reloaded = new ExpertJsonStore(baseDir)
    const data = await reloaded.read()
    expect(data?.experts[0]?.id).toBe('e1')
    expect(data?.syncedAt).toBe(123)
  })
})
