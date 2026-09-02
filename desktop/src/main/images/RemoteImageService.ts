import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Protocol } from 'electron'

/** 远程图片本地缓存协议（渲染层 CSP 的 img-src 白名单包含 ke-img:） */
export const REMOTE_IMAGE_SCHEME = 'ke-img'

/** 本地协议 URL 前缀：ke-img://img/<base64url(原始URL)> */
const LOCAL_URL_PREFIX = `${REMOTE_IMAGE_SCHEME}://img/`

/** 单张图片下载超时（毫秒） */
const DOWNLOAD_TIMEOUT_MS = 30_000

/** 单张图片大小上限（20MB，防止缓存膨胀） */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** 图片下载实现（主进程注入 Electron net，单测注入 fake） */
export type ImageFetch = (url: string, init?: RequestInit) => Promise<Response>

/**
 * 在 app ready 之前注册特权 scheme（必须在应用就绪前调用一次）。
 * standard/secure 使 ke-img:// 可被 <img> 正常解析，stream 支持流式响应。
 */
export function registerRemoteImageScheme(protocol: Protocol): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: REMOTE_IMAGE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true
      }
    }
  ])
}

/** 将原始 http(s) 图片地址编码为 ke-img://img/<base64url> 本地地址 */
export function toLocalImageUrl(originalUrl: string): string {
  return LOCAL_URL_PREFIX + Buffer.from(originalUrl, 'utf8').toString('base64url')
}

/** 从本地协议地址还原原始图片地址；非法地址返回 null */
export function fromLocalImageUrl(localUrl: string): string | null {
  if (!localUrl.startsWith(LOCAL_URL_PREFIX)) return null
  const encoded = localUrl.slice(LOCAL_URL_PREFIX.length)
  if (!encoded) return null
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return null
  }
}

/** 仅允许 http(s) 外链（拒绝 file/data 等其它协议） */
export function isHttpImageUrl(url: string): boolean {
  return /^https?:\/\/.+/i.test(url)
}

function sha256Of(url: string): string {
  return createHash('sha256').update(url).digest('hex')
}

/** 依据文件魔数嗅探图片 MIME（meta 缺失时的兜底） */
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png'
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg'
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'GIF8') {
    return 'image/gif'
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return 'image/bmp'
  }
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) {
    return 'image/x-icon'
  }
  const head = buf.subarray(0, 512).toString('latin1').trimStart().toLowerCase()
  if (head.startsWith('<svg') || head.startsWith('<?xml')) {
    return 'image/svg+xml'
  }
  return null
}

/**
 * 远程图片下载 + 落盘缓存服务。
 *
 * 背景：文档写作专家等通过 AI 图像生成 MCP 返回的 DashScope 等外链图片带有签名与有效期，
 * 直接放进 <img src> 会被渲染层 CSP（img-src 'self' data: blob:）拦截；
 * 本服务把外链下载到本地缓存，再通过 ke-img:// 特权协议输出，既满足 CSP 又规避 URL 过期。
 */
export class RemoteImageService {
  private readonly cacheDir: string
  private readonly fetchImpl: ImageFetch
  private readonly inFlight = new Map<string, Promise<string>>()
  private protocolRegistered = false

  constructor(cacheDir: string, fetchImpl: ImageFetch) {
    this.cacheDir = cacheDir
    this.fetchImpl = fetchImpl
  }

  private filePathFor(url: string): string {
    return join(this.cacheDir, `${sha256Of(url)}.img`)
  }

  private metaPathFor(url: string): string {
    return join(this.cacheDir, `${sha256Of(url)}.meta.json`)
  }

  /**
   * 解析远程图片：命中缓存直接返回本地地址；未命中则下载并落盘。
   * 并发请求同一 URL 时共享同一个下载任务。
   */
  async resolveRemoteImage(url: string): Promise<string> {
    if (!isHttpImageUrl(url)) {
      throw new Error('仅支持 http(s) 图片地址')
    }
    const localUrl = toLocalImageUrl(url)
    if (existsSync(this.filePathFor(url))) return localUrl

    const pending = this.inFlight.get(url)
    if (pending) return pending

    const task = this.download(url)
      .then(() => localUrl)
      .finally(() => {
        this.inFlight.delete(url)
      })
    this.inFlight.set(url, task)
    return task
  }

  private async download(url: string): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal })
      if (!response.ok) {
        throw new Error(`图片下载失败（HTTP ${response.status}）`)
      }
      const contentType = response.headers.get('content-type') ?? ''
      const mime = contentType.split(';')[0].trim().toLowerCase()
      if (mime && !mime.startsWith('image/')) {
        throw new Error(`非图片内容：${mime}`)
      }
      const declaredLength = Number(response.headers.get('content-length') ?? '0')
      if (declaredLength > MAX_IMAGE_BYTES) {
        throw new Error('图片超过大小上限')
      }
      const buf = Buffer.from(await response.arrayBuffer())
      if (buf.length === 0) {
        throw new Error('图片内容为空')
      }
      if (buf.length > MAX_IMAGE_BYTES) {
        throw new Error('图片超过大小上限')
      }
      mkdirSync(this.cacheDir, { recursive: true })
      const hash = sha256Of(url)
      const tmpPath = join(this.cacheDir, `.${hash}.${Date.now()}.tmp`)
      writeFileSync(tmpPath, buf)
      renameSync(tmpPath, this.filePathFor(url))
      const sniffed = sniffImageMime(buf)
      writeFileSync(
        this.metaPathFor(url),
        JSON.stringify({ url, mime: sniffed ?? (mime || 'image/png'), size: buf.length }),
        'utf8'
      )
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('图片下载超时')
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  /** 注册 ke-img:// 协议处理：按本地地址还原原始 URL，未缓存则先下载再回源 */
  registerProtocol(protocol: Protocol): void {
    if (this.protocolRegistered) return
    this.protocolRegistered = true
    protocol.handle(REMOTE_IMAGE_SCHEME, async (request) => {
      try {
        const original = fromLocalImageUrl(request.url)
        if (!original) return new Response('bad request', { status: 400 })
        await this.resolveRemoteImage(original)
        const file = this.filePathFor(original)
        if (!existsSync(file)) return new Response('not found', { status: 404 })
        const buf = readFileSync(file)
        return new Response(new Uint8Array(buf), {
          headers: {
            'content-type': this.readMime(original),
            'cache-control': 'public, max-age=31536000, immutable'
          }
        })
      } catch (err) {
        console.warn('[remote-image] 图片协议处理失败：', request.url, err)
        return new Response('image unavailable', { status: 502 })
      }
    })
  }

  private readMime(url: string): string {
    try {
      const meta = JSON.parse(readFileSync(this.metaPathFor(url), 'utf8')) as { mime?: string }
      if (typeof meta.mime === 'string' && meta.mime) return meta.mime
    } catch {
      // 旧缓存缺少 meta 时走魔数嗅探
    }
    try {
      const sniffed = sniffImageMime(readFileSync(this.filePathFor(url)))
      if (sniffed) return sniffed
    } catch {
      // 忽略
    }
    return 'application/octet-stream'
  }
}
