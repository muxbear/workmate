import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sqliteVec from 'sqlite-vec'

/**
 * sqlite-vec 扩展的定位与加载入口（信创多架构的关键收口）。
 *
 * - 扩展二进制由 `sqlite-vec` 的平台包提供（`sqlite-vec-<platform>-<arch>`），
 *   当前覆盖 win32-x64 / darwin-x64/arm64 / linux-x64/arm64；
 * - 龙芯/兆芯等架构没有预编译包时，`scripts/fetch-sqlite-vec.mjs` 会从源码
 *   （纯 C，单文件）编译并 vendor 到 `resources/native/sqlite-vec/<platform>-<arch>/`，
 *   本函数会优先使用 vendored 文件；
 * - 两者都拿不到（或 loadExtension 失败）时返回 null，由 KnowledgeStore 记录
 *   `vector_backend=js` 并降级为 JS 余弦——检索功能不中断，只是没有 ANN。
 */
export function resolveSqliteVecExtension(): { path: string; source: 'package' | 'vendor' } | null {
  const vendored = tryVendored()
  if (vendored) return { path: vendored, source: 'vendor' }
  try {
    const path = sqliteVec.getLoadablePath()
    if (path) return { path, source: 'package' }
  } catch (err) {
    console.warn('[knowledge] sqlite-vec 平台包不可用（将尝试降级）：', err)
  }
  return null
}

/**
 * vendored 扩展路径：`<resources>/native/sqlite-vec/<platform>-<arch>/vec0.<ext>`
 *
 * 开发态 resources 目录在仓库 `desktop/resources`；打包后经 asarUnpack / extraResources
 * 落到 `process.resourcesPath`。这里两个位置都试。
 */
function tryVendored(): string | null {
  const file = process.platform === 'win32' ? 'vec0.dll' : 'vec0.so'
  const folder = `${process.platform}-${process.arch}`
  const candidates: string[] = []
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) candidates.push(join(resourcesPath, 'native', 'sqlite-vec', folder, file))
  // __dirname = out/main（打包后）；向上回到 desktop/ 再进 resources
  candidates.push(resolve(__dirname, '..', '..', '..', 'resources', 'native', 'sqlite-vec', folder, file))
  candidates.push(resolve(__dirname, '..', '..', 'resources', 'native', 'sqlite-vec', folder, file))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}
