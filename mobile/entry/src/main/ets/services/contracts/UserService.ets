import { Result, PointsSummary, UserProfile } from '../../common/types/Models'

/** 用户服务契约 */
export interface UserService {
  getProfile(): Promise<Result<UserProfile>>
  getPoints(): Promise<Result<PointsSummary>>
}
