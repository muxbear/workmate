/**
 * 内置运行时管理器（BinaryManager）
 *
 * 管理 ~/.ke-work/binaries/ 目录下的 Python、Node.js、Git Bash 三个便携运行时。
 * - 目录结构、注册表格式与 WorkBuddy（~/.workbuddy/binaries）对齐
 * - 提供 listRuntimes() 供渲染层展示状态
 * - 提供 install/uninstall/detect 供安全中心设置页操作
 * - 安装方式：从各官网下载压缩包 → 解压 → 验证 → 写注册表
 */

import { execFile } from 'child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import https from 'https'
import { EventEmitter } from 'events'
import { promisify } from 'util'
import type { SettingsStore } from '../settings/SettingsStore'

const execFileAsync = promisify(execFile)

// ── 类型定义 ──

/** 运行时类型标识 */
export type RuntimeId = 'python' | 'node' | 'git'

/** 运行时安装状态 */
export type RuntimeStatus = 'not-installed' | 'installed' | 'installing' | 'error'

/** 运行时信息（渲染层消费） */
export interface RuntimeInfo {
  id: RuntimeId
  name: string
  description: string
  mark: string
  color: string
  status: RuntimeStatus
  version?: string
  executablePath?: string
  installPath?: string
  enabled: boolean
  error?: string
}

/** 安装进度事件（推送给渲染层） */
export interface RuntimeProgress {
  id: RuntimeId
  phase: 'downloading' | 'extracting' | 'verifying' | 'done' | 'error'
  /** 下载进度百分比 0–100（仅 downloading 阶段） */
  percent: number
  /** 下载的字节数 */
  receivedBytes: number
  /** 文件总字节数（未知时为 0） */
  totalBytes: number
  message?: string
}

/** 注册表中单个版本的记录 */
interface RegistryEntry {
  source: string
  executablePath: string
  installPath: string
  installedAt: number
  verified: boolean
}

/** 注册表结构 */
interface Registry {
  version: number
  lastUpdated: number
  binaries: Record<string, Record<string, RegistryEntry>>
}

// ── 运行时元数据 ──

interface RuntimeMeta {
  /** 注册表中的 key（也是 binaries/ 下的子目录名） */
  dirName: string
  /** 可执行文件在 versions/{version}/ 下的相对路径 */
  exeRelPath: string
  /** 探测版本时的参数 */
  versionArgs: string[]
  /** 从版本输出中提取版本号的正则 */
  versionRegex: RegExp
  /** 从 --version 输出中提取的版本号在 match 中的 group 索引 */
  versionGroup: number
  /** 默认安装版本 */
  defaultVersion: string
  /** 下载源 URL 模板（{version} 占位） */
  downloadUrlTemplate: string
  /** 压缩包类型 */
  archiveType: 'zip' | '7z-sfx'
  /** zip 内是否有顶层目录（需要提取内部目录），模板用 {version} 占位 */
  zipTopDir?: string
}

const RUNTIME_META: Record<RuntimeId, RuntimeMeta> = {
  python: {
    dirName: 'python',
    exeRelPath: 'python.exe',
    versionArgs: ['--version'],
    versionRegex: /Python\s+([\d.]+)/,
    versionGroup: 1,
    defaultVersion: '3.13.12',
    downloadUrlTemplate:
      'https://www.python.org/ftp/python/{version}/python-{version}-embed-amd64.zip',
    archiveType: 'zip'
  },
  node: {
    dirName: 'node',
    exeRelPath: 'node.exe',
    versionArgs: ['--version'],
    versionRegex: /v([\d.]+)/,
    versionGroup: 1,
    defaultVersion: '22.22.2',
    downloadUrlTemplate:
      'https://nodejs.org/dist/v{version}/node-v{version}-win-x64.zip',
    archiveType: 'zip',
    zipTopDir: 'node-v{version}-win-x64'
  },
  git: {
    dirName: 'PortableGit',
    exeRelPath: 'bin/bash.exe',
    versionArgs: ['--version'],
    versionRegex: /version\s+([\d.]+)/i,
    versionGroup: 1,
    defaultVersion: '2.49.0',
    downloadUrlTemplate:
      'https://github.com/git-for-windows/git/releases/download/v2.49.0.windows.1/PortableGit-2.49.0-64-bit.7z.exe',
    archiveType: '7z-sfx'
  }
}

