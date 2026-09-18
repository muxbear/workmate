import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'

/** 系统级安全存储接口（Windows DPAPI / macOS Keychain 的抽象） */
export interface ISecureStorage {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
}

/** Electron safeStorage 的最小抽象（便于测试注入 fake） */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** 一份密文记录 */
interface SecretRecord {
  k: string
  v: string
}

/** 损坏文件保留份数（超出后从旧到新清理） */
const MAX_CORRUPT_BACKUPS = 3

/**
 * 基于 Electron safeStorage 的实现
 *
 * 存储形态是 JSON 文件，每条记录单独加密（Base64 存密文）。
 * 解密失败时的处理原则：
 * 1. 单条记录解密失败：跳过该条，保留其余可用密钥（例如只有某个 OAuth token 失效时不牵连全部）；
 * 2. 文件整体不可读 / 全部记录解密失败：把文件改名为 secrets.bin.corrupt-<时间戳> 隔离保留（不直接删除，便于事后排查），
 *    本次以空密钥启动，用户重新登录或重新配置后会自动写入新的密钥文件。
 */
export class ElectronSafeStorage implements ISecureStorage {
  private cache: Record<string, string> | null = null
  private corruptBackupPath: string | null = null

  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStorageLike
  ) {}

  /** 最近一次隔离的损坏文件路径（诊断用） */
  getLastCorruptBackup(): string | null {
    return this.corruptBackupPath
  }

  private load(): Record<string, string> {
    if (this.cache) return this.cache
    this.cache = {}
    if (existsSync(this.filePath)) {
      let records: SecretRecord[] | null = null
      try {
        const raw = readFileSync(this.filePath, 'utf-8')
        const parsed = JSON.parse(raw) as unknown
        if (!Array.isArray(parsed)) throw new Error('invalid format')
        records = parsed as SecretRecord[]
      } catch (err) {
        console.warn('[secure-storage] secrets file is not readable, quarantining:', err)
        this.quarantineFile()
        return this.cache
      }

      let failed = 0
      for (const record of records) {
        if (!record || typeof record.k !== 'string' || typeof record.v !== 'string') continue
        try {
          this.cache[record.k] = this.safeStorage.decryptString(Buffer.from(record.v, 'base64'))
        } catch (err) {
          failed += 1
          console.warn('[secure-storage] failed to decrypt secret, skipping key:', record.k, err)
        }
      }
      // 全部记录都解不开（DPAPI 密钥轮换 / 文件来自其他账号）时按损坏处理，隔离原文件
      if (records.length > 0 && failed === records.length) {
        console.warn(
          '[secure-storage] all secrets failed to decrypt, quarantining file:',
          this.filePath
        )
        this.cache = {}
        this.quarantineFile()
      }
    }
    return this.cache
  }

  /** 把不可解密的密钥文件改名保留，避免直接销毁用户数据 */
  private quarantineFile(): void {
    const backup = this.filePath + '.corrupt-' + Date.now()
    try {
      renameSync(this.filePath, backup)
      this.corruptBackupPath = backup
      console.warn('[secure-storage] moved unreadable secrets file to:', backup)
      this.pruneCorruptBackups()
    } catch (err) {
      console.warn('[secure-storage] failed to quarantine secrets file:', err)
      try {
        unlinkSync(this.filePath)
      } catch {
        // 删除也失败：保留原文件，后续 persist() 会覆盖
      }
    }
  }

  /** 只保留最近若干份损坏文件，避免长期堆积 */
  private pruneCorruptBackups(): void {
    try {
      const dir = dirname(this.filePath)
      const prefix = basename(this.filePath) + '.corrupt-'
      const backups = readdirSync(dir)
        .filter((name) => name.startsWith(prefix))
        .sort()
      for (const name of backups.slice(0, Math.max(0, backups.length - MAX_CORRUPT_BACKUPS))) {
        try {
          unlinkSync(join(dir, name))
        } catch {
          // 清理失败忽略
        }
      }
    } catch {
      // 目录读取失败忽略
    }
  }
  private persist(): void {
    const records = Object.entries(this.load()).map(([k, v]) => ({
      k,
      v: this.safeStorage.encryptString(v).toString('base64')
    }))
    try {
      writeFileSync(this.filePath, JSON.stringify(records), 'utf-8')
    } catch (err) {
      // 写入失败：权限 / 目录被删等，尝试重建目录后重写
      console.warn('[secure-storage] failed to persist secrets file:', err)
      try {
        unlinkSync(this.filePath)
        writeFileSync(this.filePath, JSON.stringify(records), 'utf-8')
      } catch (retryErr) {
        // 仍然失败：只警告；密钥保留在内存中，不影响本次运行
        console.warn('[secure-storage] retry persist also failed:', retryErr)
      }
    }
  }

  get(key: string): string | null {
    return this.load()[key] ?? null
  }

  set(key: string, value: string): void {
    this.load()[key] = value
    this.persist()
  }

  delete(key: string): void {
    if (key in this.load()) {
      delete this.load()[key]
      this.persist()
    }
  }
}

/** 内存实现（测试用） */
export class InMemorySecureStorage implements ISecureStorage {
  private store = new Map<string, string>()

  get(key: string): string | null {
    return this.store.get(key) ?? null
  }

  set(key: string, value: string): void {
    this.store.set(key, value)
  }

  delete(key: string): void {
    this.store.delete(key)
  }
}
