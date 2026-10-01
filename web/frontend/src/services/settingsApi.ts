import instance from './request'
import type { SystemSettings, UserPreferences } from '@/types/settings'

/**
 * 读取系统标识。
 *
 * 这是**公开接口**：登录页在 MainLayout 之外，未认证就要渲染系统名称与 LOGO，
 * 所以启动时无条件调用。带 `skipAuthRedirect` 是必要的加固——万一后端把它
 * 误配成 401，拦截器的 `window.location.href = '/login'` 会在登录页上自我
 * 重定向成无限重载循环。
 */
export async function fetchSystemSettings(): Promise<SystemSettings> {
  const res = await instance.get('/settings/system', { skipAuthRedirect: true })
  return res.data.data
}

export async function updateSystemSettings(payload: {
  systemName: string
}): Promise<SystemSettings> {
  const res = await instance.put('/admin/settings/system', payload)
  return res.data.data
}

export async function uploadSystemLogo(file: File): Promise<SystemSettings> {
  const form = new FormData()
  form.append('file', file)
  // 刻意不手动设 Content-Type：axios 需要自己拼 multipart 的 boundary，
  // 手工写成 multipart/form-data 会把 boundary 丢掉，后端直接 422。
  const res = await instance.post('/admin/settings/system/logo', form)
  return res.data.data
}

export async function resetSystemLogo(): Promise<SystemSettings> {
  const res = await instance.delete('/admin/settings/system/logo')
  return res.data.data
}

export async function fetchPreferences(): Promise<UserPreferences> {
  const res = await instance.get('/settings/preferences')
  return res.data.data
}

export async function updatePreferences(
  payload: Partial<UserPreferences>,
): Promise<UserPreferences> {
  const res = await instance.put('/settings/preferences', payload)
  return res.data.data
}
