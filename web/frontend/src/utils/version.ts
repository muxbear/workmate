/** 版本号缺省值（语义化版本） */
export const DEFAULT_VERSION = '1.0.0'

/** 语义化版本号：主版本.次版本.修订号 */
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)/

/**
 * 递增语义化版本号的修订号（patch）：1.2.3 -> 1.2.4。
 *
 * 预发布标识与构建元数据（`1.2.3-beta.1` / `1.2.3+build`）在递增后丢弃；
 * 非法或缺失的输入回退到 `1.0.0`。
 */
export function bumpPatchVersion(version?: string | null): string {
  const matched = SEMVER_PATTERN.exec(version ?? '')
  if (!matched) return DEFAULT_VERSION
  const [, major, minor, patch] = matched
  return `${major}.${minor}.${Number(patch) + 1}`
}

/** 版本号是否合法（允许预发布标识与构建元数据） */
export function isValidVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+([-+].+)?$/.test(version)
}
