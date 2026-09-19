/**
 * 技能 SKILL.md 前置元数据解析与本地目录名规范化。
 *
 * 仅解析本方案需要的键值（name / module / metadata.runtime 等），不引入 YAML 依赖：
 * Agent Skills 的 frontmatter 为扁平或单层嵌套映射。
 */

/** Agent Skills 规范的技能名：小写字母、数字与连字符，1-64 字符 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/

/** frontmatter 匹配（--- 起始、--- 结束） */
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---/

/** 去掉值两侧的引号 */
function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/**
 * 解析 SKILL.md 的 YAML 前置元数据。
 *
 * 支持 `key: value` 与单层嵌套（如 metadata.runtime），嵌套键输出为 `metadata.runtime`。
 * 无 frontmatter 或解析失败时返回空对象（不抛错）。
 */
export function parseSkillFrontmatter(content: string): Record<string, string> {
  const match = FRONTMATTER_PATTERN.exec(content)
  if (!match) return {}
  const out: Record<string, string> = {}
  let parent = ''
  let parentIndent = -1
  for (const rawLine of match[1]!.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const sep = trimmed.indexOf(':')
    if (sep <= 0) continue
    const key = trimmed.slice(0, sep).trim()
    const value = trimmed.slice(sep + 1).trim()
    if (!value) {
      parent = key
      parentIndent = indent
      continue
    }
    if (parent && indent > parentIndent) {
      out[`${parent}.${key}`] = stripQuotes(value)
    } else {
      out[key] = stripQuotes(value)
      parent = ''
      parentIndent = -1
    }
  }
  return out
}

/** 目录名是否符合 Agent Skills 规范（不含连续连字符） */
export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name) && !name.includes('--')
}

/**
 * 计算技能在 ~/.ke-work/skills 下的目录名。
 *
 * 规范名（SKILL.md frontmatter name / 服务端目录名）优先；中文等不合规名称回退为
 * skill-<id 前 8 位>，与后端 _skill_dir_name 保持一致。
 */
export function resolveSkillDirName(rawName: string | undefined | null, skillId: string): string {
  const name = (rawName ?? '').trim()
  if (isValidSkillName(name)) return name
  const slug = skillId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8)
  return `skill-${slug || 'package'}`
}
