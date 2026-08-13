import { PointsSummary, Result, UserProfile } from '../../common/types/Models'
import { delay } from '../../common/utils/Async'
import { UserService } from '../contracts/UserService'
import { MOCK_PROFILE } from './MockAuthService'

export class MockUserService implements UserService {
  async getProfile(): Promise<Result<UserProfile>> {
    await delay(400)
    return { ok: true, value: MOCK_PROFILE } as Result<UserProfile>
  }

  async getPoints(): Promise<Result<PointsSummary>> {
    await delay(400)
    const value: PointsSummary = {
      balance: 3262.62,
      nextMilestone: 3800,
      basic: { used: 0, total: 500 },
      gifted: { used: 537.38, total: 3300 },
    }
    return { ok: true, value: value } as Result<PointsSummary>
  }
}
