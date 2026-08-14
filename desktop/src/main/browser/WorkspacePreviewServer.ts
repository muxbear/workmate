import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { createReadStream, promises as fsPromises } from 'fs'
import { extname, resolve, sep } from 'path'
import { randomBytes } from 'crypto'
import type { AddressInfo } from 'net'

/** 单个工作空间预览授权：token 绑定到已校验的工作空间根目录。 */
interface WorkspaceGrant {
  workspaceId: string
  root: string
}

/** 浏览器预览可识别的 MIME；只覆盖工作空间网页及其常见静态子资源。 */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
}

function resolveInside(root: string, relPath: string): string {
  const rootResolved = resolve(root)
  const target = resolve(rootResolved, relPath)
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
    throw new Error('路径越界')
  }
  return target
}

function sendText(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end(message)
}

function parseRange(value: string | undefined, total: number): { start: number; end: number } | null {
  if (!value || total <= 0) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!match) return null

  let start: number
  let end: number

  if (match[1] === '' && match[2] !== '') {
    const suffix = Number(match[2])
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, total - suffix)
    end = total - 1
  } else {
    start = match[1] === '' ? 0 : Number(match[1])
    end = match[2] === '' ? total - 1 : Number(match[2])
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start < 0 || end < start || start >= total) return null
  return { start, end: Math.min(end, total - 1) }
}

/**
 * 工作空间浏览器预览服务器。
 *
 * 只监听 127.0.0.1 随机端口，页面通过随机 token 访问。请求到达后再校验真实路径，
 * 防止 `..`、绝对路径和符号链接逃逸。
 */
export class WorkspacePreviewServer {
  private server: Server | null = null
  private port: number | null = null
  private readonly grants = new Map<string, WorkspaceGrant>()

  async start(): Promise<void> {
    if (this.server) return

    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        console.error('[workspace-preview] request failed:', error)
        if (!res.headersSent) {
          sendText(res, 500, '内部错误')
        } else {
          res.end()
        }
      })
    })

    await new Promise<void>((resolvePromise, rejectPromise) => {
      this.server!.once('error', rejectPromise)
      this.server!.listen(0, '127.0.0.1', () => {
        const address = this.server!.address() as AddressInfo
        this.port = address.port
        resolvePromise()
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    const server = this.server
    this.server = null
    this.port = null
    this.grants.clear()
    server.closeAllConnections?.()
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.close((error) => (error ? rejectPromise(error) : resolvePromise()))
    })
  }

  getPort(): number {
    if (this.port == null) throw new Error('预览服务器尚未启动')
    return this.port
  }

  async createGrant(workspaceId: string, rootDir: string): Promise<string> {
    await this.start()
    const token = randomBytes(24).toString('hex')
    this.grants.set(token, { workspaceId, root: resolve(rootDir) })
    return token
  }

  revokeToken(token: string): void {
    this.grants.delete(token)
    if (this.grants.size === 0) {
      void this.stop()
    }
  }

  revokeByWorkspace(workspaceId: string): void {
    for (const [token, grant] of this.grants) {
      if (grant.workspaceId === workspaceId) {
        this.grants.delete(token)
      }
    }
    if (this.grants.size === 0) {
      void this.stop()
    }
  }

  revokeAll(): void {
    this.grants.clear()
    void this.stop()
  }

  async preview(
    workspaceId: string,
    relPath: string,
    rootDir: string,
    filePath: string
  ): Promise<{ displayUrl: string; loadUrl: string; filePath: string }> {
    // 同一工作空间只保留最新授权，避免切换文件时旧 token 泄漏。
    this.revokeByWorkspace(workspaceId)
    const token = await this.createGrant(workspaceId, rootDir)
    const encodedPath = relPath
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/')
    return {
      displayUrl: `workspace://${workspaceId}/${relPath}`,
      loadUrl: `http://127.0.0.1:${this.getPort()}/${token}/${encodedPath}`,
      filePath
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const encodedSegments = url.pathname.split('/').filter(Boolean)
    if (encodedSegments.length < 2) {
      sendText(res, 400, '无效预览地址')
      return
    }

    const token = encodedSegments[0]
    const grant = this.grants.get(token)
    if (!grant) {
      sendText(res, 404, '预览已失效')
      return
    }

    let relPath: string
    try {
      relPath = encodedSegments.slice(1).map((segment) => decodeURIComponent(segment)).join('/')
    } catch {
      sendText(res, 400, '无效路径编码')
      return
    }

    const target = resolveInside(grant.root, relPath)
    const realRoot = await fsPromises.realpath(grant.root)
    let realTarget: string
    try {
      realTarget = await fsPromises.realpath(target)
    } catch {
      sendText(res, 404, '文件不存在')
      return
    }

    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      sendText(res, 403, '禁止访问')
      return
    }

    let stat = await fsPromises.stat(realTarget)
    if (stat.isDirectory()) {
      const indexPath = resolveInside(grant.root, [relPath, 'index.html'].filter(Boolean).join('/'))
      const indexRealPath = await fsPromises.realpath(indexPath).catch(() => null)
      if (
        indexRealPath &&
        (indexRealPath === realRoot || indexRealPath.startsWith(realRoot + sep))
      ) {
        realTarget = indexRealPath
        stat = await fsPromises.stat(realTarget)
      } else {
        sendText(res, 404, '文件不存在')
        return
      }
    }

    if (!stat.isFile()) {
      sendText(res, 404, '文件不存在')
      return
    }

    await this.serveFile(req, res, realTarget, stat.size)
  }

  private async serveFile(
    req: IncomingMessage,
    res: ServerResponse,
    filePath: string,
    size: number
  ): Promise<void> {
    const mime = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    res.setHeader('Content-Type', mime)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Accept-Ranges', 'bytes')

    const range = parseRange(req.headers.range, size)
    if (range) {
      const length = range.end - range.start + 1
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
      res.setHeader('Content-Length', length)
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      createReadStream(filePath, { start: range.start, end: range.end }).pipe(res)
      return
    }

    res.statusCode = 200
    res.setHeader('Content-Length', size)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(filePath).pipe(res)
  }
}
