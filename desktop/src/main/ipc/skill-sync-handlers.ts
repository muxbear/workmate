import type { IpcMain } from 'electron'
import type { SessionService } from '../services/SessionService'
import type { SkillSyncService } from '../skills/SkillSyncService'
import type { SkillInstallService } from '../skills/SkillInstallService'
import type { SkillInstallProgress, SkillSyncProgress } from '../../shared/contracts'
import { createCommandRegistrar } from './command'
import { errorMessage } from './ipc-result'

interface SkillSyncHandlerDeps {
  skillSyncService: SkillSyncService
  skillInstallService: SkillInstallService
  session: SessionService
}

/** 校验渲染层传入的技能 id（不可信输入） */
function isValidSkillId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
}

/** 技能 id 解析：保持既有文案，且在会话校验前返回（快失败） */
function parseSkillId([skillId]: unknown[]): [string] {
  if (!isValidSkillId(skillId)) throw new Error('参数错误：技能 id 无效')
  return [skillId]
}

/** 注册 Web 技能同步与技能安装 IPC 通道（含主进程 → 渲染层的进度事件）。 */
export function registerSkillSyncHandlers(ipc: IpcMain, deps: SkillSyncHandlerDeps): void {
  const registerCommand = createCommandRegistrar(() => deps.session.requireUserId())
  const { skillSyncService, skillInstallService } = deps

  registerCommand<[], unknown>(ipc, 'skill-sync:status', {
    auth: 'user',
    execute: (ctx) => skillSyncService.getStatus(ctx.userId as string)
  })

  registerCommand<[], unknown>(ipc, 'skill-sync:authorize', {
    auth: 'user',
    execute: (ctx) => skillSyncService.authorize(ctx.userId as string)
  })

  registerCommand<[], unknown>(ipc, 'skill-sync:sync', {
    auth: 'user',
    execute: async (ctx) => {
      const sendProgress = (progress: SkillSyncProgress): void => {
        if (!ctx.event.sender.isDestroyed()) {
          ctx.event.sender.send('skill-sync:progress', progress)
        }
      }
      try {
        return await skillSyncService.sync(ctx.userId as string, sendProgress)
      } catch (err) {
        // 失败兜底：补推 error 阶段进度（常规进度由服务内部回调驱动）
        sendProgress({ phase: 'error', percent: 0, message: errorMessage(err) })
        throw err
      }
    }
  })

  registerCommand<[], unknown>(ipc, 'skill-sync:cached', {
    auth: 'user',
    execute: () => skillSyncService.getCachedSkills()
  })

  /** 读取 ~/.ke-work/skills/skills.json（技能页挂载与同步完成后加载） */
  registerCommand<[], unknown>(ipc, 'skill-sync:load-local', {
    auth: 'user',
    execute: () => skillSyncService.loadLocal()
  })

  registerCommand<[], null>(ipc, 'skill-sync:disconnect', {
    auth: 'user',
    execute: async (ctx) => {
      await skillSyncService.disconnect(ctx.userId as string)
      return null
    }
  })

  /** 安装技能到主智能体（含脚本运行时环境准备，安装期间推送 skill:install-progress） */
  registerCommand<[string], unknown>(ipc, 'skill:install', {
    auth: 'user',
    parse: parseSkillId,
    execute: async (ctx, skillId) => {
      const sendProgress = (progress: SkillInstallProgress): void => {
        if (!ctx.event.sender.isDestroyed()) {
          ctx.event.sender.send('skill:install-progress', progress)
        }
      }
      try {
        return await skillInstallService.install(skillId, sendProgress)
      } catch (err) {
        const message = errorMessage(err)
        sendProgress({ skillId, skillName: '', phase: 'error', percent: 0, message })
        throw err
      }
    }
  })

  /** 删除本地技能（卸载 + 删除本地技能包；重新同步时以服务端为准） */
  registerCommand<[string], unknown>(ipc, 'skill:delete', {
    auth: 'user',
    parse: parseSkillId,
    execute: (_ctx, skillId) => skillInstallService.delete(skillId)
  })

  /** 从主智能体移除技能（保留本地技能包与运行环境） */
  registerCommand<[string], unknown>(ipc, 'skill:uninstall', {
    auth: 'user',
    parse: parseSkillId,
    execute: (_ctx, skillId) => skillInstallService.uninstall(skillId)
  })
}
