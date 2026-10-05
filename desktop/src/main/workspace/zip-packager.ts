import { existsSync, readdirSync, statSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { zip } from 'fflate'
import { HIDDEN_NAMES, resolveInside } from './path-guard'

/**
 * 工作空间打包导出（R8-7：自 WorkspaceService 外提；R8-7c 补齐异步压缩与上限）。
 *
 * 调用方先解析工作空间（id/user → rootDir）再进本模块；路径 containment 由
 * PathGuard 负责。
 * - **异步压缩**：fflate 的 async `zip()` 在 Node/Electron 主进程经 worker_threads
 *   执行（主事件循环零阻塞；输出仍为 classic zip，条目尺寸在中央目录前可知）；
 * - **条目/体积上限**：收集阶段即时计数，超限立刻报错——防大目录在压缩前的
 *   读取阶段就把主进程内存拖垮（上限值为暂定口径，见常量注释）。
 */

/** 打包上限（暂定口径，可按产品反馈调整）：条目数与压缩前总字节 */
const MAX_ZIP_ENTRIES = 5000
const MAX_ZIP_TOTAL_BYTES = 1024 * 1024 * 1024

/** 打包导出结果（zip 落在工作空间根目录内） */
export interface WorkspaceZipExport {
  relPath: string
  absPath: string
  entries: number
  size: number
}

/** 收集预算：累计条目与字节，超限即抛（防大目录把内存拖垮） */
interface ZipBudget {
  entries: number
  bytes: number
}

function assertBudget(budget: ZipBudget): void {
  if (budget.entries > MAX_ZIP_ENTRIES || budget.bytes > MAX_ZIP_TOTAL_BYTES) {
    throw new Error('打包内容超出上限（条目 ≤ 5000 / 总量 ≤ 1GB），请分批导出')
  }
}

export class ZipPackager {
  /**
   * 打包导出为 zip（写入工作空间根目录，返回相对/绝对路径）。
   *
   * 典型用法：把「文章 + 同名配图目录」或整个交付目录打包下载。
   * @throws 路径越界 / 没有可打包内容时抛错
   */
  async exportZip(input: {
    rootDir: string
    relPaths: string[]
    zipName?: string
    destAbsPath?: string
  }): Promise<WorkspaceZipExport> {
    const { rootDir: wsDir } = input
    const inputs = (Array.isArray(input.relPaths) ? input.relPaths : []).filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0
    )
    if (!inputs.length) throw new Error('没有可打包的文件')

    const files: Record<string, Uint8Array> = {}
    const budget: ZipBudget = { entries: 0, bytes: 0 }
    for (const relPath of inputs) {
      const target = resolveInside(wsDir, relPath)
      if (!existsSync(target)) continue
      const stat = statSync(target)
      if (stat.isDirectory()) {
        const base = relPath.replace(/\/+$/, '')
        await this.collectZipEntries(target, base, files, budget)
      } else if (stat.isFile()) {
        const data = await readFile(target)
        files[relPath] = data
        budget.entries += 1
        budget.bytes += data.length
        assertBudget(budget)
      }
    }
    if (budget.entries === 0) throw new Error('没有可打包的文件')

    // 异步压缩：worker_threads 执行，主进程事件循环零阻塞
    const buffer = await zipAsync(files)
    const baseName = this.suggestZipName(inputs, input.zipName).replace(/\.zip$/i, '')

    let absZip: string
    let relZip = ''
    if (input.destAbsPath) {
      // 系统「另存为」指定位置：写入用户选择的路径（不在工作空间内时 relPath 为空串）
      if (!isAbsolute(input.destAbsPath)) throw new Error('导出路径必须为绝对路径')
      absZip = resolve(input.destAbsPath)
      await mkdir(dirname(absZip), { recursive: true })
      await writeFile(absZip, buffer)
      const root = resolve(wsDir)
      if (absZip.startsWith(root + sep)) {
        relZip = relative(root, absZip).split(sep).join('/')
      }
    } else {
      relZip = this.uniqueZipPath(wsDir, baseName)
      absZip = resolve(wsDir, relZip)
      await writeFile(absZip, buffer)
    }

    console.log('[workspace] exported zip: ' + absZip + ' (' + budget.entries + ' entries)')
    return { relPath: relZip, absPath: absZip, entries: budget.entries, size: buffer.length }
  }

  /** 生成建议的 zip 文件名（含 .zip 后缀）：另存为默认名与工作空间内导出名共用 */
  suggestZipName(relPaths: string[], zipName?: string): string {
    const inputs = (Array.isArray(relPaths) ? relPaths : []).filter(
      (item) => typeof item === 'string' && item.trim().length > 0
    )
    const base = this.sanitizeZipName(
      zipName || this.defaultZipName(inputs.length > 0 ? inputs : ['交付物'])
    )
    return base + '.zip'
  }

  /** 递归收集目录内文件到 zip 条目表（跳过隐藏/依赖目录；超限即抛） */
  private async collectZipEntries(
    dir: string,
    zipBase: string,
    files: Record<string, Uint8Array>,
    budget: ZipBudget
  ): Promise<void> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (HIDDEN_NAMES.has(entry.name)) continue
      const child = join(dir, entry.name)
      if (entry.isDirectory()) {
        await this.collectZipEntries(child, zipBase + '/' + entry.name, files, budget)
      } else if (entry.isFile()) {
        const data = await readFile(child)
        files[zipBase + '/' + entry.name] = data
        budget.entries += 1
        budget.bytes += data.length
        assertBudget(budget)
      }
    }
  }

  /** 生成不与现有文件冲突的 zip 相对路径（同名追加 -1、-2） */
  private uniqueZipPath(root: string, baseName: string): string {
    for (let index = 0; index < 100; index += 1) {
      const candidate = index === 0 ? baseName + '.zip' : baseName + '-' + index + '.zip'
      if (!existsSync(join(root, candidate))) return candidate
    }
    throw new Error('同名导出文件过多，请先清理后重试')
  }

  /** 取 zip 文件名（去掉 Windows 非法字符与 .zip 后缀） */
  private sanitizeZipName(raw: string): string {
    const cleaned = raw
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\.zip$/i, '')
      .trim()
    return cleaned || '交付物'
  }

  /** 依据首个输入推导默认 zip 名（文章.md + 文章/ → 文章） */
  private defaultZipName(relPaths: string[]): string {
    const first = relPaths[0].replace(/\/+$/, '')
    const name = first.split('/').pop() ?? '交付物'
    return name.replace(/\.[^.]+$/, '') || name
  }
}

/** 异步压缩（fflate node 构建经 worker_threads 执行；输出仍为 classic zip） */
function zipAsync(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files, (err, data) => {
      if (err) reject(err)
      else resolve(data)
    })
  })
}
