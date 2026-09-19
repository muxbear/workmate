import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillJsonStore } from '../../../src/main/skills/SkillJsonStore'
import type { DesktopSkill } from '../../../src/preload/index.d'

function createBaseDir(): string {
  return mkdtempSync(join(tmpdir(), 'kw-skill-store-'))
}

function makeSkill(id = 's1'): DesktopSkill {
  return {
    id,
    name: `技能${id}`,
    desc: '描述',
    category: 'custom',
    icon: 'Zap',
    color: 'linear-gradient(135deg,#0891b2,#0e7490)',
    enabled: true,
    isBuiltin: false,
    source: 'local',
    dirName: `skill-${id}`,
    files: [],
    runtime: null,
    installed: false,
    installedAt: null
  }
}

describe('SkillJsonStore', () => {
  let baseDir: string
  let store: SkillJsonStore

  beforeEach(() => {
    baseDir = createBaseDir()
    store = new SkillJsonStore(baseDir)
  })

  it('SJS-01: 缺失文件返回 null', async () => {
    await expect(store.read()).resolves.toBeNull()
  })

  it('SJS-02: 写入后可按 { version, syncedAt, syncedBy, skills } 读回', async () => {
    await store.write({
      version: 1,
      syncedAt: 1757068800000,
      syncedBy: { webUserId: 'u1', nickname: 'demo' },
      skills: [makeSkill('s1'), makeSkill('s2')]
    })

    const raw = JSON.parse(readFileSync(join(baseDir, 'skills.json'), 'utf-8')) as Record<
      string,
      unknown
    >
    expect(raw.version).toBe(1)
    expect(raw.syncedAt).toBe(1757068800000)
    expect(raw.syncedBy).toEqual({ webUserId: 'u1', nickname: 'demo' })
    expect(Array.isArray(raw.skills)).toBe(true)

    const data = await store.read()
    expect(data?.skills).toHaveLength(2)
    expect(data?.skills[0]?.id).toBe('s1')
  })

  it('SJS-03: JSON 损坏时返回 null 且不删除旧文件', async () => {
    const file = join(baseDir, 'skills.json')
    writeFileSync(file, '{ broken json', 'utf-8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(store.read()).resolves.toBeNull()
    expect(existsSync(file)).toBe(true)
    warn.mockRestore()
  })

  it('SJS-04: 版本/结构不匹配时返回 null', async () => {
    const file = join(baseDir, 'skills.json')
    writeFileSync(file, JSON.stringify({ version: 99, syncedAt: 1, skills: [] }), 'utf-8')
    await expect(store.read()).resolves.toBeNull()

    writeFileSync(file, JSON.stringify({ version: 1, syncedAt: 1, skills: [{ id: 'x' }] }), 'utf-8')
    await expect(store.read()).resolves.toBeNull()
  })

  it('SJS-05: 新实例重建后仍可读（持久化）', async () => {
    await store.write({ version: 1, syncedAt: 123, syncedBy: null, skills: [makeSkill('s1')] })
    const reloaded = new SkillJsonStore(baseDir)
    const data = await reloaded.read()
    expect(data?.skills[0]?.id).toBe('s1')
    expect(data?.syncedAt).toBe(123)
    expect(reloaded.getSkillsDir()).toBe(baseDir)
  })
})
