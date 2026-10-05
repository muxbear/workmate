import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/**
 * 运行时包解压策略（R8-9：自 BinaryManager 外提，行为保持）。
 * 新增归档格式 = 加一个策略 + 在 EXTRACTORS 登记（BinaryManager 按 meta.archiveType 取用）。
 */

export interface BinaryExtractor {
  extract(archivePath: string, destDir: string): Promise<void>
}

/** zip：PowerShell Expand-Archive（系统自带，避免引入解压依赖） */
const zipExtractor: BinaryExtractor = {
  async extract(zipPath, destPath) {
    const psScript = `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destPath}' -Force`
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      timeout: 120_000,
      windowsHide: true
    })
  }
}

/** 7z-sfx（PortableGit 自解压包）：直接运行 -y -o"<installPath>" */
const sevenZipSfxExtractor: BinaryExtractor = {
  async extract(archivePath, destPath) {
    await execFileAsync(archivePath, ['-y', `-o${destPath}`], {
      timeout: 120_000,
      windowsHide: true
    })
  }
}

/** archiveType → 解压策略 */
export const EXTRACTORS: Record<'zip' | '7z-sfx', BinaryExtractor> = {
  zip: zipExtractor,
  '7z-sfx': sevenZipSfxExtractor
}
