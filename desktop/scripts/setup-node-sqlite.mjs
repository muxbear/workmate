/**
 * 为 Node 侧测试准备一份独立的 better-sqlite3（Node ABI）副本。
 *
 * 背景：better-sqlite3 是单 binding 非 N-API 模块，Electron（ABI 140）与 Node（ABI 137）
 * 互斥；且不能靠 build/Debug 旁路共存（bindings 对 ABI 不匹配错误不继续回退，
 * 见 scripts/ensure-better-sqlite3-electron.cjs 的判定逻辑）。
 *
 * 做法：整包复制到 node_modules/better-sqlite3-node，换上当前 Node 的预编译 binding；
 * vitest.config.ts 检测到该目录时把 `better-sqlite3` 别名到副本 —— 应用（Electron）
 * 继续用原包，测试（Node）用副本，两者零干扰、无需来回切换。
 *
 * 幂等：副本已存在且可被当前 Node 加载时直接通过；失败仅告警退出 0（不阻断测试）。
 */
import { cpSync, existsSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(rootDir, 'node_modules', 'better-sqlite3')
const dstDir = join(rootDir, 'node_modules', 'better-sqlite3-node')
const prebuildInstall = join(rootDir, 'node_modules', 'prebuild-install', 'bin.js')

if (!existsSync(srcDir)) {
  console.warn('[node-sqlite] 未找到 node_modules/better-sqlite3，请先 npm install（跳过）')
  process.exit(0)
}

/** 当前 Node 能否从指定目录加载 binding（返回错误信息或 null） */
function probeLoad(dir) {
  try {
    execFileSync(process.execPath, ['-e', `require(${JSON.stringify(dir)})(':memory:').close()`], {
      stdio: 'pipe'
    })
    return null
  } catch (err) {
    return (err.stderr?.toString() || err.message || 'unknown').trim().split('\n')[0]
  }
}

if (!existsSync(dstDir)) {
  console.log('[node-sqlite] 复制 better-sqlite3 → better-sqlite3-node') // 副本仅用于 vitest 别名
  cpSync(srcDir, dstDir, { recursive: true })
}

let loadError = probeLoad(dstDir)
if (loadError) {
  console.log('[node-sqlite] 副本 binding 不匹配当前 Node，拉取 Node ABI 预编译包…')
  try {
    execFileSync(process.execPath, [prebuildInstall, '-r', 'node', '-t', process.versions.node], {
      cwd: dstDir,
      stdio: 'pipe'
    })
  } catch (err) {
    console.warn(
      '[node-sqlite] 预编译包拉取失败（网络/缓存不可用），测试将回退使用原 binding：',
      (err.stderr?.toString() || err.message || '').trim().split('\n')[0]
    )
    process.exit(0)
  }
  loadError = probeLoad(dstDir)
}

if (loadError) {
  console.warn('[node-sqlite] 副本仍无法加载，测试将回退使用原 binding：', loadError)
} else {
  console.log('[node-sqlite] Node ABI 副本就绪：node_modules/better-sqlite3-node')
}
process.exit(0)
