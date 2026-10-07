import type { IpcMain } from 'electron'
import type { CloseChoice } from '../services/windowCloseBehavior'
import { createCommandRegistrar } from './command'

export interface WindowHandlerDeps {
  /** 渲染层对「关闭确认」的作答（null = 取消）；返回是否命中在途询问 */
  answerCloseConfirm: (choice: CloseChoice | null) => boolean
  /** 用户菜单「退出应用」：实现方必须先 markQuitting() 再 app.quit()，否则会被自身拦截 */
  quitApp: () => void
}

/**
 * 注册窗口/应用生命周期相关 IPC 通道
 *
 * 机器级（与登录态无关），不调 session.requireUserId()；
 * 用 invoke/handle（渲染层可 await、e2e 可精确定点），不走 ipcMain.on 单向发送。
 */
export function registerWindowHandlers(ipc: IpcMain, deps: WindowHandlerDeps): void {
  const registerCommand = createCommandRegistrar(null)

  registerCommand<[CloseChoice | null], null>(ipc, 'app:close-confirm-answer', {
    auth: 'machine',
    // 非法值（含未识别字符串）回「参数错误」；null 是合法的「取消」语义
    parse: ([choice]) =>
      choice === null || choice === 'tray' || choice === 'close' ? [choice] : null,
    execute: (_ctx, choice) => {
      deps.answerCloseConfirm(choice)
      return null
    }
  })

  registerCommand<[], null>(ipc, 'app:quit', {
    auth: 'machine',
    execute: () => {
      deps.quitApp()
      return null
    }
  })
}
