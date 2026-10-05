/**
 * 打包兼容补丁：@langchain/langgraph-sdk 的 vendored 依赖路径。
 *
 * 背景（2026-10-05 实测，安装包不可用级缺陷）：
 *   @langchain/langgraph-sdk（1.9.28 ~ 1.11.x；2.0.0 才修）发布的 dist 内含自 vendored 的
 *   pnpm 结构 `dist/node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/...`，dist 代码用
 *   相对路径硬编码引用它（如 async_caller.cjs 里
 *   `require("../node_modules/.pnpm/p-retry@7.1.1/node_modules/p-retry/index.cjs")`，
 *   包间互引则是「上溯到 .pnpm 根再进兄弟目录」的相对路径）。
 *   npm 安装原样保留该目录树 → dev 正常；但 electron-builder 打包时跳过**所有**名为
 *   node_modules 的嵌套目录 → 打包产物启动即 `Cannot find module .../.pnpm/...`，
 *   主进程弹错、应用不可用（2026-10-05 实测取证）。
 *
 * 修复方式（不升级上游、不改解析语义，只做「重命名 + 同步改写引用」）：
 *   1) 把 dist/node_modules/.pnpm/ 整树复制为 dist/vendor-pnpm/，
 *      复制过程中把每个名为 node_modules 的目录改名 pkgs（**树形与相对深度不变**，
 *      因此包之间「上溯到根再进兄弟目录」的相对引用只需字符串替换即可继续成立）；
 *   2) 改写 dist 下（排除原始 node_modules）所有 .cjs/.js/.mjs 中：
 *      - `../node_modules/.pnpm/` → `../vendor-pnpm/`（async_caller 的外层前缀）
 *      - `<name>@<ver>/node_modules/` → `<name>@<ver>/pkgs/`（含包间互引）
 *
 * 幂等：重复执行安全（vendor-pnpm 每次从原始 .pnpm 重建，两处改写均为定向替换）。
 * 挂载点：package.json 的 postinstall（在 ensure-better-sqlite3 之后）。
 */
const { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')
const SDK_DIST = join(ROOT, 'node_modules', '@langchain', 'langgraph-sdk', 'dist')
const PRISTINE = join(SDK_DIST, 'node_modules') // 原始 vendored 树（保持不动）
// 目标布局刻意与原始同深：node_modules/.pnpm ≡ vendor-pnpm/store（两层），
// 这样「上溯到 dist/_virtual 等公共目录」的多级相对引用深度不变（差一级就会错位）。
const VENDOR_ROOT = join(SDK_DIST, 'vendor-pnpm')
const VENDOR_TARGET = join(VENDOR_ROOT, 'store')
const EXTS = ['.cjs', '.js', '.mjs']
const RULE_PREFIX = /\.\.\/node_modules\/\.pnpm\//g // ../node_modules/.pnpm/ → ../vendor-pnpm/store/
const RULE_PKGS = /([A-Za-z0-9._-]+@\d[A-Za-z0-9.+-]*)\/node_modules\//g // <name>@<ver>/node_modules/ → $1/pkgs/

function log(...a) {
  console.log('[patch-langgraph-sdk]', ...a)
}

if (!existsSync(SDK_DIST)) {
  log('未安装 @langchain/langgraph-sdk，跳过')
  process.exit(0)
}

// ① 重建 vendor-pnpm（node_modules → pkgs 的重命名复制，树形不变）
function copyRenamed(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const name of readdirSync(src)) {
    const from = join(src, name)
    const to = join(dest, name === 'node_modules' ? 'pkgs' : name)
    const st = statSync(from)
    if (st.isDirectory()) copyRenamed(from, to)
    else cpSync(from, to, { dereference: true })
  }
}
let copied = false
if (existsSync(PRISTINE) && existsSync(join(PRISTINE, '.pnpm'))) {
  rmSync(VENDOR_ROOT, { recursive: true, force: true })
  copyRenamed(join(PRISTINE, '.pnpm'), VENDOR_TARGET)
  copied = true
}

// ② 改写引用：dist 下（排除原始 node_modules 树与 vendor-pnpm 里的二进制无关文件）
let rewritten = 0
function rewrite(dir, inVendor) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (!inVendor && name === 'node_modules') continue // 原始树保持不动
      rewrite(full, inVendor || name === 'vendor-pnpm')
      continue
    }
    if (!EXTS.some((e) => name.endsWith(e))) continue
    const src = readFileSync(full, 'utf-8')
    if (!src.includes('node_modules')) continue
    const out = src.replace(RULE_PREFIX, '../vendor-pnpm/store/').replace(RULE_PKGS, '$1/pkgs/')
    if (out !== src) {
      writeFileSync(full, out, 'utf-8')
      rewritten += 1
    }
  }
}
rewrite(SDK_DIST, false)

// ③ 校验：非 vendor 区域不应残留 .pnpm 相对引用
let remaining = 0
function check(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'vendor-pnpm') continue
      check(full)
      continue
    }
    if (!EXTS.some((e) => name.endsWith(e))) continue
    if (readFileSync(full, 'utf-8').includes('node_modules/.pnpm/')) remaining += 1
  }
}
check(SDK_DIST)
log(`完成：vendored 树${copied ? '已重建' : '缺失(跳过)'}；改写 ${rewritten} 个文件；残留旧引用 ${remaining} 处`)
if (remaining > 0) {
  console.warn('[patch-langgraph-sdk] 警告：仍有未改写的 .pnpm 引用，请检查上游新布局')
}
process.exit(remaining > 0 ? 1 : 0)