const RUNTIME_DISPLAY: Record<
  RuntimeId,
  { name: string; description: string; mark: string; color: string }
> = {
  python: {
    name: 'Python',
    description: '通用编程语言，适用于脚本编写、自动化和数据处理',
    mark: 'Py',
    color: '#3776ab'
  },
  node: {
    name: 'Node.js',
    description: '基于 Chrome V8 引擎的 JavaScript 运行时，用于服务端开发',
    mark: 'JS',
    color: '#6aa36f'
  },
  git: {
    name: 'Git Bash',
    description: '在 Windows 上提供 Git 和 Bash Shell 的类 Unix 命令行环境',
    mark: 'G',
    color: '#ef5a43'
  }
}

// ── BinaryManager ──

/**
 * 内置运行时管理器
 *
 * 管理 ~/.ke-work/binaries/ 下三个运行时的安装、探测、卸载。
 * 注册表存储在 binaries/.cache/registry.json，格式与 WorkBuddy 对齐。
 */
export class BinaryManager extends EventEmitter {
  private readonly baseDir: string
  private readonly cacheDir: string
  private readonly registryPath: string
  private registry: Registry
  /** 运行中安装/卸载状态（防止并发操作） */
  private readonly inflight = new Map<RuntimeId, RuntimeStatus>()

  constructor(
    binariesDir: string,
    private readonly settingsStore: SettingsStore
  ) {
    super()
    this.baseDir = binariesDir
    this.cacheDir = join(binariesDir, '.cache')
    this.registryPath = join(this.cacheDir, 'registry.json')
    this.registry = this.loadRegistry()
  }

