import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'fs/promises'
import { dirname, join, relative, sep } from 'path'
import { unzipSync } from 'fflate'
import type { SkillFileEntry } from '../../preload/index.d'
import { parseSkillFrontmatter, resolveSkillDirName } from './SkillFrontmatter'

/** 单技能包体积上限（与服务端上传限制对齐） */
const MAX_SKILL_BYTES = 100 * 1024 * 1024

/** 技能私有运行环境目录（不参与技能内容清单） */
export const SKILL_RUNTIME_DIR = '.runtime'

/** 解压后的技能包 */
export interface ExtractedSkillPackage {
  /** 技能根目录名（SKILL.md frontmatter name，不合规时回退 skill-<id8>） */
  dirName: string
  /** 技能包内文件（相对路径 + 内容），保持原始目录结构 */
  files: Array<{ path: string; content: Uint8Array }>
}

/** 路径按码点排序（与服务端 manifest 的 ASCII 排序一致，保证指纹可比较） */
function comparePath(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** 单文件 sha256（十六进制） */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 技能内容指纹（路径 + 文件哈希；与服务端 manifest 同算法） */
export function hashSkillFileEntries(entries: SkillFileEntry[]): string {
  const hasher = createHash('sha256')
  for (const entry of [...entries].sort((a, b) => comparePath(a.path, b.path))) {
    hasher.update(entry.path)
    hasher.update(entry.sha256)
  }
  return hasher.digest('hex')
}

/** 校验 zip 内相对路径：拒绝绝对路径与 .. 穿越；目录条目返回 null */
function normalizeEntryPath(rawPath: string): string | null {
  const path = rawPath.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!path || path.endsWith('/')) return null
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
    throw new Error(`技能包包含绝对路径：${rawPath}`)
  }
  const segments = path.split('/')
  if (segments.some((segment) => segment === '..' || segment === '')) {
    throw new Error(`技能包包含非法路径：${rawPath}`)
  }
  return path
}

/** 去掉压缩包的单层包装目录（如 skill-name/SKILL.md → SKILL.md） */
function stripSingleRoot(entries: Map<string, Uint8Array>): Map<string, Uint8Array> {
  if (entries.has('SKILL.md')) return entries
  let root: string | null = null
  for (const path of entries.keys()) {
    const head = path.split('/')[0]!
    if (root === null) root = head
    else if (root !== head) return entries
  }
  if (!root) return entries
  const prefix = `${root}/`
  const out = new Map<string, Uint8Array>()
  for (const [path, content] of entries) {
    if (!path.startsWith(prefix)) return entries
    out.set(path.slice(prefix.length), content)
  }
  return out
}

/**
 * 技能包文件存储（~/.ke-work/skills 下的下载、解压、校验与原子替换）。
 *
 * 目录结构与 Agent Skills 规范保持一致：SKILL.md / scripts / references / assets 原样落盘，
 * 仅追加 `.runtime/`（运行时环境，不参与技能内容清单与 agent 技能扫描）。
 */
export class SkillFileStore {
  constructor(private readonly baseDir: string) {}

  getBaseDir(): string {
    return this.baseDir
  }

  getTmpDir(): string {
    return join(this.baseDir, '.tmp')
  }

  dirFor(dirName: string): string {
    return join(this.baseDir, dirName)
  }

  skillMdPath(dirName: string): string {
    return join(this.dirFor(dirName), 'SKILL.md')
  }

  /** 技能目录是否存在且包含 SKILL.md */
  hasSkill(dirName: string | undefined | null): boolean {
    if (!dirName) return false
    return existsSync(this.skillMdPath(dirName))
  }

  /**
   * 解压技能包缓冲（zip）。
   *
   * - 兼容「压缩包根目录即技能」与「单层包装目录」两种结构；
   * - 校验路径穿越与体积上限；
   * - 依据 SKILL.md frontmatter 计算目录名。
   */
  extractPackage(buffer: Uint8Array, skillId: string): ExtractedSkillPackage {
    if (buffer.byteLength > MAX_SKILL_BYTES) {
      throw new Error('技能包超过 100MB 上限')
    }
    const raw = unzipSync(buffer)
    const entries = new Map<string, Uint8Array>()
    for (const [rawPath, content] of Object.entries(raw)) {
      const path = normalizeEntryPath(rawPath)
      if (path) entries.set(path, content)
    }
    if (entries.size === 0) throw new Error('技能包为空')

    const stripped = stripSingleRoot(entries)
    const skillMd = stripped.get('SKILL.md')
    if (!skillMd) throw new Error('技能包缺少 SKILL.md')

    const frontmatter = parseSkillFrontmatter(new TextDecoder('utf-8').decode(skillMd))
    const dirName = resolveSkillDirName(frontmatter['name'], skillId)

    const files = [...stripped.entries()]
      .filter(([path]) => !path.startsWith(`${SKILL_RUNTIME_DIR}/`))
      .map(([path, content]) => ({ path, content }))
      .sort((a, b) => comparePath(a.path, b.path))

    const totalBytes = files.reduce((sum, file) => sum + file.content.byteLength, 0)
    if (totalBytes > MAX_SKILL_BYTES) throw new Error('技能包解压后超过 100MB 上限')

    return { dirName, files }
  }

  /** 原子写入技能包；替换旧版本时保留既有 .runtime/ 运行环境 */
  async writePackage(pkg: ExtractedSkillPackage): Promise<SkillFileEntry[]> {
    await mkdir(this.getTmpDir(), { recursive: true })
    const tmp = join(this.getTmpDir(), `${pkg.dirName}-${Date.now()}-${process.pid}`)
    await rm(tmp, { recursive: true, force: true })
    await mkdir(tmp, { recursive: true })
    try {
      for (const file of pkg.files) {
        const target = join(tmp, ...file.path.split('/'))
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, file.content)
      }
      const target = this.dirFor(pkg.dirName)
      const runtimeDir = join(target, SKILL_RUNTIME_DIR)
      if (existsSync(runtimeDir)) {
        await rename(runtimeDir, join(tmp, SKILL_RUNTIME_DIR))
      }
      if (existsSync(target)) await rm(target, { recursive: true, force: true })
      await rename(tmp, target)
    } catch (err) {
      await rm(tmp, { recursive: true, force: true })
      throw err
    }
    return this.listFiles(pkg.dirName)
  }

  /** 列出技能包内文件（排除 .runtime/），路径以 '/' 分隔并按字典序排序 */
  async listFiles(dirName: string): Promise<SkillFileEntry[]> {
    const root = this.dirFor(dirName)
    const out: SkillFileEntry[] = []
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (dir === root && entry.name === SKILL_RUNTIME_DIR) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
        } else if (entry.isFile()) {
          const content = await readFile(full)
          out.push({
            path: relative(root, full).split(sep).join('/'),
            size: content.byteLength,
            sha256: sha256Hex(content)
          })
        }
      }
    }
    if (existsSync(root)) await walk(root)
    return out.sort((a, b) => comparePath(a.path, b.path))
  }

  /** 删除技能目录（含 .runtime/） */
  async removeSkill(dirName: string): Promise<void> {
    await rm(this.dirFor(dirName), { recursive: true, force: true })
  }
}
