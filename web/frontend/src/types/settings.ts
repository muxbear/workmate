import type { LocaleCode } from '@/locales'

/** 系统标识：全局品牌配置，所有用户共见 */
export interface SystemSettings {
  systemName: string
  /** 自定义 LOGO 的根相对地址；null 表示未自定义，前端回退内置 LOGO */
  logoUrl: string | null
}

/** 提示音风格——与桌面版 `notification.sound` 取值一致 */
export type NotificationSound = 'none' | 'crisp' | 'soft'

/** 按用户存储、跨设备跟随账号的界面偏好 */
export interface UserPreferences {
  language: LocaleCode
  fontSize: number
  clientNotifications: boolean
  notificationSound: NotificationSound
}
