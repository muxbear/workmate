/**
 * 应用图标（Linux 窗口 / 系统托盘共用）路径解析。
 *
 * **为什么不用 `import icon from '../../resources/icon.png?asset'`**（2026-10-07 实机故障根因）：
 * electron-vite 判断一个资源是否位于 publicDir（main 的 publicDir = `resources`）用的是
 * 大小写敏感的前缀比较 `file.startsWith(publicDir)`；而 Vite 会把 import 的解析结果 realpath
 * 成磁盘真实大小写，publicDir 却沿用构建进程 cwd 的字符串。Windows 上以小写路径进目录再构建
 * （如 `cd /d/work/vscodeProjects/... && npm run dev|build`）时两者失配 → 图标不再走
 * publicDir 分支，被当作普通资源打进 `out/main/chunks/icon-<hash>.png`，bundle 里引用的是这个
 * 哈希文件。此后一旦 out/main 被另一次构建清空（rollup emptyOutDir 连同 chunks 一起删），
 * 仍在运行的进程点击 ✕ 懒创建托盘时图标文件已不存在 →「Failed to load image from path ...」，
 * 退化为最小化并弹「托盘不可用」。
 *
 * 因此这里不依赖打包器对资源的处理方式，按固定候选路径解析（与 knowledge/vector-extension.ts
 * 定位 sqlite-vec 同一约定），任何构建 cwd 大小写下结果一致。
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface AppIconPathInput {
  /** 主进程 bundle 目录（`out/main`；开发态与打包后相同） */
  dirname: string
  /** 打包后可执行文件旁的 resources 目录（`process.resourcesPath`，开发态为 electron 自带 resources） */
  resourcesPath?: string
  /** 注入文件存在性判断，便于单测 */
  exists?: (path: string) => boolean
}

/**
 * 依次尝试（取第一个真实存在的）：
 * 1. `app.asar.unpacked/resources/icon.png` —— 打包后 asarUnpack 的实体文件；
 * 2. `app.asar/resources/icon.png`（开发态即 `out/main/../../resources`，命中仓库 desktop/resources）；
 * 3. `<resourcesPath>/icon.png` —— 兜底（将来若改为 extraResources 分发）。
 * 全部不存在时返回候选 2（由 nativeImage/Tray 报缺失路径，走既有退化与提示）。
 */
export function resolveAppIconPath(input: AppIconPathInput): string {
  const exists = input.exists ?? existsSync
  const bundled = resolve(input.dirname, '..', '..', 'resources', 'icon.png')
  const candidates = [
    bundled.replace('app.asar', 'app.asar.unpacked'),
    bundled,
    ...(input.resourcesPath ? [join(input.resourcesPath, 'icon.png')] : [])
  ]
  return candidates.find((candidate) => exists(candidate)) ?? candidates[1]
}
