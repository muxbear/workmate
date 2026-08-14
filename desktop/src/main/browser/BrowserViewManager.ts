import { app, BrowserWindow, dialog, session, shell, WebContentsView } from 'electron'
import { join } from 'path'
import type { DownloadItem } from 'electron'
import type { WorkspacePreviewServer } from './WorkspacePreviewServer'

export const BROWSER_PARTITION = 'persist:ke-work-browser'

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserState {
  displayUrl: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
}

type BrowserSource =
  | { type: 'external'; url: string }
  | {
      type: 'workspace'
      workspaceId: string
      relPath: string
      displayUrl: string
      loadUrl: string
      filePath: string
    }

export function isAllowedExternalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 单窗口浏览器内核管理器。
 *
 * 渲染层只负责提供宿主边界和导航指令；WebContentsView、会话、权限、
 * 下载和外部打开全部由主进程控制。
 */
export class BrowserViewManager {
  private view: WebContentsView | null = null
  private source: BrowserSource | null = null

  constructor(
    private readonly win: BrowserWindow,
    private readonly previewServer: WorkspacePreviewServer
  ) {}

  ensureView(): WebContentsView {
    if (this.view) return this.view

    const browserSession = session.fromPartition(BROWSER_PARTITION)
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        devTools: !app.isPackaged
      }
    })

    view.setBackgroundColor('#ffffff')
    this.win.contentView.addChildView(view)
    view.setVisible(false)

    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) {
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })

    view.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedExternalUrl(url)) {
        event.preventDefault()
      }
    })

    view.webContents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })

    browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === 'clipboard-sanitized-write')
    })
    browserSession.setPermissionCheckHandler(
      (_webContents, permission) => permission === 'clipboard-sanitized-write'
    )

    browserSession.on('will-download', (_event, item) => {
      void this.handleDownload(item)
    })

    view.webContents.on('did-start-loading', () => this.pushState())
    view.webContents.on('did-stop-loading', () => this.pushState())
    view.webContents.on('did-navigate-in-page', () => this.pushState())
    view.webContents.on('did-navigate', (_event, url) => {
      if (this.source?.type === 'workspace') {
        try {
          const previewOrigin = `http://127.0.0.1:${this.previewServer.getPort()}/`
          if (!url.startsWith(previewOrigin) && isAllowedExternalUrl(url)) {
            this.source = { type: 'external', url }
          }
        } catch {
          if (isAllowedExternalUrl(url)) {
            this.source = { type: 'external', url }
          }
        }
      } else if (isAllowedExternalUrl(url)) {
        this.source = { type: 'external', url }
      }
      this.pushState()
    })

    view.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (isMainFrame && errorCode !== -3) {
          this.emitError(errorDescription || `页面加载失败：${validatedURL}`)
        }
      }
    )

    view.webContents.on('render-process-gone', (_event, details) => {
      console.error('[browser] renderer process gone:', details.reason)
      this.emitError('浏览器页面已崩溃，请重新加载')
      this.destroyView()
      this.source = null
    })

    this.view = view
    return view
  }

  setBounds(input: BrowserBounds): void {
    const view = this.ensureView()
    const [contentWidth, contentHeight] = this.win.getContentSize()

    const x = Math.max(0, Math.round(Number(input.x) || 0))
    const y = Math.max(0, Math.round(Number(input.y) || 0))
    const requestedWidth = Math.round(Number(input.width) || 0)
    const requestedHeight = Math.round(Number(input.height) || 0)
    const width = Math.max(0, Math.min(requestedWidth, contentWidth - x))
    const height = Math.max(0, Math.min(requestedHeight, contentHeight - y))

    view.setBounds({ x, y, width, height })
  }

  setVisible(visible: boolean): void {
    const view = this.ensureView()
    view.setVisible(visible)
    if (visible) {
      view.webContents.focus()
    }
  }

  async navigate(rawUrl: string): Promise<void> {
    if (!isAllowedExternalUrl(rawUrl)) {
      throw new Error('仅支持 http/https 地址')
    }
    const view = this.ensureView()
    this.source = { type: 'external', url: rawUrl }
    await view.webContents.loadURL(rawUrl)
  }

  async openWorkspaceFile(
    workspaceId: string,
    relPath: string,
    rootDir: string,
    filePath: string
  ): Promise<{ displayUrl: string }> {
    const preview = await this.previewServer.preview(workspaceId, relPath, rootDir, filePath)
    this.source = {
      type: 'workspace',
      workspaceId,
      relPath,
      displayUrl: preview.displayUrl,
      loadUrl: preview.loadUrl,
      filePath: preview.filePath
    }
    const view = this.ensureView()
    await view.webContents.loadURL(preview.loadUrl)
    return { displayUrl: preview.displayUrl }
  }

  back(): void {
    const view = this.ensureView()
    if (view.webContents.navigationHistory.canGoBack()) {
      view.webContents.goBack()
    }
  }

  forward(): void {
    const view = this.ensureView()
    if (view.webContents.navigationHistory.canGoForward()) {
      view.webContents.goForward()
    }
  }

  reload(): void {
    this.ensureView().webContents.reload()
  }

  stop(): void {
    this.ensureView().webContents.stop()
  }

  async openExternalCurrent(): Promise<void> {
    if (!this.source) throw new Error('当前没有可打开的页面')

    if (this.source.type === 'workspace') {
      const error = await shell.openPath(this.source.filePath)
      if (error) throw new Error(error)
      return
    }

    if (!isAllowedExternalUrl(this.source.url)) {
      throw new Error('当前页面不支持外部打开')
    }
    await shell.openExternal(this.source.url)
  }

  getState(): BrowserState {
    const view = this.view
    const displayUrl =
      this.source?.type === 'workspace'
        ? this.source.displayUrl
        : this.source?.url ?? view?.webContents.getURL() ?? ''
    return {
      displayUrl,
      canGoBack: view?.webContents.navigationHistory.canGoBack() ?? false,
      canGoForward: view?.webContents.navigationHistory.canGoForward() ?? false,
      isLoading: view?.webContents.isLoading() ?? false
    }
  }

  resetForLogout(): void {
    this.setVisible(false)
    if (this.view) {
      this.view.webContents.stop()
    }
    this.source = null
  }

  destroy(): void {
    if (this.win.isDestroyed()) {
      // 窗口关闭后原生子视图已随窗口销毁，这里只丢弃引用。
      this.view = null
    } else {
      this.destroyView()
    }
    this.source = null
  }

  private destroyView(): void {
    if (!this.view) return
    const view = this.view
    this.view = null
    try {
      if (!this.win.isDestroyed()) {
        this.win.contentView.removeChildView(view)
      }
    } catch (error) {
      console.error('[browser] remove child view failed:', error)
    }
    try {
      if (!view.webContents.isDestroyed()) {
        view.webContents.close()
      }
    } catch (error) {
      console.error('[browser] close webContents failed:', error)
    }
  }

  private pushState(): void {
    try {
      this.win.webContents.send('browser:state-changed', this.getState())
    } catch (error) {
      console.error('[browser] push state failed:', error)
    }
  }

  private emitError(message: string): void {
    try {
      this.win.webContents.send('browser:load-error', message)
    } catch (error) {
      console.error('[browser] push error failed:', error)
    }
  }

  private async handleDownload(item: DownloadItem): Promise<void> {
    try {
      const result = await dialog.showSaveDialog(this.win, {
        defaultPath: join(app.getPath('downloads'), item.getFilename())
      })
      if (result.canceled || !result.filePath) {
        item.cancel()
      } else {
        item.setSavePath(result.filePath)
      }
    } catch (error) {
      console.error('[browser] handle download failed:', error)
      item.cancel()
    }
  }
}
