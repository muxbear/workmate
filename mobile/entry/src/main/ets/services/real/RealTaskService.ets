import { CloudTask, Result, Workspace } from '../../common/types/Models'
import { HttpClient } from '../http/HttpClient'
import { TaskService } from '../contracts/TaskService'

export class RealTaskService implements TaskService {
  async listWorkspaces(): Promise<Result<Workspace[]>> {
    return HttpClient.getInstance().get<Workspace[]>('/api/v1/workspaces')
  }

  async listTasks(): Promise<Result<CloudTask[]>> {
    return HttpClient.getInstance().get<CloudTask[]>('/api/v1/tasks')
  }
}
