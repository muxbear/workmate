import { session as electronSession } from 'electron'

/**
 * 主进程出网代理解析（axios 不走 Electron session，必须显式传给请求库）。
 *
 * - `direct`：直连；
 * - `manual`：用「设置 → 网络 → 代理地址」；
 * - `system`：问 Chromium（`session.resolveProxy`）要该目标的代理规则，
 *   解析 `PROXY host:port` 形态；`DIRECT` 或解析不出时直连。
 *
 * 返回 axios 的 `proxy` 配置形态；undefined = 不使用代理。
 */
export interface MainProxyConfig {
  host: string
  port: number
  protocol: 'http' | 'https'
}

export async function resolveMainProxy(
  targetUrl: string,
  mode: string,
  manualUrl: string
): Promise<MainProxyConfig | undefined> {
  if (mode === 'direct') return undefined
  if (mode === 'manual') return parseManualProxyUrl(manualUrl)
  try {
    return parseProxyRule(await electronSession.defaultSession.resolveProxy(targetUrl))
  } catch (err) {
    console.warn('[network] resolveProxy 失败，按直连处理：', err)
    return undefined
  }
}

/** 解析 `PROXY host:port` / `HTTPS host:port` / `SOCKS5 host:port`；DIRECT 返回 undefined */
export function parseProxyRule(rule: string): MainProxyConfig | undefined {
  const trimmed = String(rule ?? '').trim()
  if (!trimmed || /^direct\b/i.test(trimmed)) return undefined
  const match = /(?:PROXY|HTTPS?|SOCKS5?)\s+([^:\s]+):(\d{1,5})/i.exec(trimmed)
  if (!match) return undefined
  const port = Number(match[2])
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  return { host: match[1], port, protocol: 'http' }
}

/** 「设置 → 网络」的手填代理地址（`http://host:port`）解析；非法返回 undefined */
export function parseManualProxyUrl(url: string): MainProxyConfig | undefined {
  try {
    const parsed = new URL(String(url ?? '').trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
    if (!parsed.hostname) return undefined
    return {
      host: parsed.hostname,
      port,
      protocol: parsed.protocol === 'https:' ? 'https' : 'http'
    }
  } catch {
    return undefined
  }
}
