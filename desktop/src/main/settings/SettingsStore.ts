import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { EventEmitter } from 'events'
import {
  defaultSettings,
  flattenSettings,
  isSettingsKey,
  isValidSettingsValue,
  normalizeSettings,
  SECRET_SETTINGS_KEYS,
  SETTINGS_VERSION,
  unflattenSettings,
  type SettingsKey
} from './schema'
import type { ISecureStorage } from '../security/secure-storage'

const SETTINGS_FILE = 'settings.json'

/**
 * 系统设置存储（对齐 WorkModeStore 模式 + WorkBuddy 实测规范）
 *
 * - 存储位置：~/.ke-work/settings.json（基础目录顶层，对齐 ~/.workbuddy/settings.json）
 * - 磁盘格式：嵌套功能域对象 + 顶层 version 字段（对齐 WorkBuddy workspace-state.json）
 * - 写入：① 旧文件复制为 .bak（对齐 memory.md.bak 实测）② 临时文件原子写 ③ rename 替换
 * - 损坏恢复：JSON 解析失败优先从 .bak 恢复；均失败回退默认并保留损坏文件为 .corrupt
 * - 非法值回退默认并修复回写（对齐 WorkModeStore.load fallback persist）
 * - 运行期主进程内存快照为权威，文件为持久化权威；外部编辑需重启生效
 */
export class SettingsStore {
  private settings: Record<SettingsKey, unknown>
  private readonly filePath: string
  private readonly emitter = new EventEmitter()