  /** 应用启动时调用：确保目录结构存在 */
  init(): void {
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true })
    }
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true })
    }
    for (const meta of Object.values(RUNTIME_META)) {
      const dir = join(this.baseDir, meta.dirName, 'versions')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
    }
    console.log(`[binary-manager] initialized, base: ${this.baseDir}`)
  }

  /** 获取 binaries 基础目录 */
  getBaseDir(): string {
    return this.baseDir
  }

  // ── 公开 API ──

  /** 列出所有运行时的状态（供渲染层展示） */
  listRuntimes(): RuntimeInfo[] {
    const ids: RuntimeId[] = ['python', 'node', 'git']
    const runtimeEnabled = this.settingsStore.get('runtime.enabled') === true

    return ids.map((id) => {
      const display = RUNTIME_DISPLAY[id]
      const inflight = this.inflight.get(id)
      const entry = this.getLatestEntry(id)

      let status: RuntimeStatus = 'not-installed'
      let version: string | undefined
      let executablePath: string | undefined
      let installPath: string | undefined
      let error: string | undefined

      if (inflight) {
        status = inflight
      } else if (entry && entry.verified) {
        status = 'installed'
        version = this.extractVersionFromRegistryKey(id)
        executablePath = entry.executablePath
        installPath = entry.installPath
      }

      // 各运行时开关：总开关关闭时全部置灰
      const subKey = `runtime.${id}.enabled` as `runtime.${RuntimeId}.enabled`
      const subEnabled = this.settingsStore.get(subKey) !== false
      const enabled = runtimeEnabled && subEnabled

      return {
        id,
        name: display.name,
        description: display.description,
        mark: display.mark,
        color: display.color,
        status,
        version,
        executablePath,
        installPath,
        enabled,
        error
      }
    })
  }

  /** 探测已安装运行时的版本（spawn 调用 --version） */
  async detectRuntime(id: RuntimeId): Promise<string | null> {
    const entry = this.getLatestEntry(id)
    if (!entry) return null
    return this.detectByPath(id, entry.executablePath)
  }

  /** 发送进度事件 */
  private emitProgress(p: RuntimeProgress): void {
    this.emit('progress', p)
  }

  /**
   * 安装运行时：下载压缩包 → 解压 → 验证 → 写注册表
   *
   * - Python：从 python.org 下载 embeddable zip，解压到 versions/{version}/
   * - Node.js：从 nodejs.org 下载 zip，解压后提取内部目录到 versions/{version}/
   * - Git Bash：从 git-for-windows 下载 PortableGit SFX，解压到 versions/{version}/
   *
   * 下载超时：30 分钟。全程通过 EventEmitter 'progress' 事件推送进度。
   */
  async installRuntime(id: RuntimeId, version?: string): Promise<void> {
    if (this.inflight.has(id)) {
      throw new Error(`${RUNTIME_DISPLAY[id].name} 正在处理中，请稍候`)
    }

    const meta = RUNTIME_META[id]
    const ver = version ?? meta.defaultVersion
    this.inflight.set(id, 'installing')

    let tempArchive: string | undefined

    try {
      const installPath = join(this.baseDir, meta.dirName, 'versions', ver)
      const exePath = join(installPath, meta.exeRelPath)

      // 已安装则直接验证
      if (existsSync(exePath)) {
        const detectedVersion = await this.detectByPath(id, exePath)
        if (detectedVersion) {
          this.setRegistryEntry(id, ver, {
            source: 'managed',
            executablePath: exePath,
            installPath,
            installedAt: Date.now(),
            verified: true
          })
          this.emitProgress({ id, phase: 'done', percent: 100, receivedBytes: 0, totalBytes: 0 })
          console.log(`[binary-manager] ${id} already installed (v${detectedVersion})`)
          return
        }
      }

      // 下载压缩包
      const url = meta.downloadUrlTemplate.replaceAll('{version}', ver)
      const archiveExt = meta.archiveType === 'zip' ? '.zip' : '.exe'
      tempArchive = join(tmpdir(), `kework-${id}-${ver}-${Date.now()}${archiveExt}`)
      console.log(`[binary-manager] downloading ${id} from ${url}`)
      this.emitProgress({ id, phase: 'downloading', percent: 0, receivedBytes: 0, totalBytes: 0, message: '正在下载…' })
      await this.downloadFile(url, tempArchive, (received, total) => {
        const percent = total > 0 ? Math.round((received / total) * 100) : 0
        this.emitProgress({ id, phase: 'downloading', percent, receivedBytes: received, totalBytes: total })
      })
      console.log(`[binary-manager] downloaded ${id} to ${tempArchive}`)

      // 确保安装目录存在
      if (!existsSync(installPath)) {
        mkdirSync(installPath, { recursive: true })
      }

      // 解压
      this.emitProgress({ id, phase: 'extracting', percent: 0, receivedBytes: 0, totalBytes: 0, message: '正在解压…' })
      if (meta.archiveType === 'zip') {
        await this.extractZip(tempArchive, installPath)
        // zip 内若有顶层目录（如 node-v22.22.2-win-x64），将其内容提升到 installPath
        if (meta.zipTopDir) {
          const innerDirName = meta.zipTopDir.replaceAll('{version}', ver)
          const innerDir = join(installPath, innerDirName)
          if (existsSync(innerDir)) {
            this.moveDirContentsUp(innerDir, installPath)
          }
        }
      } else if (meta.archiveType === '7z-sfx') {
        // PortableGit SFX：直接运行 -y -o"<installPath>"
        await execFileAsync(tempArchive, ['-y', `-o${installPath}`], {
          timeout: 120_000,
          windowsHide: true
        })
      }

      // 验证
      this.emitProgress({ id, phase: 'verifying', percent: 100, receivedBytes: 0, totalBytes: 0, message: '正在验证…' })
      const detectedVersion = await this.detectByPath(id, exePath)
      if (!detectedVersion) {
        throw new Error(
          `${RUNTIME_DISPLAY[id].name} 解压完成但无法验证可执行文件：${exePath}`
        )
      }

      this.setRegistryEntry(id, ver, {
        source: 'managed',
        executablePath: exePath,
        installPath,
        installedAt: Date.now(),
        verified: true
      })
      this.emitProgress({ id, phase: 'done', percent: 100, receivedBytes: 0, totalBytes: 0 })
      console.log(`[binary-manager] ${id} installed (v${detectedVersion})`)
    } catch (err) {
      this.emitProgress({ id, phase: 'error', percent: 0, receivedBytes: 0, totalBytes: 0, message: (err as Error).message })
      throw err
    } finally {
      // 清理临时文件
      if (tempArchive && existsSync(tempArchive)) {
        try { unlinkSync(tempArchive) } catch { /* 忽略 */ }
      }
      this.inflight.delete(id)
    }
  }

  /** 卸载运行时：删除版本目录 → 清注册表 */
  async uninstallRuntime(id: RuntimeId): Promise<void> {
    if (this.inflight.has(id)) {
      throw new Error(`${RUNTIME_DISPLAY[id].name} 正在处理中，请稍候`)
    }

    const entry = this.getLatestEntry(id)
    if (!entry) {
      throw new Error(`${RUNTIME_DISPLAY[id].name} 未安装`)
    }

    const installPath = entry.installPath
    if (existsSync(installPath)) {
      rmSync(installPath, { recursive: true, force: true })
      console.log(`[binary-manager] removed ${id} at ${installPath}`)
    }

    this.removeRegistryEntry(id)
  }

  /**
   * 获取运行时可执行文件路径（供 Agent 执行链路使用）
   *
   * 仅当运行时已安装且开关开启时返回路径，否则返回 null。
   */
  getExecutablePath(id: RuntimeId): string | null {
    const runtimeEnabled = this.settingsStore.get('runtime.enabled') === true
    if (!runtimeEnabled) return null

    const subKey = `runtime.${id}.enabled` as `runtime.${RuntimeId}.enabled`
    if (this.settingsStore.get(subKey) === false) return null

    const entry = this.getLatestEntry(id)
    if (!entry || !entry.verified) return null
    return entry.executablePath
  }

  // ── 下载与解压 ──

  /**
   * 下载文件（自动跟随 301/302 重定向）
   *
   * 使用 Node.js 内置 https 模块，流式写入目标文件。
   */
  /**
   * 下载文件（自动跟随 301/302 重定向，流式写入，带进度回调和 30 分钟超时）
   *
   * @param onProgress 进度回调：(已接收字节, 总字节)
   */
  private downloadFile(
    url: string,
    destPath: string,
    onProgress?: (receivedBytes: number, totalBytes: number) => void
  ): Promise<void> {
    /** 30 分钟超时 */
    const TIMEOUT_MS = 30 * 60 * 1000

    return new Promise((resolve, reject) => {
      const overallTimer = setTimeout(() => {
        reject(new Error('下载超时（30 分钟未完成）'))
      }, TIMEOUT_MS)

      const cleanup = (): void => clearTimeout(overallTimer)

      const attempt = (currentUrl: string, redirectCount: number): void => {
        if (redirectCount > 5) {
          cleanup()
          reject(new Error('下载重定向次数过多'))
          return
        }

        const req = https.get(currentUrl, { timeout: 30_000 }, (res) => {
          // 重定向
          if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
            const location = res.headers.location
            if (location) {
              res.resume()
              attempt(location, redirectCount + 1)
              return
            }
          }

          if (res.statusCode && res.statusCode >= 400) {
            res.resume()
            cleanup()
            reject(new Error(`下载失败，HTTP ${res.statusCode}`))
            return
          }

          const totalBytes = parseInt(res.headers['content-length'] ?? '0', 10) || 0
          let receivedBytes = 0

          const stream = createWriteStream(destPath)
          res.on('data', (chunk: Buffer) => {
            receivedBytes += chunk.length
            if (onProgress) onProgress(receivedBytes, totalBytes)
          })
          res.pipe(stream)
          stream.on('finish', () => {
            stream.close()
            cleanup()
            resolve()
          })
          stream.on('error', (err) => {
            cleanup()
            reject(new Error(`写入文件失败：${err.message}`))
          })
        })

        req.on('error', (err) => {
          cleanup()
          reject(new Error(`下载请求失败：${err.message}`))
        })

        req.on('timeout', () => {
          req.destroy()
          cleanup()
          reject(new Error('连接超时'))
        })
      }

      attempt(url, 0)
    })
  }

  /**
   * 解压 zip 文件到目标目录（使用 PowerShell Expand-Archive）
   */
  private async extractZip(zipPath: string, destPath: string): Promise<void> {
    const psScript = `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destPath}' -Force`
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', psScript
    ], { timeout: 120_000, windowsHide: true })
  }

  /**
   * 将子目录内的所有内容移动到父目录（合并）
   *
   * 用于 Node.js zip 解压后，将 node-v{version}-win-x64/ 内的内容提升到 installPath。
   */
  private moveDirContentsUp(srcDir: string, destDir: string): void {
    const entries = readdirSync(srcDir, { withFileTypes: true })
    for (const entry of entries) {
      renameSync(join(srcDir, entry.name), join(destDir, entry.name))
    }
    // 删除空目录
    try { rmSync(srcDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }

  // ── 内部方法 ──

  /** 从注册表获取指定运行时的最新版本记录 */
  private getLatestEntry(id: RuntimeId): RegistryEntry | null {
    const versions = this.registry.binaries[RUNTIME_META[id].dirName]
    if (!versions) return null
    const keys = Object.keys(versions)
    if (keys.length === 0) return null
    // 取 installedAt 最新的
    let latest: RegistryEntry | null = null
    let latestTime = 0
    for (const [, entry] of Object.entries(versions)) {
      if (entry.installedAt > latestTime) {
        latestTime = entry.installedAt
        latest = entry
      }
    }
    return latest
  }

  /** 从注册表 key 提取版本号 */
  private extractVersionFromRegistryKey(id: RuntimeId): string | undefined {
    const versions = this.registry.binaries[RUNTIME_META[id].dirName]
    if (!versions) return undefined
    const keys = Object.keys(versions)
    if (keys.length === 0) return undefined
    let latest = keys[0]
    let latestTime = 0
    for (const key of keys) {
      if (versions[key].installedAt > latestTime) {
        latestTime = versions[key].installedAt
        latest = key
      }
    }
    return latest
  }

  /** spawn 调用可执行文件获取版本号 */
  private async detectByPath(id: RuntimeId, exePath: string): Promise<string | null> {
    const meta = RUNTIME_META[id]
    if (!existsSync(exePath)) return null
    try {
      const { stdout } = await execFileAsync(exePath, meta.versionArgs, {
        timeout: 10_000,
        windowsHide: true
      })
      const output = stdout.trim()
      const match = output.match(meta.versionRegex)
      return match ? match[meta.versionGroup] : null
    } catch {
      return null
    }
  }

  // ── 注册表读写 ──

  private loadRegistry(): Registry {
    if (!existsSync(this.registryPath)) {
      return { version: 1, lastUpdated: 0, binaries: {} }
    }
    try {
      const raw = readFileSync(this.registryPath, 'utf-8')
      const data = JSON.parse(raw) as Registry
      if (!data.binaries) data.binaries = {}
      return data
    } catch (err) {
      console.warn('[binary-manager] failed to load registry, starting fresh:', err)
      return { version: 1, lastUpdated: 0, binaries: {} }
    }
  }

  private saveRegistry(): void {
    this.registry.lastUpdated = Date.now()
    const data = JSON.stringify(this.registry, null, 2)
    writeFileSync(this.registryPath, data, 'utf-8')
  }

  private setRegistryEntry(id: RuntimeId, version: string, entry: RegistryEntry): void {
    const dirName = RUNTIME_META[id].dirName
    if (!this.registry.binaries[dirName]) {
      this.registry.binaries[dirName] = {}
    }
    this.registry.binaries[dirName][version] = entry
    this.saveRegistry()
  }

  private removeRegistryEntry(id: RuntimeId): void {
    const dirName = RUNTIME_META[id].dirName
    if (!this.registry.binaries[dirName]) return
    this.registry.binaries[dirName] = {}
    this.saveRegistry()
  }
}