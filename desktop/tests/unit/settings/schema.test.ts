import { describe, expect, it } from 'vitest'
import {
  defaultSettings,
  flattenSettings,
  isSettingsKey,
  isValidSettingsValue,
  normalizeSettings,
  SETTINGS_SCHEMA,
  SETTINGS_VERSION,
  unflattenSettings
} from '../../../src/main/settings/schema'

describe('settings schema', () => {
  it('白名单 key（嵌套路径）', () => {
    expect(isSettingsKey('ui.language')).toBe(true)
    expect(isSettingsKey('network.proxyMode')).toBe(true)
    expect(isSettingsKey('notification.sound')).toBe(true)
    expect(isSettingsKey('bogus')).toBe(false)
    expect(isSettingsKey('ui')).toBe(false)
  })

  it('35 项配置全部在 schema 内且类型/默认值合法', () => {
    expect(Object.keys(SETTINGS_SCHEMA)).toHaveLength(35)
    for (const [key, entry] of Object.entries(SETTINGS_SCHEMA)) {
      expect(isSettingsKey(key)).toBe(true)
      expect(['string', 'number', 'boolean']).toContain(entry.type)
      expect(typeof entry.default).toBe(entry.type)
      expect(['instant', 'pending']).toContain(entry.applyTiming)
    }
  })

  it('默认值为全默认（VS Code 默认值合并权威）', () => {
    const d = defaultSettings()
    expect(d['ui.language']).toBe('zh-CN')
    expect(d['ui.fontSize']).toBe(17)
    expect(d['ui.theme']).toBe('light')
    expect(d['ui.systemName']).toBe('Ke-Work')
    expect(d['ui.brandLogo']).toBe('')
    expect(d['skills.autoUpdate']).toBe(true)
    expect(d['skills.safeInstall']).toBe(false)
    expect(d['lockScreen.remoteLock']).toBe(false)
    expect(d['network.proxyMode']).toBe('direct')
    expect(d['network.proxyUrl']).toBe('')
    expect(d['workspace.defaultWorkspaceDir']).toBe('')
    expect(d['notification.clientNotifications']).toBe(true)
    expect(d['notification.sound']).toBe('none')
  })

  it('知识库配置默认值与 Figma 设置页一致', () => {
    const d = defaultSettings()
    expect(d['knowledge.directory']).toBe('')
    expect(d['knowledge.maxUploadSize']).toBe(100)
    expect(d['knowledge.uploadTimeout']).toBe(10)
    expect(d['knowledge.maxFilesPerBatch']).toBe(20)
    expect(d['knowledge.chunkStrategy']).toBe('semantic')
    expect(d['knowledge.chunkSize']).toBe(800)
    expect(d['knowledge.chunkOverlap']).toBe(120)
    expect(d['knowledge.vectorDimensions']).toBe(1024)
    expect(d['knowledge.embeddingModel']).toBe('text-embedding-3-large')
    expect(d['knowledge.sparseRetrieval']).toBe(true)
    expect(d['knowledge.bm25K1']).toBe(1.5)
    expect(d['knowledge.bm25B']).toBe(0.75)
    expect(d['knowledge.hybridWeight']).toBe(0.65)
    expect(d['knowledge.rerankEnabled']).toBe(true)
    expect(d['knowledge.rerankModel']).toBe('bge-reranker-v2-m3')
    expect(d['knowledge.topK']).toBe(12)
    expect(d['knowledge.graphEnabled']).toBe(false)
    expect(d['knowledge.graphModel']).toBe('GLM-5')
  })

  it('知识库配置 validate 拒绝越界/非法枚举', () => {
    expect(isValidSettingsValue('knowledge.directory', '')).toBe(true)
    expect(isValidSettingsValue('knowledge.directory', 'C:\\KeWork\\kb')).toBe(true)
    expect(isValidSettingsValue('knowledge.directory', 'relative/path')).toBe(false)
    expect(isValidSettingsValue('knowledge.maxUploadSize', 0)).toBe(false)
    expect(isValidSettingsValue('knowledge.maxUploadSize', 100)).toBe(true)
    expect(isValidSettingsValue('knowledge.uploadTimeout', 0)).toBe(false)
    expect(isValidSettingsValue('knowledge.chunkStrategy', 'bogus')).toBe(false)
    expect(isValidSettingsValue('knowledge.chunkStrategy', 'markdown')).toBe(true)
    expect(isValidSettingsValue('knowledge.chunkSize', 50)).toBe(false)
    expect(isValidSettingsValue('knowledge.chunkOverlap', 0)).toBe(true)
    expect(isValidSettingsValue('knowledge.vectorDimensions', 2048)).toBe(false)
    expect(isValidSettingsValue('knowledge.vectorDimensions', 1536)).toBe(true)
    expect(isValidSettingsValue('knowledge.bm25B', 1.5)).toBe(false)
    expect(isValidSettingsValue('knowledge.hybridWeight', 0.65)).toBe(true)
    expect(isValidSettingsValue('knowledge.topK', 0)).toBe(false)
    expect(isValidSettingsValue('knowledge.topK', 101)).toBe(false)
    expect(isValidSettingsValue('knowledge.embeddingModel', '  ')).toBe(false)
    expect(isValidSettingsValue('knowledge.graphEnabled', true)).toBe(true)
  })

  it('validate 拒绝非法枚举/区间/格式', () => {
    expect(isValidSettingsValue('ui.language', 'fr-FR')).toBe(false)
    expect(isValidSettingsValue('ui.language', 'zh-CN')).toBe(true)
    expect(isValidSettingsValue('ui.fontSize', 8)).toBe(false)
    expect(isValidSettingsValue('ui.fontSize', 17)).toBe(true)
    expect(isValidSettingsValue('ui.theme', 'sepia')).toBe(false)
    expect(isValidSettingsValue('ui.theme', 'dark')).toBe(true)
    expect(isValidSettingsValue('ui.theme', 'light')).toBe(true)
    expect(isValidSettingsValue('network.proxyMode', 'bogus')).toBe(false)
    expect(isValidSettingsValue('network.proxyUrl', 'not-a-url')).toBe(false)
    expect(isValidSettingsValue('network.proxyUrl', 'http://127.0.0.1:7890')).toBe(true)
    expect(isValidSettingsValue('network.proxyUrl', '')).toBe(true)
    expect(isValidSettingsValue('workspace.defaultWorkspaceDir', 'relative/path')).toBe(false)
    expect(isValidSettingsValue('workspace.defaultWorkspaceDir', 'C:\\KeWork')).toBe(true)
    expect(isValidSettingsValue('notification.sound', 'loud')).toBe(false)
    expect(isValidSettingsValue('skills.autoUpdate', 'yes')).toBe(false)
    expect(isValidSettingsValue('skills.autoUpdate', true)).toBe(true)
  })

  it('validate：系统名称 trim 后非空且不超过上限，品牌 LOGO 仅接受受控文件名', () => {
    expect(isValidSettingsValue('ui.systemName', 'Ke-Work')).toBe(true)
    expect(isValidSettingsValue('ui.systemName', '  ')).toBe(false)
    expect(isValidSettingsValue('ui.systemName', '')).toBe(false)
    expect(isValidSettingsValue('ui.systemName', 'a'.repeat(24))).toBe(true)
    expect(isValidSettingsValue('ui.systemName', 'a'.repeat(25))).toBe(false)
    expect(isValidSettingsValue('ui.systemName', '换\n行')).toBe(false)
    // 品牌 LOGO：空串 = 使用内置默认；非空必须是 branding 目录内的受控文件名
    expect(isValidSettingsValue('ui.brandLogo', '')).toBe(true)
    expect(isValidSettingsValue('ui.brandLogo', 'logo-1700000000000.png')).toBe(true)
    expect(isValidSettingsValue('ui.brandLogo', 'logo-1700000000000.svg')).toBe(true)
    expect(isValidSettingsValue('ui.brandLogo', 'logo-1700000000000.gif')).toBe(false)
    expect(isValidSettingsValue('ui.brandLogo', '../../settings.json')).toBe(false)
    expect(isValidSettingsValue('ui.brandLogo', 'C:\\abs\\logo-1.png')).toBe(false)
  })

  it('normalizeSettings：空输入 = 全默认（默认值合并）', () => {
    const out = normalizeSettings({})
    expect(out).toEqual(defaultSettings())
  })

  it('normalizeSettings：嵌套对象输入拍平并保留合法值', () => {
    const out = normalizeSettings({ ui: { language: 'en', fontSize: 20, theme: 'dark' } })
    expect(out['ui.language']).toBe('en')
    expect(out['ui.fontSize']).toBe(20)
    expect(out['ui.theme']).toBe('dark')
    expect(out['network.proxyMode']).toBe('direct') // 未提供项回默认
  })

  it('normalizeSettings：非法值静默回退默认', () => {
    const out = normalizeSettings({ ui: { language: 'fr-FR' }, notification: { sound: 'loud' } })
    expect(out['ui.language']).toBe('zh-CN')
    expect(out['notification.sound']).toBe('none')
  })

  it('flatten/unflatten 互逆（嵌套域 ↔ 扁平 key）', () => {
    const nested = { ui: { language: 'zh-CN', fontSize: 17 }, network: { proxyMode: 'direct' } }
    const flat = flattenSettings(nested)
    expect(flat['ui.language']).toBe('zh-CN')
    expect(flat['ui.fontSize']).toBe(17)
    expect(flat['network.proxyMode']).toBe('direct')
    expect(unflattenSettings(flat)).toEqual(nested)
  })

  it('SETTINGS_VERSION 当前为 1', () => {
    expect(SETTINGS_VERSION).toBe(1)
  })
})
