import { CloudTask, Result, Workspace } from '../../common/types/Models'

/** 任务/工作空间服务契约 */
export interface TaskService {
  listWorkspaces(): Promise<Result<Workspace[]>>
  listTasks(): Promise<Result<CloudTask[]>>
}
