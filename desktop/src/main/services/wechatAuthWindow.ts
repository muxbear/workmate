import type { BrowserWindow } from 'electron'

/**
 * 微信扫码登录：主进程授权窗口流程。
 *
 * 渲染层负责拼授权 URL（appid/redirect_uri 来自构建期环境变量），本模块收口窗口生命周期：
 * 打开授权页 → 拦截回跳到 redirectUri 的导航 → 提取 code 返回；
 * 用户关闭窗口 / 超时 / 导航失败都以 error 返回，渲染层统一提示。
 */

/** 授权窗口整体超时（用户长时间不扫码时归还控制权） */
const AUTH_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 判断导航目标是否为约定的回跳地址，是则返回其 code 参数。
 *
 * 只比较 origin + pathname：微信会在回跳地址后追加 `?code=...&state=...`（或 error 参数）。
 * 纯函数，供单测直接覆盖；无法解析的 URL 一律返回 null。
 */
export function extractWeChatCode(navigatedUrl: string, redirectUri: string): string | null {
  let target: URL
  let expected: URL
  try {
    target = new URL(navigatedUrl)
    expected = new URL(redirectUri)
  } catch {
    return null
  }
  if (target.origin !== expected.origin || target.pathname !== expected.pathname) return null
  return target.searchParams.get('code')
}

/** 打开微信授权窗口；返回 code（成功）或 error（取消 / 超时 / 打开失败） */
export async function openWeChatAuthWindow(
  authUrl: string,
  redirectUri: string
): Promise<{ code?: string; error?: string }> {
  // 动态取 Electron 的 BrowserWindow：模块顶层保持 type-only 导入，便于纯 Node 单测加载本文件
  const { BrowserWindow: BrowserWindowCtor } = await import('electron')
  return new Promise((resolve) => {
    let settled = false
    let win: BrowserWindow | null = null
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (result: { code?: string; error?: string }): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (win && !win.isDestroyed()) win.close()
      resolve(result)
    }

    // 入参校验：授权地址必须是 https（外链页面，不走内嵌特权）
    try {
      const parsed = new URL(authUrl)
      new URL(redirectUri)
      if (parsed.protocol !== 'https:') return finish({ error: '授权地址必须以 https:// 开头' })
    } catch {
      return finish({ error: '授权地址无效' })
    }

    timer = setTimeout(() => finish({ error: '微信授权超时，请重试' }), AUTH_TIMEOUT_MS)

    win = new BrowserWindowCtor({
      width: 480,
      height: 720,
      show: true,
      autoHideMenuBar: true,
      title: '微信授权',
      webPreferences: { sandbox: true }
    })

    // 授权页内的链接（帮助 / 协议等）不新开窗口，避免游离窗口收不到回调
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const onNavigate = (_event: unknown, url: string): void => {
      const code = extractWeChatCode(url, redirectUri)
      if (code) finish({ code })
    }
    win.webContents.on('did-redirect-navigation', onNavigate)
    win.webContents.on('did-navigate', onNavigate)
    win.on('closed', () => finish({ error: '已取消微信授权' }))
    win.loadURL(authUrl).catch(() => finish({ error: '无法打开微信授权页' }))
  })
}
