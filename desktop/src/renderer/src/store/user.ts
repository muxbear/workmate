import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export interface AuthResult {
  token: string
  refreshToken: string
  user: { id: string; username: string; mobile?: string }
}

export const useUserStore = defineStore('user', () => {
  const token = ref(localStorage.getItem('user_token') || '')
  const refreshToken = ref(localStorage.getItem('user_refresh_token') || '')
  const userInfo = ref<{ id?: string; username?: string; mobile?: string; nickname?: string }>({})

  const isLoggedIn = computed(() => Boolean(token.value))

  function setLogin(result: AuthResult): void {
    token.value = result.token
    refreshToken.value = result.refreshToken
    userInfo.value = result.user
    localStorage.setItem('user_token', result.token)
    localStorage.setItem('user_refresh_token', result.refreshToken)
    localStorage.setItem('user_info', JSON.stringify(result.user))
  }

  function restoreUserInfo(): void {
    const saved = localStorage.getItem('user_info')
    if (saved) {
      try {
        userInfo.value = JSON.parse(saved)
      } catch {
        userInfo.value = {}
      }
    }
  }

  function logout(): void {
    token.value = ''
    refreshToken.value = ''
    userInfo.value = {}
    localStorage.removeItem('user_token')
    localStorage.removeItem('user_refresh_token')
    localStorage.removeItem('user_info')
  }

  /**
   * 用主进程权威会话资料纠正展示信息（session:check 每次带回；昵称更新通道的
   * 返回资料也走这里同步）。
   * 场景：localStorage 残留上一账号的 user_info，而主进程会话已是另一账号——
   * 仅校验 loggedIn 布尔无法自愈，会一直显示错误用户名到下次登录。
   */
  function syncFromSession(
    user: { id: string; username: string; mobile?: string; nickname?: string } | null | undefined
  ): void {
    if (!user?.id) return
    userInfo.value = {
      id: user.id,
      username: user.username,
      mobile: user.mobile,
      nickname: user.nickname
    }
    localStorage.setItem('user_info', JSON.stringify(userInfo.value))
  }

  restoreUserInfo()

  return { token, refreshToken, userInfo, isLoggedIn, setLogin, logout, syncFromSession }
})
