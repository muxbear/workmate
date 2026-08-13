export type ThemeMode = 'system' | 'light' | 'dark'

/** 显示偏好(全局单例);持久化与 colorMode 应用在页面层完成 */
@ObservedV2
export class SettingsStore {
  @Trace theme: ThemeMode = 'system'
  language: string = 'system'
  fontScale: number = 1

  setTheme(mode: ThemeMode): void {
    this.theme = mode
  }
}

export const settingsStore = new SettingsStore()
