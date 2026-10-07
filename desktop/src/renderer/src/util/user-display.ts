/**
 * 账号显示名解析（主页面侧栏 / 用户菜单 / 设置-账户管理页共用）。
 *
 * 优先级：本地昵称 → 用户名 → 手机号 → `${systemName}用户`。
 * 昵称空白视为未设置（主进程落库前已 trim，这里兜底渲染层旧缓存）。
 * 注意：web-only 用户的 username 是 `web_<webAccountId>` 合成值，会落进回退链
 * 展示；如需收口可在此处加 webNickname/isWebOnly 分支（暂不做）。
 */
export interface UserDisplaySource {
  nickname?: string
  username?: string
  mobile?: string
}

export function resolveDisplayName(
  user: UserDisplaySource | null | undefined,
  systemName: string
): string {
  return user?.nickname?.trim() || user?.username || user?.mobile || `${systemName}用户`
}

/** 头像取显示名首字符（大写；空则 'K'） */
export function resolveAvatarInitial(displayName: string): string {
  return displayName.trim().charAt(0).toUpperCase() || 'K'
}
