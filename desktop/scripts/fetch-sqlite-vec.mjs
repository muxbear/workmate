#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- .mjs 脚本无法标注 TS 返回类型 */
/**
 * 采集 sqlite-vec 扩展二进制到 resources/native/sqlite-vec/<platform>-<arch>/
 *
 * 信创（统信 UOS / 银河麒麟）适配的关键脚本，三级策略：
 *  1. `sqlite-vec` npm 包自带当前平台二进制（win32-x64 / darwin-* / linux-x64 / linux-arm64）
 *     → 直接复制到 resources/native/ 下，打包时随 asarUnpack 一起分发；
 *  2. 目标平台没有 npm 预编译包（如 linux-loongarch64 / linux-mips64el，或交叉打包其他架构）
 *     → 用 `--from-source` 从源码编译：sqlite-vec 是纯 C 单文件、无第三方依赖，
 *       在目标机器上只需一个 C 编译器（cc/gcc）：
 *         cc -O3 -shared -fPIC sqlite-vec.c -o vec0.so
 *       （龙芯/兆芯自带的 gcc 均可直接编译；这是本方案选 sqlite-vec 而非 Rust 向量库的原因之一）
 *  3. 两者都拿不到 → 运行时会自动降级为 JS 余弦（见 vector-extension.ts），检索功能不中断。
 *
 * 用法：
 *   node scripts/fetch-sqlite-vec.mjs                # 当前平台（从 node_modules 复制）
 *   node scripts/fetch-sqlite-vec.mjs --from-source  # 当前平台（下载源码编译，Linux 信创用）
 *   node scripts/fetch-sqlite-vec.mjs --all          # 打包机可获取的全部平台
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, '..')
const outRoot = join(desktopRoot, 'resources', 'native', 'sqlite-vec')

/** 源码编译时使用的版本（与 package.json 的 sqlite-vec 依赖保持一致；升级需同步） */
const SOURCE_VERSION = 'v0.1.9'
const SOURCE_URL = `https://github.com/asg017/sqlite-vec/archive/refs/tags/${SOURCE_VERSION}.tar.gz`

const args = process.argv.slice(2)
const fromSource = args.includes('--from-source')
const all = args.includes('--all')

function extFor(platform) {
  if (platform === 'win32') return 'vec0.dll'
  if (platform === 'darwin') return 'vec0.dylib'
  return 'vec0.so'
}

function folderFor(platform, arch) {
  return `${platform}-${arch}`
}

/** npm 平台包名：sqlite-vec 用 `windows` 而不是 Node 的 `win32` 前缀 */
function packageNameFor(platform, arch) {
  const name = platform === 'win32' ? 'windows' : platform
  return `sqlite-vec-${name}-${arch}`
}

/** 从 node_modules 复制当前平台二进制 */
function copyFromPackage(platform, arch) {
  const pkg = packageNameFor(platform, arch)
  const source = join(desktopRoot, 'node_modules', pkg, extFor(platform))
  if (!existsSync(source)) return null
  const target = join(outRoot, folderFor(platform, arch), extFor(platform))
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target)
  return target
}

/**
 * 从源码编译（需要 cc/gcc + curl/tar）。
 * 纯 C 单文件、无第三方依赖，龙芯（loongarch64）/兆芯等无预编译包的信创机器可直接跑。
 */
function buildFromSource(platform, arch) {
  if (platform === 'win32') {
    console.warn('[fetch-sqlite-vec] Windows 请使用预编译包（npm 自带），跳过源码编译')
    return null
  }
  const work = mkdtempSync(join(tmpdir(), 'sqlite-vec-src-'))
  try {
    console.log(`[fetch-sqlite-vec] 下载源码 ${SOURCE_URL}`)
    execFileSync('bash', ['-lc', `curl -fsSL "${SOURCE_URL}" | tar -xz -C "${work}"`], {
      stdio: 'inherit'
    })
    const src = join(work, `sqlite-vec-${SOURCE_VERSION.replace(/^v/, '')}`, 'sqlite-vec.c')
    if (!existsSync(src)) throw new Error(`源码文件不存在：${src}`)
    const target = join(outRoot, folderFor(platform, arch), extFor(platform))
    mkdirSync(dirname(target), { recursive: true })
    const cc = process.env.CC || 'cc'
    console.log(`[fetch-sqlite-vec] 编译：${cc} -O3 -shared -fPIC sqlite-vec.c`)
    execFileSync(cc, ['-O3', '-shared', '-fPIC', src, '-o', target], { stdio: 'inherit' })
    return target
  } catch (err) {
    console.warn(`[fetch-sqlite-vec] 源码编译失败（可忽略，运行时将降级为 JS 余弦）：${err.message}`)
    return null
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** 打包机可获取的预编译平台清单（与 sqlite-vec 官方发布一致） */
const PREBUILT_TARGETS = [
  ['win32', 'x64'],
  ['darwin', 'x64'],
  ['darwin', 'arm64'],
  ['linux', 'x64'],
  ['linux', 'arm64']
]

function report(path) {
  if (path) console.log(`[fetch-sqlite-vec] ✓ ${path}`)
}

if (all) {
  let count = 0
  for (const [platform, arch] of PREBUILT_TARGETS) {
    const installed = copyFromPackage(platform, arch)
    if (installed) {
      report(installed)
      count += 1
    } else {
      console.warn(`[fetch-sqlite-vec] 跳过（未安装 ${packageNameFor(platform, arch)}）：${platform}-${arch}`)
    }
  }
  console.log(`[fetch-sqlite-vec] 完成：${count}/${PREBUILT_TARGETS.length} 个平台`)
} else {
  const platform = process.platform
  const arch = process.arch
  const path = fromSource ? buildFromSource(platform, arch) : copyFromPackage(platform, arch)
  if (path) {
    report(path)
  } else {
    console.warn(
      `[fetch-sqlite-vec] 当前平台 ${platform}-${arch} 未取得扩展；运行时将降级为 JS 余弦（检索仍可用）`
    )
    // 记录降级说明，便于信创现场排查
    mkdirSync(join(outRoot, folderFor(platform, arch)), { recursive: true })
    writeFileSync(
      join(outRoot, folderFor(platform, arch), 'README.txt'),
      [
        `未找到 ${platform}-${arch} 的 sqlite-vec 扩展。`,
        '在目标机器上用 C 编译器从源码构建：',
        `  curl -fsSL ${SOURCE_URL} | tar -xz`,
        '  cc -O3 -shared -fPIC sqlite-vec.c -o vec0.so',
        '或在本机执行：node scripts/fetch-sqlite-vec.mjs --from-source',
        '未提供扩展时应用会自动降级为 JS 余弦检索（功能可用，性能与规模受限）。'
      ].join('\n'),
      'utf-8'
    )
  }
}
