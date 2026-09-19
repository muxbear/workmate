import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { SessionService } from '../services/SessionService'
import type { SkillSyncService } from '../skills/SkillSyncService'
import type { SkillInstallService } from '../skills/SkillInstallService'
import type { SkillInstallProgress, SkillSyncProgress } from '../../preload/index.d'

interface SkillSyncHandlerDeps {
  skillSyncService: SkillSyncService
  skillInstallService: SkillInstallService
  session: SessionService
}

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data }
}

function fail(error: string): { success: false; error: string } {
  return { success: false, error }
}

/** 校验渲染层传入的技能 id（不可信输入） */
function isValidSkillId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
}

/** 注册 Web 技能同步与技能安装 IPC 通道（含主进程 → 渲染层的进度事件）。 */
export function registerSkillSyncHandlers(ipc: IpcMain, deps: SkillSyncHandlerDeps): void {
  const { skillSyncService, skillInstallService, session } = deps

  ipc.handle('skill-sync:status', async () => {
    try {
      const userId = session.requireUserId()
      return ok(skillSyncService.getStatus(userId))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('skill-sync:authorize', async () => {
    try {
      const userId = session.requireUserId()
      return ok(await skillSyncService.authorize(userId))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('skill-sync:sync', async (event: IpcMainInvokeEvent) => {
    const sendProgress = (progress: SkillSyncProgress): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('skill-sync:progress', progress)
      }
    }
    try {
      const userId = session.requireUserId()
      return ok(await skillSyncService.sync(userId, sendProgress))
    } catch (err) {
      const message = (err as Error).message
      sendProgress({ phase: 'error', percent: 0, message })
      return fail(message)
    }
  })

  ipc.handle('skill-sync:cached', async () => {
    try {
      session.requireUserId()
      return ok(skillSyncService.getCachedSkills())
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  /** 读取 ~/.ke-work/skills/skills.json（技能页挂载与同步完成后加载） */
  ipc.handle('skill-sync:load-local', async () => {
    try {
      session.requireUserId()
      return ok(await skillSyncService.loadLocal())
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('skill-sync:disconnect', async () => {
    try {
      const userId = session.requireUserId()
      await skillSyncService.disconnect(userId)
      return ok(null)
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  /** 安装技能到主智能体（含脚本运行时环境准备，安装期间推送 skill:install-progress） */
  ipc.handle('skill:install', async (event: IpcMainInvokeEvent, skillId?: unknown) => {
    if (!isValidSkillId(skillId)) return fail('参数错误：技能 id 无效')
    const sendProgress = (progress: SkillInstallProgress): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('skill:install-progress', progress)
      }
    }
    try {
      session.requireUserId()
      return ok(await skillInstallService.install(skillId, sendProgress))
    } catch (err) {
      const message = (err as Error).message
      sendProgress({ skillId, skillName: '', phase: 'error', percent: 0, message })
      return fail(message)
    }
  })

  /** 从主智能体移除技能（保留本地技能包与运行环境） */
  ipc.handle('skill:uninstall', async (_event, skillId?: unknown) => {
    if (!isValidSkillId(skillId)) return fail('参数错误：技能 id 无效')
    try {
      session.requireUserId()
      return ok(await skillInstallService.uninstall(skillId))
    } catch (err) {
      return fail((err as Error).message)
    }
  })
}
