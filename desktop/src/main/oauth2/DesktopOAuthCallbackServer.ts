import { createServer, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { DEFAULT_SYSTEM_NAME } from '../settings/schema'

export interface CallbackResult {
  code?: string
  error?: string
}

/** HTML 文本转义（系统名称来自用户设置，拼接进页面前先转义） */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 授权回跳页（标题与文案使用当前系统名称） */
function sendHtml(
  res: ServerResponse,
  status: number,
  message: string,
  systemName: string
): void {
  const brand = escapeHtml(systemName)
  res.statusCode = status
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(
    `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8" /><title>${brand} 授权</title></head>
  <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
    <div style="text-align: center;">
      <h2>${escapeHtml(message)}</h2>
      <p>请返回 ${brand} 桌面版继续操作。</p>
    </div>
  </body>
</html>`
  )
}

/**
 * OAuth2 loopback 回调服务器。
 *
 * 只监听 127.0.0.1 随机端口，仅接受 /callback。
 * state 未设置或不匹配时仅返回 400、不结束流程，
 * 避免本机任意进程探测端口导致授权被中断（RFC 8252 §7.3）。
 */
export class DesktopOAuthCallbackServer {
  /**
   * @param getSystemName 系统名称读取器（「系统设置 → 系统标识」）；
   *   缺省回退内置默认名，便于单测直接 new 出实例。
   */
  constructor(private readonly getSystemName: () => string = () => DEFAULT_SYSTEM_NAME) {}

  private server: Server | null = null
  private port: number | null = null
  private expectedState: string | null = null
  private result: CallbackResult | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private resolveResult: ((result: CallbackResult) => void) | null = null

  async start(): Promise<void> {
    if (this.server) return

    this.server = createServer((req, res) => {
      void this.handle(req.url ?? '/', res)
    })

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => {
        const address = this.server!.address() as AddressInfo
        this.port = address.port
        resolve()
      })
    })
  }

  getRedirectUri(): string {
    if (this.port == null) throw new Error('回调服务器尚未启动')
    return `http://127.0.0.1:${this.port}/callback`
  }

  setExpectedState(state: string): void {
    this.expectedState = state
  }

  waitForCallback(timeoutMs = 5 * 60 * 1000): Promise<CallbackResult> {
    if (this.result) return Promise.resolve(this.result)
    return new Promise<CallbackResult>((resolve, reject) => {
      this.resolveResult = resolve
      this.timer = setTimeout(() => {
        reject(new Error('授权等待超时，请重试'))
        void this.stop()
      }, timeoutMs)
    })
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.server) return
    const server = this.server
    this.server = null
    this.port = null
    server.closeAllConnections?.()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }

  private settle(result: CallbackResult): void {
    if (this.result) return
    this.result = result
    this.resolveResult?.(result)
    this.resolveResult = null
    void this.stop()
  }

  /** 统一出口：拼上当前系统名称后交给 sendHtml */
  private send(res: ServerResponse, status: number, message: string): void {
    sendHtml(res, status, message, this.getSystemName())
  }

  private async handle(rawUrl: string, res: ServerResponse): Promise<void> {
    const url = new URL(rawUrl, 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      this.send(res, 404, '未找到回调地址')
      return
    }

    const state = url.searchParams.get('state')
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')

    // state 未设置或不匹配：只拒绝，不结束授权流程（防探测中断）
    if (!this.expectedState || state !== this.expectedState) {
      this.send(res, 400, '授权状态校验失败')
      return
    }

    if (error) {
      const message =
        error === 'access_denied'
          ? '已取消授权'
          : url.searchParams.get('error_description') || '授权失败'
      this.send(res, 200, message)
      this.settle({ error })
      return
    }

    if (!code) {
      this.send(res, 400, '未收到授权码')
      return
    }

    this.send(res, 200, '授权成功')
    this.settle({ code })
  }
}
