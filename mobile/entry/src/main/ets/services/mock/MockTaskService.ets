import { CloudTask, Result, Workspace } from '../../common/types/Models'
import { delay } from '../../common/utils/Async'
import { TaskService } from '../contracts/TaskService'

export class MockTaskService implements TaskService {
  async listWorkspaces(): Promise<Result<Workspace[]>> {
    await delay(300)
    const value: Workspace[] = [
      { id: 'task', name: '任务', device: 'DESKTOP-S3R6IMC' },
      { id: 'ws-1', name: 'WorkBuddySpace' },
      { id: 'ws-2', name: '我的工作空间' },
    ]
    return { ok: true, value: value } as Result<Workspace[]>
  }

  async listTasks(): Promise<Result<CloudTask[]>> {
    await delay(300)
    const value: CloudTask[] = []   // 设计稿空状态:暂无云端任务
    return { ok: true, value: value } as Result<CloudTask[]>
  }
}
