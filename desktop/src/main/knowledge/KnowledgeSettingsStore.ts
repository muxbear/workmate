import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  assertKbId,
  normalizeKnowledgeOverrides,
  type KnowledgeOverrides
} from './knowledge-schema'

const FILE_NAME = 'kb-settings.json'
const FILE_VERSION = 1

/** 磁盘结构：userId → kbId → 稀疏覆盖项（未覆盖的项不出现） */
interface KnowledgeSettingsFile {
  version: number
  users: Record<string, Record<string, KnowledgeOverrides>>
}

/**
 * 知识库「按库覆盖」配置存储（~/.ke-work/knowledge/kb-settings.json）
 *
 * 为什么不复用 SettingsStore：它的 persist() 写的是「全部 key 的展开」，
 * 盘上永远有全部设置项，无法表达「省略 = 跟随全局」；这里必须是**稀疏**存储。
 *
 * - 写入：① 旧文件复制为 .bak ② 临时文件原子写 ③ rename 替换
 * - 损坏恢复：JSON 解析失败优先从 .bak 恢复；均失败保留为 .corrupt 并回退空
 * - 高版本文件（version > FILE_VERSION）忽略内容但不破坏，避免降级写坏
 * - 运行期主进程内存快照为权威；外部编辑需重启生效
 */
export class KnowledgeSettingsStore {
  private data: KnowledgeSettingsFile
  private readonly filePath: string

  constructor(dir: string) {
    this.filePath = join(dir, FILE_NAME)
    mkdirSync(dir, { recursive: true })
    this.data = { version: FILE_VERSION, users: {} }
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return // 缺失 → 全空，首次写入才落盘
      this.data = this.parse(readFileSync(this.filePath, 'utf-8'))
    } catch (err) {
      console.warn('[knowledge-settings] failed to load kb-settings.json, trying .bak:', err)
      if (this.tryRestoreFromBak()) return
      // .bak 也不可用 → 损坏文件保留为 .corrupt（VS Code 排查惯例），回退空
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt`)
      } catch (renameErr) {
        console.warn('[knowledge-settings] failed to preserve corrupt file:', renameErr)
      }
      this.data = { version: FILE_VERSION, users: {} }
    }
  }

  /** 解析文件内容为内存结构（可能抛错，不做 IO 兜底）；非法项静默丢弃 */
  private parse(content: string): KnowledgeSettingsFile {
    const raw = JSON.parse(content) as Record<string, unknown>
    const out: KnowledgeSettingsFile = { version: FILE_VERSION, users: {} }
    if (raw === null || typeof raw !== 'object') return out
    // 高版本文件结构未知 → 忽略内容但不写盘，避免降级破坏
    const rawVersion = raw['version']
    if (typeof rawVersion === 'number' && rawVersion > FILE_VERSION) {
      console.warn(
        `[knowledge-settings] file version ${rawVersion} > supported ${FILE_VERSION}, ignore file`
      )
      return out
    }
    const users = (raw['users'] ?? {}) as Record<string, unknown>
    if (users === null || typeof users !== 'object' || Array.isArray(users)) return out
    for (const userId of Object.keys(users)) {
      // 只接受合法 id，顺带挡掉 __proto__ 这类会改写原型的键
      const safeUserId = this.tryNormalizeId(userId)
      if (!safeUserId) continue
      const kbMap = users[userId] as Record<string, unknown>
      if (kbMap === null || typeof kbMap !== 'object' || Array.isArray(kbMap)) continue
      const normalized: Record<string, KnowledgeOverrides> = {}
      for (const kbId of Object.keys(kbMap)) {
        const safeKbId = this.tryNormalizeId(kbId)
        if (!safeKbId) continue
        const overrides = normalizeKnowledgeOverrides(kbMap[kbId])
        if (Object.keys(overrides).length === 0) continue // 空覆盖不留痕迹
        normalized[safeKbId] = overrides
      }
      if (Object.keys(normalized).length > 0) out.users[safeUserId] = normalized
    }
    return out
  }

  /** 从 .bak 恢复（不覆盖 .bak 本身）；成功返回 true */
  private tryRestoreFromBak(): boolean {
    const bakPath = `${this.filePath}.bak`
    if (!existsSync(bakPath)) return false
    try {
      const restored = this.parse(readFileSync(bakPath, 'utf-8'))
      // 备份为空时视为恢复失败：保留 .corrupt 更利于排查
      if (Object.keys(restored.users).length === 0) return false
      this.data = restored
      this.writeFile() // 不轮转 .bak，避免把损坏文件盖掉最后一份好备份
      console.warn('[knowledge-settings] restored kb-settings from .bak')
      return true
    } catch (bakErr) {
      console.warn('[knowledge-settings] .bak also corrupted:', bakErr)
      return false
    }
  }

  /** 临时文件 + rename 原子替换（UTF-8 无 BOM） */
  private writeFile(): void {
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8')
    renameSync(tmp, this.filePath)
  }

  /** 写入：.bak 备份 → 原子替换 */
  private persist(): void {
    if (existsSync(this.filePath)) {
      copyFileSync(this.filePath, `${this.filePath}.bak`)
    }
    this.writeFile()
  }

  /** 非法 id 返回 null（宽松读取用；写入路径直接抛错） */
  private tryNormalizeId(raw: string): string | null {
    try {
      return assertKbId(raw)
    } catch {
      return null
    }
  }

  /** 测试用：当前文件路径 */
  getFilePath(): string {
    return this.filePath
  }

  /** 某用户的 kbId → 覆盖项（外层浅拷贝，调用方改不到内部快照） */
  getUserKbMap(userId: string): Record<string, KnowledgeOverrides> {
    const user = this.data.users[assertKbId(userId)]
    if (!user) return {}
    const out: Record<string, KnowledgeOverrides> = {}
    for (const kbId of Object.keys(user)) {
      out[kbId] = { ...user[kbId] }
    }
    return out
  }

  /**
   * 覆盖某用户的整份映射；空 map（或全部覆盖项为空）时删除该用户节点，不留空对象。
   * 保持「省略 = 跟随全局」的稀疏不变量：空覆盖项不落盘。
   */
  setUserKbMap(userId: string, kbMap: Record<string, KnowledgeOverrides>): void {
    const safeUserId = assertKbId(userId)
    const normalized: Record<string, KnowledgeOverrides> = {}
    for (const [kbId, overrides] of Object.entries(kbMap)) {
      const safeKbId = assertKbId(kbId)
      if (Object.keys(overrides).length === 0) continue
      normalized[safeKbId] = { ...overrides }
    }
    if (Object.keys(normalized).length === 0) {
      delete this.data.users[safeUserId]
    } else {
      this.data.users[safeUserId] = normalized
    }
    this.persist()
  }
}
