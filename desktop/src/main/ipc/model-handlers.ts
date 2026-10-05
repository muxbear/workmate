import type { IpcMain } from 'electron'
import type { ModelService } from '../model/ModelService'
import type { ModelProtocol } from '../model/types'
import { createCommandRegistrar } from './command'

export interface ModelHandlerDeps {
  modelService: ModelService
}

/** 添加模型入参白名单（渲染层不可信，类型校验在主进程） */
function toAddInput(input: unknown): {
  id: string
  name: string
  vendor: string
  url: string
  protocol: ModelProtocol
  apiKey: string
} | null {
  if (typeof input !== 'object' || input === null) return null
  const v = input as Record<string, unknown>
  if (
    typeof v.id !== 'string' ||
    typeof v.name !== 'string' ||
    typeof v.vendor !== 'string' ||
    typeof v.url !== 'string' ||
    typeof v.protocol !== 'string' ||
    typeof v.apiKey !== 'string'
  ) {
    return null
  }
  return {
    id: v.id,
    name: v.name,
    vendor: v.vendor,
    url: v.url,
    protocol: v.protocol as ModelProtocol,
    apiKey: v.apiKey
  }
}

type AddInput = NonNullable<ReturnType<typeof toAddInput>>

/**
 * 注册自定义模型相关 IPC 通道
 * 机器级配置（本地 models.json，与登录态无关），不调 session.requireUserId()；
 * 主进程为校验权威，渲染层不可信
 */
export function registerModelHandlers(ipc: IpcMain, deps: ModelHandlerDeps): void {
  const registerCommand = createCommandRegistrar(null)
  const { modelService } = deps

  registerCommand<[], unknown>(ipc, 'model:list', {
    auth: 'machine',
    execute: () => modelService.list()
  })

  registerCommand<[AddInput], unknown>(ipc, 'model:add', {
    auth: 'machine',
    parse: ([input]) => {
      const parsed = toAddInput(input)
      return parsed ? [parsed] : null
    },
    execute: (_ctx, parsed) => modelService.add(parsed)
  })

  registerCommand<[string], null>(ipc, 'model:remove', {
    auth: 'machine',
    parse: ([id]) => (typeof id === 'string' && id ? [id] : null),
    execute: (_ctx, id) => {
      modelService.remove(id)
      return null
    }
  })

  registerCommand<[string, AddInput], unknown>(ipc, 'model:update', {
    auth: 'machine',
    parse: ([id, input]) => {
      if (typeof id !== 'string' || !id) return null
      const parsed = toAddInput(input)
      return parsed ? [id, parsed] : null
    },
    execute: (_ctx, id, parsed) => modelService.update(id, parsed)
  })

  registerCommand<[], unknown>(ipc, 'model:list-providers', {
    auth: 'machine',
    execute: () => modelService.listProviders()
  })
}
