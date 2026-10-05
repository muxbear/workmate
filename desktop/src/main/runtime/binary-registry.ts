import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'

/**
 * 运行时注册表（binaries/.cache/registry.json；R8-9 自 BinaryManager 外提）。
 *
 * - 格式与 WorkBuddy 对齐（version/lastUpdated/binaries[dirName][version]）；
 * - **原子写**：tmp 写 + rename（写入过程崩溃不破坏既有注册表——原实现原地覆写）。
 */

/** 注册表中单个版本的记录 */
export interface BinaryRegistryEntry {
  source: string
  executablePath: string
  installPath: string
  installedAt: number
  verified: boolean
}

/** 注册表结构 */
export interface BinaryRegistryData {
  version: number
  lastUpdated: number
  binaries: Record<string, Record<string, BinaryRegistryEntry>>
}

function emptyRegistry(): BinaryRegistryData {
  return { version: 1, lastUpdated: 0, binaries: {} }
}

export class BinaryRegistry {
  private data: BinaryRegistryData

  constructor(private readonly registryPath: string) {
    this.data = this.load()
  }

  private load(): BinaryRegistryData {
    if (!existsSync(this.registryPath)) {
      return emptyRegistry()
    }
    try {
      const raw = readFileSync(this.registryPath, 'utf-8')
      const data = JSON.parse(raw) as BinaryRegistryData
      if (!data.binaries) data.binaries = {}
      return data
    } catch (err) {
      console.warn('[binary-manager] failed to load registry, starting fresh:', err)
      return emptyRegistry()
    }
  }

  /** 原子写：同目录 tmp + rename */
  private save(): void {
    this.data.lastUpdated = Date.now()
    mkdirSync(dirname(this.registryPath), { recursive: true })
    const tmpPath = `${this.registryPath}.${Date.now()}.tmp`
    writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), 'utf-8')
    renameSync(tmpPath, this.registryPath)
  }

  /** 指定运行时目录下 installedAt 最新的条目 */
  getLatest(dirName: string): BinaryRegistryEntry | null {
    const versions = this.data.binaries[dirName]
    if (!versions) return null
    const keys = Object.keys(versions)
    if (keys.length === 0) return null
    let latest: BinaryRegistryEntry | null = null
    let latestTime = 0
    for (const [, entry] of Object.entries(versions)) {
      if (entry.installedAt > latestTime) {
        latestTime = entry.installedAt
        latest = entry
      }
    }
    return latest
  }

  /** 指定运行时目录下 installedAt 最新的版本 key */
  latestVersionKey(dirName: string): string | undefined {
    const versions = this.data.binaries[dirName]
    if (!versions) return undefined
    const keys = Object.keys(versions)
    if (keys.length === 0) return undefined
    let latest = keys[0]
    let latestTime = 0
    for (const key of keys) {
      if (versions[key].installedAt > latestTime) {
        latestTime = versions[key].installedAt
        latest = key
      }
    }
    return latest
  }

  set(dirName: string, version: string, entry: BinaryRegistryEntry): void {
    if (!this.data.binaries[dirName]) {
      this.data.binaries[dirName] = {}
    }
    this.data.binaries[dirName][version] = entry
    this.save()
  }

  removeAll(dirName: string): void {
    if (!this.data.binaries[dirName]) return
    this.data.binaries[dirName] = {}
    this.save()
  }
}