  constructor(
    baseDir: string,
    /** 安全存储（提供后，SECRET_SETTINGS_KEYS 的值只写它、不落 settings.json；缺省保持旧行为） */
    private readonly secretStore?: ISecureStorage
  ) {
    this.filePath = join(baseDir, SETTINGS_FILE)
    mkdirSync(baseDir, { recursive: true })
    this.settings = defaultSettings()
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) {
        // 缺失 → 全默认（安全键取安全存储），首次 set 才落盘
        this.overlaySecretsFromStore()
        return
      }
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Record<string, unknown>
      // version 检查：文件来自更新版本应用（结构未知）→ 回退默认，不写盘避免破坏高版本数据
      const rawVersion = raw && typeof raw === 'object' ? raw['version'] : undefined
      if (typeof rawVersion === 'number' && rawVersion > SETTINGS_VERSION) {
        console.warn(`[settings] file version ${rawVersion} > supported ${SETTINGS_VERSION}, fallback to defaults`)
        return
      }
      // 旧格式迁移：历史版本明文密钥 → 安全存储（返回是否发生迁移，需要重写文件）
      const migratedSecrets = this.migrateSecretsFromFile(raw)
      this.settings = normalizeSettings(raw)
      // 安全键以安全存储为权威覆盖内存快照（磁盘不落明文）
      this.overlaySecretsFromStore()
      // 修复回写：文件内值存在非法/缺失（normalize 已回退默认）时重写；
      // 安全键不参与比对（磁盘侧不落明文，一致性由迁移/写入路径保证）
      const normalized = this.stripSecretsForDisk(unflattenSettings(this.settings))
      const stored = this.stripSecretsForDisk({ ...raw })
      delete stored['version']
      if (JSON.stringify(normalized) !== JSON.stringify(stored)) {
        console.warn('[settings] invalid values detected, repairing settings.json')
        this.persist()
      } else if (migratedSecrets) {
        // 明文迁移完成：重写主文件（跳过备份，避免把明文复制进 .bak）
        this.persist(true)
      }
      // 清洗历史 .bak 中可能残留的明文密钥（升级前版本留下的备份）
      if (this.secretStore) this.scrubSecretsFromBak()
    } catch (err) {
      console.warn('[settings] failed to load settings.json, trying .bak:', err)
      if (this.tryRestoreFromBak()) return
      // .bak 也不可用 → 损坏文件保留为 .corrupt（VS Code 排查惯例），回退默认
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt`)
      } catch (renameErr) {
        console.warn('[settings] failed to preserve corrupt file:', renameErr)
      }
      this.settings = defaultSettings()
    }
  }

  /** 从 .bak 恢复（对齐 WorkBuddy 备份思路）；成功返回 true */
  private tryRestoreFromBak(): boolean {
    const bakPath = `${this.filePath}.bak`
    if (!existsSync(bakPath)) return false
    try {
      const raw = JSON.parse(readFileSync(bakPath, 'utf-8')) as Record<string, unknown>
      this.migrateSecretsFromFile(raw)
      this.settings = normalizeSettings(raw)
      this.overlaySecretsFromStore()
      console.warn('[settings] restored settings from .bak')
      this.persist()
      return true
    } catch (bakErr) {
      console.warn('[settings] .bak also corrupted:', bakErr)
      return false
    }
  }

  /** 写入：.bak 备份 → 临时文件 → 原子替换（UTF-8 无 BOM）；安全键不落盘；skipBackup 用于密钥迁移场景（避免明文进备份） */
  private persist(skipBackup = false): void {
    if (!skipBackup && existsSync(this.filePath)) {
      copyFileSync(this.filePath, `${this.filePath}.bak`)
    }
    const tmp = `${this.filePath}.tmp`
    const payload = this.stripSecretsForDisk(unflattenSettings(this.settings))
    const data = { version: SETTINGS_VERSION, ...payload }
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    renameSync(tmp, this.filePath)
  }

  get<K extends SettingsKey>(key: K): unknown {
    return this.settings[key]
  }

  getAll(): Record<SettingsKey, unknown> {
    return { ...this.settings }
  }

  /**
   * 校验并写入（白名单 + 类型 + 枚举/格式/区间校验，主进程为校验权威）。
   * 非法值抛错（由 IPC handler 转为 { success: false }），不静默。
   */
  set(key: SettingsKey, value: unknown): void {
    if (!isSettingsKey(key)) throw new Error(`[settings] unknown key: ${String(key)}`)
    if (!isValidSettingsValue(key, value)) {
      throw new Error(`[settings] invalid value for ${key}: ${JSON.stringify(value)}`)
    }
    this.settings[key] = value
    // 安全键路由到安全存储（置空值等价于删除；settings.json 不落明文）
    if (this.secretStore && SECRET_SETTINGS_KEYS.includes(key)) {
      const text = typeof value === 'string' ? value : String(value ?? '')
      if (text) this.secretStore.set(key, text)
      else this.secretStore.delete(key)
    }
    this.persist()
    this.emitter.emit('settings:changed', key, value)
  }

  /**
   * 旧格式迁移：历史版本把 embedding/rerank API key 明文写进 settings.json，
   * 检测到明文时搬入安全存储并从磁盘载荷中移除；返回是否发生迁移（需要重写文件）。
   * 安全存储已有值时以安全存储为准（不覆盖，仅清掉文件里的明文）。
   */
  private migrateSecretsFromFile(raw: Record<string, unknown>): boolean {
    if (!this.secretStore) return false
    let migrated = false
    for (const key of SECRET_SETTINGS_KEYS) {
      const value = readNestedValue(raw, key)
      if (typeof value !== 'string' || value === '') continue
      if (this.secretStore.get(key) === null) this.secretStore.set(key, value)
      deleteNestedValue(raw, key)
      migrated = true
      console.warn(`[settings] 检测到明文密钥 ${key}，已迁移至安全存储`)
    }
    return migrated
  }

  /** 安全键以安全存储为权威覆盖内存快照（磁盘只存空值/无此键） */
  private overlaySecretsFromStore(): void {
    if (!this.secretStore) return
    for (const key of SECRET_SETTINGS_KEYS) {
      const value = this.secretStore.get(key)
      if (value !== null) this.settings[key] = value
    }
  }

  /** 磁盘载荷剔除安全键（值只存安全存储）；未接安全存储时保持旧行为（原样落盘） */
  private stripSecretsForDisk(payload: Record<string, unknown>): Record<string, unknown> {
    if (!this.secretStore) return payload
    for (const key of SECRET_SETTINGS_KEYS) deleteNestedValue(payload, key)
    return payload
  }

  /** 清洗历史 .bak 中残留的明文密钥（旧版本写入的备份；.bak 不可读时跳过） */
  private scrubSecretsFromBak(): void {
    const bakPath = `${this.filePath}.bak`
    if (!existsSync(bakPath)) return
    try {
      const raw = JSON.parse(readFileSync(bakPath, 'utf-8')) as Record<string, unknown>
      let scrubbed = false
      for (const key of SECRET_SETTINGS_KEYS) {
        const value = readNestedValue(raw, key)
        if (typeof value === 'string' && value !== '') {
          deleteNestedValue(raw, key)
          scrubbed = true
        }
      }
      if (scrubbed) {
        writeFileSync(bakPath, JSON.stringify(raw, null, 2), 'utf-8')
        console.warn('[settings] 已清洗 .bak 中的明文密钥残留')
      }
    } catch {
      // .bak 不可读：跳过清洗
    }
  }

  onChanged(listener: (key: SettingsKey, value: unknown) => void): () => void {
    this.emitter.on('settings:changed', listener)
    return () => this.emitter.off('settings:changed', listener)
  }

  /** 测试用：当前文件路径 */
  getFilePath(): string {
    return this.filePath
  }
}

/** 读取磁盘嵌套对象中的扁平 key（'knowledge.embeddingApiKey' → raw.knowledge.embeddingApiKey） */
function readNestedValue(payload: Record<string, unknown>, flatKey: string): unknown {
  let node: unknown = payload
  for (const part of flatKey.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node
}

/** 从磁盘嵌套对象中删除扁平 key（路径不存在时静默返回） */
function deleteNestedValue(payload: Record<string, unknown>, flatKey: string): void {
  const parts = flatKey.split('.')
  let node: Record<string, unknown> = payload
  for (let i = 0; i < parts.length - 1; i++) {
    const next = node[parts[i]]
    if (typeof next !== 'object' || next === null) return
    node = next as Record<string, unknown>
  }
  delete node[parts[parts.length - 1]]
}

export { flattenSettings }
