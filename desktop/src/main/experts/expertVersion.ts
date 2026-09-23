/**
 * 专家版本号比对（同步时决定是否用服务端数据覆盖本地副本）。
 *
 * 版本号格式与 Web 端一致：语义化版本 `主.次.修订[-预发布][+构建]`
 * （Web 端只负责递增/校验，见 web/frontend/src/utils/version.ts；比对只在客户端做）。
 */

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** 预发布标识（`-` 之后的部分），无则为 null */
  prerelease: string | null
}

/** 最低版本：缺失或非法输入按此处理，保证任何合法版本都「更新」 */
const LOWEST_VERSION: ParsedVersion = { major: 0, minor: 0, patch: 0, prerelease: null }

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.+)?$/

/** 解析语义化版本号；缺失或非法返回 null（构建元数据 `+xxx` 不参与比较，直接丢弃） */
function parseVersion(version?: string | null): ParsedVersion | null {
  const matched = VERSION_PATTERN.exec((version ?? '').trim())
  if (!matched) return null
  return {
    major: Number(matched[1]),
    minor: Number(matched[2]),
    patch: Number(matched[3]),
    prerelease: matched[4] ?? null
  }
}

/** 预发布标识比较（语义化版本规范：数字段按数值比，数字段低于非数字段，短者更低） */
function comparePrerelease(left: string, right: string): number {
  const leftParts = left.split('.')
  const rightParts = right.split('.')
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index]
    const rightPart = rightParts[index]
    // 前缀相同（1.0.0-alpha 与 1.0.0-alpha.1）：段数少者更低
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null
    if (leftNumber !== null && rightNumber !== null) {
      if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1
    } else if (leftNumber !== null) {
      return -1
    } else if (rightNumber !== null) {
      return 1
    } else if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1
    }
  }
  return 0
}

/**
 * 比较两个专家版本号大小；缺失或非法输入按 0.0.0 处理。
 *
 * @returns left > right 返回 1，left < right 返回 -1，相等返回 0
 */
export function compareExpertVersion(left?: string | null, right?: string | null): number {
  const a = parseVersion(left) ?? LOWEST_VERSION
  const b = parseVersion(right) ?? LOWEST_VERSION
  if (a.major !== b.major) return a.major > b.major ? 1 : -1
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1
  if (a.prerelease === b.prerelease) return 0
  // 同核心版本：带预发布标识的低于正式版（1.0.0-beta < 1.0.0）
  if (a.prerelease === null) return 1
  if (b.prerelease === null) return -1
  return comparePrerelease(a.prerelease, b.prerelease)
}

/**
 * 同步时是否需要服务端版本覆盖本地副本。
 *
 * 本地无版本（本次改动前写入的 experts.json）一律视为需要更新，
 * 使老数据在首次同步后补齐版本号；其余情况仅服务端版本更高才更新。
 */
export function shouldUpdateExpert(
  localVersion?: string | null,
  remoteVersion?: string | null
): boolean {
  if (!localVersion) return true
  return compareExpertVersion(remoteVersion, localVersion) > 0
}
