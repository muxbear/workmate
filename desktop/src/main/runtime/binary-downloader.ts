import { createHash } from 'crypto'
import { createReadStream, createWriteStream, unlinkSync } from 'fs'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'http'
import https from 'https'

/**
 * 运行时包下载器（R8-9：自 BinaryManager 外提，行为保持）。
 *
 * - 自动跟随 301/302/303/307/308 重定向（上限 5 跳）；
 * - 流式写入目标文件 + 进度回调；整体 30 分钟超时、连接 30 秒超时；
 * - **sha256 校验接缝**：expectedSha256 提供时在落盘后流式校验，失败即删除并报错。
 *   当前三个运行时来源未内置官方哈希（待供应链侧提供口径后传入），故无调用方传值。
 */

export interface DownloadProgress {
  receivedBytes: number
  totalBytes: number
}

/** https.get 的注入口（测试注入假实现；默认 node:https） */
export type HttpsGetLike = (
  url: string,
  options: RequestOptions,
  callback: (res: IncomingMessage) => void
) => ClientRequest

export interface DownloadOptions {
  onProgress?: (progress: DownloadProgress) => void
  /** 期望的 sha256（hex，小写）；提供时校验，不匹配则删除文件并报错 */
  expectedSha256?: string
  /** 测试注入；默认 node:https 的 https.get */
  httpsGet?: HttpsGetLike
}

/** 流式计算文件 sha256（hex） */
function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * 下载文件（自动跟随 301/302 重定向，流式写入，带进度回调和 30 分钟超时）
 */
export function downloadFile(
  url: string,
  destPath: string,
  options: DownloadOptions = {}
): Promise<void> {
  const get = options.httpsGet ?? https.get
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

      const req = get(currentUrl, { timeout: 30_000 }, (res) => {
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

        const totalBytes = parseInt(String(res.headers['content-length'] ?? '0'), 10) || 0
        let receivedBytes = 0

        const stream = createWriteStream(destPath)
        res.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length
          options.onProgress?.({ receivedBytes, totalBytes })
        })
        res.pipe(stream)
        stream.on('finish', () => {
          stream.close()
          cleanup()
          if (options.expectedSha256) {
            void sha256OfFile(destPath)
              .then((actual) => {
                if (actual !== options.expectedSha256!.toLowerCase()) {
                  try {
                    unlinkSync(destPath)
                  } catch {
                    /* 忽略 */
                  }
                  reject(new Error('下载包 sha256 校验失败'))
                  return
                }
                resolve()
              })
              .catch((err) => reject(err instanceof Error ? err : new Error(String(err))))
            return
          }
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
