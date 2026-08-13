import { PointsSummary, Result, UserProfile } from '../../common/types/Models'
import { HttpClient } from '../http/HttpClient'
import { UserService } from '../contracts/UserService'

export class RealUserService implements UserService {
  async getProfile(): Promise<Result<UserProfile>> {
    return HttpClient.getInstance().get<UserProfile>('/api/v1/user/profile')
  }

  async getPoints(): Promise<Result<PointsSummary>> {
    return HttpClient.getInstance().get<PointsSummary>('/api/v1/user/points')
  }
}
