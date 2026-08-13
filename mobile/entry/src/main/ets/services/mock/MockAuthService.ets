import { Result, UserProfile } from '../../common/types/Models'
import { delay } from '../../common/utils/Async'
import { AuthService, LoginResult } from '../contracts/AuthService'

/** 模拟用户(与设计稿一致:苜蓿/体验版) */
export const MOCK_PROFILE: UserProfile = {
  nickname: '苜蓿',
  phone: '150****5831',
  level: '体验版',
  avatarColor: '#34d399',
}

export class MockAuthService implements AuthService {
  async login(phone: string, code: string): Promise<Result<LoginResult>> {
    await delay(900)
    if (code !== '123456') {
      return { ok: false, code: 1001, message: '验证码错误' } as Result<LoginResult>
    }
    const profile: UserProfile = {
      nickname: MOCK_PROFILE.nickname,
      phone: maskMock(phone),
      level: MOCK_PROFILE.level,
      avatarColor: MOCK_PROFILE.avatarColor,
    }
    const value: LoginResult = { token: 'mock-token-' + Date.now(), profile: profile }
    return { ok: true, value: value } as Result<LoginResult>
  }

  async oneClickLogin(providerToken: string): Promise<Result<LoginResult>> {
    await delay(1400)   // 与设计稿 1.4s 登录中状态一致
    if (!providerToken) {
      return { ok: false, code: 1002, message: '一键登录失败' } as Result<LoginResult>
    }
    const value: LoginResult = { token: 'mock-token-' + Date.now(), profile: MOCK_PROFILE }
    return { ok: true, value: value } as Result<LoginResult>
  }

  async logout(): Promise<Result<void>> {
    await delay(300)
    const ok: Result<void> = { ok: true, value: undefined as void }
    return ok
  }
}

function maskMock(phone: string): string {
  return phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : phone
}
