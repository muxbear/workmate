/** 全局常量 */
export class Constants {
  /** 后端基地址(Real 模式使用;Mock 模式下无效) */
  static readonly BASE_URL: string = 'https://api.example.com'
  /** 请求超时(毫秒) */
  static readonly TIMEOUT_MS: number = 10000
  /** 是否使用 Mock 实现 —— 后端就绪后改为 false */
  static readonly USE_MOCK: boolean = true
  /** 本地偏好存储名 */
  static readonly PREFS_NAME: string = 'ke_work_prefs'
  /** 主题偏好 key */
  static readonly KEY_THEME: string = 'theme'
  /** 会话 token 持久化 key */
  static readonly KEY_TOKEN: string = 'token'
}
