import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import type { DesktopExpert } from '../../preload/index.d'

/** ~/.ke-work/experts/experts.json 持久化结构（机器级本地快照） */
export interface ExpertJsonFile {
  version: number
  syncedAt: number
  /** 数据来源 Web 账号（仅记录，不用于隔离） */
  syncedBy?: { webUserId: string; nickname: string } | null
  experts: DesktopExpert[]
}

const FILE_NAME = 'experts.json'
const CURRENT_VERSION = 1

/**
 * 专家本地文件存储（~/.ke-work/experts/experts.json）。
 * - 读取：文件缺失 / JSON 损坏 / 版本不匹配时返回 null 并 warn，不删除旧文件；
 * - 写入：临时文件 + rename 原子写，避免进程中断产生半截文件。
 */
export class ExpertJsonStore {
  private readonly filePath: string

  constructor(private readonly dir: string) {
    this.filePath = join(dir, FILE_NAME)
  }

  /** 读取本地专家文件；缺失或损坏返回 null。 */
  async read(): Promise<ExpertJsonFile | null> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      console.warn('[expert-json-store] 读取专家文件失败:', err)
      return null
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!this.validate(parsed)) {
        console.warn('[expert-json-store] 专家文件结构校验失败，忽略该文件')
        return null
      }
      return parsed
    } catch (err) {
      console.warn('[expert-json-store] 专家文件 JSON 解析失败:', err)
      return null
    }
  }

  /** 原子写入专家文件；目录不存在时自动创建。 */
  async write(payload: ExpertJsonFile): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const tmp = join(this.dir, `.${FILE_NAME}.${process.pid}.${Date.now()}.tmp`)
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8')
    await rename(tmp, this.filePath)
  }

  private validate(parsed: unknown): parsed is ExpertJsonFile {
    if (typeof parsed !== 'object' || parsed === null) return false
    const file = parsed as Record<string, unknown>
    if (file.version !== CURRENT_VERSION) return false
    if (typeof file.syncedAt !== 'number') return false
    if (!Array.isArray(file.experts)) return false
    return file.experts.every((item) => {
      if (typeof item !== 'object' || item === null) return false
      const expert = item as Record<string, unknown>
      return typeof expert.id === 'string' && typeof expert.name === 'string'
    })
  }
}
