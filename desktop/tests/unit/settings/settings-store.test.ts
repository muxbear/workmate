import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SettingsStore } from '../../../src/main/settings/SettingsStore'
import { defaultSettings, SETTINGS_VERSION } from '../../../src/main/settings/schema'
import { InMemorySecureStorage } from '../../../src/main/security/secure-storage'

let baseDir: string

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'ke-settings-'))
})

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true })
})

function readSettingsFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(baseDir, 'settings.json'), 'utf-8')) as Record<string, unknown>
}

describe('SettingsStore', () => {
  it('空目录：全默认，不生成文件（首次 set 才落盘）', () => {
    const store = new SettingsStore(baseDir)
    expect(store.getAll()).toEqual(defaultSettings())
    expect(existsSync(join(baseDir, 'settings.json'))).toBe(false)
  })

  it('set 后文件存在，内容为嵌套域 + version（对齐 WorkBuddy 格式）', () => {
    const store = new SettingsStore(baseDir)
    store.set('ui.language', 'en')
    store.set('ui.fontSize', 20)
    const raw = readSettingsFile()
    expect(raw['version']).toBe(SETTINGS_VERSION)
    expect(raw['ui'] as unknown).toEqual({
      language: 'en',
      fontSize: 20,
      theme: 'light',
      systemName: 'Ke-Work',
      brandLogo: ''
    })
    expect(raw['skills'] as unknown).toEqual({ autoUpdate: true, safeInstall: false }) // 默认值也写盘
  })

  it('set 非法值抛错（主进程校验权威）', () => {
    const store = new SettingsStore(baseDir)
    expect(() => store.set('ui.language', 'fr-FR')).toThrow()
    expect(() => store.set('network.proxyMode', 'bogus')).toThrow()
    expect(() => store.set('bogus.key' as never, 1)).toThrow()
  })

  it('写入后 .bak 存在且内容为上一版本（对齐 WorkBuddy .bak 实测）', () => {
    const store = new SettingsStore(baseDir)
    store.set('ui.language', 'en')
    store.set('ui.language', 'zh-TW')
    expect(existsSync(join(baseDir, 'settings.json.bak'))).toBe(true)
    const bak = JSON.parse(readFileSync(join(baseDir, 'settings.json.bak'), 'utf-8')) as Record<
      string,
      Record<string, unknown>
    >
    expect(bak['ui']?.language).toBe('en') // 上一版本
    const current = readSettingsFile()
    expect((current['ui'] as Record<string, unknown>)?.language).toBe('zh-TW')
  })

  it('损坏文件：优先从 .bak 恢复', () => {
    const store = new SettingsStore(baseDir)
    store.set('ui.language', 'en')
    store.set('ui.fontSize', 18) // 第二次写入 → .bak 为第一次版本（language: en）
    // 损坏当前文件
    writeFileSync(join(baseDir, 'settings.json'), '{corrupted!!!', 'utf-8')
    const restored = new SettingsStore(baseDir)
    expect(restored.get('ui.language')).toBe('en') // 从 .bak 恢复
    expect(restored.get('ui.fontSize')).toBe(17) // .bak 中 fontSize 为第一次写入前的默认值
    // 恢复后当前文件已修复
    expect((readSettingsFile()['ui'] as Record<string, unknown>)?.language).toBe('en')
  })

  it('.bak 也损坏：回退默认并保留损坏文件为 .corrupt', () => {
    const store = new SettingsStore(baseDir)
    store.set('ui.language', 'en')
    writeFileSync(join(baseDir, 'settings.json'), '{bad', 'utf-8')
    writeFileSync(join(baseDir, 'settings.json.bak'), '{bad-bak', 'utf-8')
    const fallback = new SettingsStore(baseDir)
    expect(fallback.getAll()).toEqual(defaultSettings())
    expect(existsSync(join(baseDir, 'settings.json.corrupt'))).toBe(true)
  })

  it('字段级非法：回退默认并修复回写', () => {
    // 手工构造：language 非法
    writeFileSync(
      join(baseDir, 'settings.json'),
      JSON.stringify({ version: 1, ui: { language: 'fr-FR', fontSize: 17 } }),
      'utf-8'
    )
    const store = new SettingsStore(baseDir)
    expect(store.get('ui.language')).toBe('zh-CN') // 回退默认
    expect((readSettingsFile()['ui'] as Record<string, unknown>)?.language).toBe('zh-CN') // 修复回写
  })

  it('version 高于支持版本：回退默认且不写盘（避免破坏高版本数据）', () => {
    writeFileSync(
      join(baseDir, 'settings.json'),
      JSON.stringify({ version: 99, ui: { language: 'en' } }),
      'utf-8'
    )
    const store = new SettingsStore(baseDir)
    expect(store.get('ui.language')).toBe('zh-CN')
    expect(readSettingsFile()['version']).toBe(99) // 原文件未被覆盖
  })

  it('重启后回显（新实例读回持久化值）', () => {
    const store = new SettingsStore(baseDir)
    store.set('ui.language', 'zh-TW')
    store.set('ui.fontSize', 22)
    const reloaded = new SettingsStore(baseDir)
    expect(reloaded.get('ui.language')).toBe('zh-TW')
    expect(reloaded.get('ui.fontSize')).toBe(22)
  })

  it('EventEmitter 广播 settings:changed', () => {
    const store = new SettingsStore(baseDir)
    const listener = (key: string, value: unknown): void => {
      expect(key).toBe('ui.fontSize')
      expect(value).toBe(19)
    }
    store.onChanged(listener)
    store.set('ui.fontSize', 19)
  })

  it('原子写：.tmp 不残留', () => {
    const store = new SettingsStore(baseDir)
    store.set('ui.fontSize', 18)
    expect(existsSync(join(baseDir, 'settings.json.tmp'))).toBe(false)
  })
})

