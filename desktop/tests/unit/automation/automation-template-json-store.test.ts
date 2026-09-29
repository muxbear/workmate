import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomationTemplateJsonStore } from '../../../src/main/automation/AutomationTemplateJsonStore'
import type { AutomationSchedule, DesktopAutomationTemplate } from '../../../src/preload/index.d'

function createBaseDir(): string {
  return mkdtempSync(join(tmpdir(), 'kw-template-store-'))
}

const SCHEDULE: AutomationSchedule = {
  freqGroup: 'cycle',
  cycleKind: 'daily',
  intervalKind: 'hourly',
  onceDate: '',
  onceTime: '08:00',
  weekDays: [1],
  monthDay: 1,
  yearMonth: 1,
  yearDay: 1,
  weekIntervalDays: [1],
  hourInterval: 2,
  validityMode: 'forever',
  validFrom: '',
  validFromTime: '00:00',
  validTo: '',
  validToTime: '23:59'
}

function makeTemplate(id = 't1'): DesktopAutomationTemplate {
  return {
    id,
    name: `模板${id}`,
    description: '描述',
    icon: '⏰',
    category: 'work',
    version: '1.0.0',
    promptText: '提示词',
    promptParts: [{ type: 'text', text: '提示词' }],
    schedule: SCHEDULE,
    freqSummary: '每天 08:00',
    validitySummary: '长期有效',
    model: null,
    customModelId: null,
    expertId: null,
    expertName: null,
    contextMode: 'default',
    skillIds: [],
    workspaceId: null,
    workspaceName: null,
    fullAccess: false,
    providerId: null,
    modelId: null,
    kbIds: [],
    allowNetwork: false,
    allowShell: false,
    createdAt: 1,
    updatedAt: 2
  }
}

describe('AutomationTemplateJsonStore', () => {
  let baseDir: string
  let store: AutomationTemplateJsonStore

  beforeEach(() => {
    baseDir = createBaseDir()
    store = new AutomationTemplateJsonStore(baseDir)
  })

  it('ATJS-01: 缺失文件返回 null', async () => {
    await expect(store.read()).resolves.toBeNull()
  })

  it('ATJS-02: 写入后可按 { version, syncedAt, syncedBy, templates } 读回', async () => {
    const templates = [makeTemplate('t1'), makeTemplate('t2')]
    await store.write({
      version: 1,
      syncedAt: 1757068800000,
      syncedBy: { webUserId: 'u1', nickname: 'demo' },
      templates
    })

    const raw = JSON.parse(readFileSync(join(baseDir, 'templates.json'), 'utf-8')) as Record<
      string,
      unknown
    >
    expect(raw.version).toBe(1)
    expect(raw.syncedAt).toBe(1757068800000)
    expect(raw.syncedBy).toEqual({ webUserId: 'u1', nickname: 'demo' })
    expect(Array.isArray(raw.templates)).toBe(true)

    const data = await store.read()
    expect(data).not.toBeNull()
    expect(data?.templates).toHaveLength(2)
    expect(data?.templates[0]?.id).toBe('t1')
  })

  it('ATJS-03: JSON 损坏时返回 null 且不删除旧文件', async () => {
    const file = join(baseDir, 'templates.json')
    writeFileSync(file, '{ broken json', 'utf-8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(store.read()).resolves.toBeNull()
    expect(existsSync(file)).toBe(true)
    warn.mockRestore()
  })

  it('ATJS-04: 版本/结构不匹配时返回 null', async () => {
    const file = join(baseDir, 'templates.json')
    writeFileSync(file, JSON.stringify({ version: 99, syncedAt: 1, templates: [] }), 'utf-8')
    await expect(store.read()).resolves.toBeNull()

    // 结构校验：条目必须带 id / name
    writeFileSync(
      file,
      JSON.stringify({ version: 1, syncedAt: 1, templates: [{ id: 'x' }] }),
      'utf-8'
    )
    await expect(store.read()).resolves.toBeNull()
  })

  it('ATJS-05: 新实例重建后仍可读（持久化）', async () => {
    await store.write({
      version: 1,
      syncedAt: 123,
      syncedBy: null,
      templates: [makeTemplate('t1')]
    })
    const reloaded = new AutomationTemplateJsonStore(baseDir)
    const data = await reloaded.read()
    expect(data?.templates[0]?.id).toBe('t1')
    expect(data?.syncedAt).toBe(123)
  })
})
