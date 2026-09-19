import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import type { DesktopSkill } from '../../preload/index.d'

/** ~/.ke-work/skills/skills.json 持久化结构（机器级本地快照） */
export interface SkillJsonFile {
  version: number
  syncedAt: number
  /** 数据来源 Web 账号（仅记录，不用于隔离） */
  syncedBy?: { webUserId: string; nickname: string } | null
  skills: DesktopSkill[]
}

const FILE_NAME = 'skills.json'
const CURRENT_VERSION = 1

/**
 * 技能本地文件存储（~/.ke-work/skills/skills.json）。
 *
 * - 读取：文件缺失 / JSON 损坏 / 版本不匹配时返回 null 并 warn，不删除旧文件；
 * - 写入：临时文件 + rename 原子写，避免进程中断产生半截文件。
 */
export class SkillJsonStore {
  private readonly filePath: string

  constructor(private readonly dir: string) {
    this.filePath = join(dir, FILE_NAME)
  }

  /** 技能根目录（~/.ke-work/skills） */
  getSkillsDir(): string {
    return this.dir
  }

  /** skills.json 绝对路径（测试 / 排查用） */
  getFilePath(): string {
    return this.filePath
  }

  /** 读取本地技能文件；缺失或损坏返回 null。 */
  async read(): Promise<SkillJsonFile | null> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      console.warn('[skill-json-store] 读取技能文件失败:', err)
      return null
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!this.validate(parsed)) {
        console.warn('[skill-json-store] 技能文件结构校验失败，忽略该文件')
        return null
      }
      return parsed
    } catch (err) {
      console.warn('[skill-json-store] 技能文件 JSON 解析失败:', err)
      return null
    }
  }

  /** 原子写入技能文件；目录不存在时自动创建。 */
  async write(payload: SkillJsonFile): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const tmp = join(this.dir, `.${FILE_NAME}.${process.pid}.${Date.now()}.tmp`)
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8')
    await rename(tmp, this.filePath)
  }

  private validate(parsed: unknown): parsed is SkillJsonFile {
    if (typeof parsed !== 'object' || parsed === null) return false
    const file = parsed as Record<string, unknown>
    if (file.version !== CURRENT_VERSION) return false
    if (typeof file.syncedAt !== 'number') return false
    if (!Array.isArray(file.skills)) return false
    return file.skills.every((item) => {
      if (typeof item !== 'object' || item === null) return false
      const skill = item as Record<string, unknown>
      return typeof skill.id === 'string' && typeof skill.name === 'string'
    })
  }
}