describe('SettingsStore · 密钥路由安全存储', () => {
  const KEY = 'knowledge.embeddingApiKey' as const

  it('接入安全存储：密钥不落 settings.json，读写与重启回显正常', () => {
    const secrets = new InMemorySecureStorage()
    const store = new SettingsStore(baseDir, secrets)
    store.set(KEY, 'sk-secret')
    expect(store.get(KEY)).toBe('sk-secret')
    expect(secrets.get(KEY)).toBe('sk-secret')
    expect(JSON.stringify(readSettingsFile())).not.toContain('sk-secret')
    // 重启（新实例 + 同一安全存储）仍可读回
    const reloaded = new SettingsStore(baseDir, secrets)
    expect(reloaded.get(KEY)).toBe('sk-secret')
  })

  it('旧格式迁移：文件中明文密钥搬入安全存储、从主文件与 .bak 移除', () => {
    writeFileSync(
      join(baseDir, 'settings.json'),
      JSON.stringify({ version: 1, knowledge: { embeddingApiKey: 'sk-plain' }, ui: { language: 'en' } }),
      'utf-8'
    )
    writeFileSync(
      join(baseDir, 'settings.json.bak'),
      JSON.stringify({ version: 1, knowledge: { embeddingApiKey: 'sk-plain-bak' } }),
      'utf-8'
    )
    const secrets = new InMemorySecureStorage()
    const store = new SettingsStore(baseDir, secrets)
    expect(store.get(KEY)).toBe('sk-plain')
    expect(secrets.get(KEY)).toBe('sk-plain')
    expect(JSON.stringify(readSettingsFile())).not.toContain('sk-plain')
    // 历史 .bak 中的明文同步清洗
    const bak = readFileSync(join(baseDir, 'settings.json.bak'), 'utf-8')
    expect(bak).not.toContain('sk-plain-bak')
  })

  it('迁移冲突：安全存储已有值时以其为准（仅清掉文件明文）', () => {
    writeFileSync(
      join(baseDir, 'settings.json'),
      JSON.stringify({ version: 1, knowledge: { embeddingApiKey: 'sk-old' } }),
      'utf-8'
    )
    const secrets = new InMemorySecureStorage()
    secrets.set(KEY, 'sk-live')
    const store = new SettingsStore(baseDir, secrets)
    expect(store.get(KEY)).toBe('sk-live')
    expect(JSON.stringify(readSettingsFile())).not.toContain('sk-old')
  })

  it('清空密钥：安全存储删除、文件不留明文', () => {
    const secrets = new InMemorySecureStorage()
    const store = new SettingsStore(baseDir, secrets)
    store.set(KEY, 'sk-secret')
    store.set(KEY, '')
    expect(secrets.get(KEY)).toBeNull()
    expect(store.get(KEY)).toBe('')
    expect(JSON.stringify(readSettingsFile())).not.toContain('sk-secret')
  })

  it('未接安全存储：保持旧行为（明文落盘，兼容测试与无安全存储环境）', () => {
    const store = new SettingsStore(baseDir)
    store.set(KEY, 'sk-legacy')
    expect(store.get(KEY)).toBe('sk-legacy')
    expect(JSON.stringify(readSettingsFile())).toContain('sk-legacy')
  })
})
