import { PointsSummary, UserProfile } from '../common/types/Models'
import { LoginResult } from '../services/contracts/AuthService'
import { ServiceFactory } from '../services/ServiceFactory'

/** 登录态与用户数据(全局单例) */
@ObservedV2
export class SessionStore {
  @Trace isLoggedIn: boolean = false
  @Trace profile: UserProfile | null = null
  @Trace points: PointsSummary | null = null
  token: string = ''

  login(result: LoginResult): void {
    this.token = result.token
    this.profile = result.profile
    this.isLoggedIn = true
  }

  logout(): void {
    this.token = ''
    this.profile = null
    this.points = null
    this.isLoggedIn = false
  }

  /** 刷新积分(侧边栏/设置页进入时调用) */
  async refreshPoints(): Promise<void> {
    const r = await ServiceFactory.getUser().getPoints()
    if (r.ok) {
      this.points = r.value
    }
  }
}

export const sessionStore = new SessionStore()
