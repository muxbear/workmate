import { Constants } from '../common/constants/Constants'
import { AuthService } from './contracts/AuthService'
import { ChatService } from './contracts/ChatService'
import { TaskService } from './contracts/TaskService'
import { UserService } from './contracts/UserService'
import { MockAuthService } from './mock/MockAuthService'
import { MockChatService } from './mock/MockChatService'
import { MockTaskService } from './mock/MockTaskService'
import { MockUserService } from './mock/MockUserService'
import { RealAuthService } from './real/RealAuthService'
import { RealChatService } from './real/RealChatService'
import { RealTaskService } from './real/RealTaskService'
import { RealUserService } from './real/RealUserService'

/**
 * Service 工厂:唯一切换点。
 * Constants.USE_MOCK = true 走 Mock;后端就绪后改为 false 即切换 Real。
 * 页面代码只依赖契约 interface,此处切换对页面零改动。
 */
export class ServiceFactory {
  private static auth: AuthService | null = null
  private static user: UserService | null = null
  private static chat: ChatService | null = null
  private static task: TaskService | null = null

  static getAuth(): AuthService {
    if (!ServiceFactory.auth) {
      ServiceFactory.auth = Constants.USE_MOCK ? new MockAuthService() : new RealAuthService()
    }
    return ServiceFactory.auth
  }

  static getUser(): UserService {
    if (!ServiceFactory.user) {
      ServiceFactory.user = Constants.USE_MOCK ? new MockUserService() : new RealUserService()
    }
    return ServiceFactory.user
  }

  static getChat(): ChatService {
    if (!ServiceFactory.chat) {
      ServiceFactory.chat = Constants.USE_MOCK ? new MockChatService() : new RealChatService()
    }
    return ServiceFactory.chat
  }

  static getTask(): TaskService {
    if (!ServiceFactory.task) {
      ServiceFactory.task = Constants.USE_MOCK ? new MockTaskService() : new RealTaskService()
    }
    return ServiceFactory.task
  }
}
