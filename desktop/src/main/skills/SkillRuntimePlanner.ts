import { existsSync, readFileSync, readdirSync } from 'fs'
import { extname, join, relative, sep } from 'path'
import type { SkillRuntimeKind } from '../../preload/index.d'
import { parseSkillFrontmatter } from './SkillFrontmatter'

/** 运行时探测结果（含探测依据，便于展示与排查） */
export interface SkillRuntimePlan {
  kinds: SkillRuntimeKind[]
  entry: string | null
  reasons: string[]
}

const PYTHON_EXTENSIONS = ['.py']
const NODE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts']

/** frontmatter runtime 声明 → 运行时类型（未知返回 null） */
function toRuntimeKind(value: string): SkillRuntimeKind | null {
  const normalized = value.trim().toLowerCase()
  if (['python', 'python3', 'py'].includes(normalized)) return 'python'
  if (['node', 'nodejs', 'javascript', 'js', 'typescript', 'ts'].includes(normalized)) return 'node'
  return null
}

/** 递归收集脚本，路径相对技能根目录（'/' 分隔，字典序） */
function collectScripts(root: string, base: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const ext = extname(entry.name).toLowerCase()
      if (PYTHON_EXTENSIONS.includes(ext) || NODE_EXTENSIONS.includes(ext)) {
        out.push(relative(base, full).split(sep).join('/'))
      }
    }
  }
  if (existsSync(root)) walk(root)
  return out.sort()
}

/**
 * 探测技能运行所需的内置运行时。
 *
 * 顺序：frontmatter 声明 → frontmatter module（JS/TS 入口）→ scripts/ 扩展名 →
 * 依赖文件（package.json / requirements.txt）→ SKILL.md 正文弱信号。
 */
export function planSkillRuntime(skillDir: string): SkillRuntimePlan {
  const kinds = new Set<SkillRuntimeKind>()
  const reasons: string[] = []
  let entry: string | null = null

  const skillMdPath = join(skillDir, 'SKILL.md')
  const frontmatter = existsSync(skillMdPath)
    ? parseSkillFrontmatter(readFileSync(skillMdPath, 'utf-8'))
    : {}

  const declared = frontmatter['metadata.runtime'] ?? frontmatter['runtime']
  if (declared) {
    const kind = toRuntimeKind(declared)
    if (kind) {
      kinds.add(kind)
      reasons.push(`frontmatter 声明 runtime=${declared}`)
    }
  }

  const moduleEntry = (frontmatter['module'] ?? '').trim().replace(/^\.\//, '')
  if (moduleEntry) {
    kinds.add('node')
    entry = moduleEntry
    reasons.push(`frontmatter module=${moduleEntry}`)
  }

  const scripts = collectScripts(join(skillDir, 'scripts'), skillDir)
  const pythonScripts = scripts.filter((name) =>
    PYTHON_EXTENSIONS.includes(extname(name).toLowerCase())
  )
  const nodeScripts = scripts.filter((name) =>
    NODE_EXTENSIONS.includes(extname(name).toLowerCase())
  )
  if (pythonScripts.length > 0) {
    kinds.add('python')
    reasons.push(`scripts/ 下含 ${pythonScripts.length} 个 Python 脚本`)
  }
  if (nodeScripts.length > 0) {
    kinds.add('node')
    reasons.push(`scripts/ 下含 ${nodeScripts.length} 个 JS/TS 脚本`)
  }
  if (!entry) entry = nodeScripts[0] ?? pythonScripts[0] ?? null

  if (
    existsSync(join(skillDir, 'requirements.txt')) ||
    existsSync(join(skillDir, 'pyproject.toml'))
  ) {
    kinds.add('python')
    reasons.push('存在 Python 依赖文件')
  }
  if (existsSync(join(skillDir, 'package.json'))) {
    kinds.add('node')
    reasons.push('存在 package.json')
  }

  if (kinds.size === 0 && existsSync(skillMdPath)) {
    const body = readFileSync(skillMdPath, 'utf-8')
    if (/\bpython3?\s+[\w./-]+\.py/.test(body)) {
      kinds.add('python')
      reasons.push('SKILL.md 正文引用 Python 脚本')
    }
    if (/\bnode\s+[\w./-]+\.(?:m?js|cjs)/.test(body)) {
      kinds.add('node')
      reasons.push('SKILL.md 正文引用 Node 脚本')
    }
  }

  const order: SkillRuntimeKind[] = ['python', 'node']
  return { kinds: order.filter((kind) => kinds.has(kind)), entry, reasons }
}
