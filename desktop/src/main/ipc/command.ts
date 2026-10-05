import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '../../shared/contracts'
import { errorMessage, fail, ok } from './ipc-result'

/**
 * 统一 IPC 命令注册（Command + Dispatcher）。
 *
 * 历史问题：17 个 handler 文件、约 125 个通道各自复制「try/catch → fail」「requireUserId()
 * 守卫」「'参数错误' 字面量」（105+ 处鉴权、100+ 处 fail、48 处参数错误）。迁移后：
 * - 通道名与成功载荷形状**保持不变**（渲染层零改动），失败统一 {success:false,error}；
 * - 鉴权从手工调用变为**声明式**（'user' 由注册器统一 requireUserId，可审计哪些通道豁免）；
 * - 解析失败统一回「参数错误」，业务异常统一回 err.message。
 * 存量通道已全部迁移（4 个非 IpcResult 契约的裸形状通道除外，见各文件注释）；新通道一律走本注册器。
 *
 * 执行顺序为 parse → auth → execute。历史通道存在两种校验顺序，均被测试钉死：
 * - 「参数先于会话」（如 delete-expert/delete-template、conversation、workspace）：
 *   校验放 parse，非法入参快速失败、不触碰会话；
 * - 「会话先于参数」（如 knowledge:* 全部通道，未登录时非法参数也回「未登录」）：
 *   不使用 parse，参数收窄保持在 execute 内、鉴权之后。
 * 新通道按业务语义任选其一，并在通道内注释说明理由。
 */

/** 鉴权声明：user=需登录；machine=机器级配置显式豁免；none=完全开放（如启动期通道） */
export type CommandAuth = 'user' | 'machine' | 'none'

export interface CommandContext {
  /** 登录用户 id（auth==='user' 时必有；其余为 null） */
  userId: string | null
  event: IpcMainInvokeEvent
}

export interface CommandSpec<TArgs extends unknown[], TData> {
  auth: CommandAuth
  /**
   * 原始入参 → 强类型，在鉴权**之前**运行。
   * 不合法返回 null（统一回复「参数错误」）；需要既有自定义文案
   * （如「参数错误：专家 id 无效」）时直接抛错。缺省表示通道自行收窄参数。
   */
  parse?: (raw: unknown[]) => TArgs | null
  execute: (ctx: CommandContext, ...args: TArgs) => TData | Promise<TData>
}

/**
 * 创建注册器（requireUserId 注入主进程会话守卫；纯机器级文件可传 null）。
 * 每个 handler 模块在 register* 内部调用一次，把 deps.requireUserId / session 收进闭包。
 */
export function createCommandRegistrar(requireUserId: (() => string) | null) {
  return function registerCommand<TArgs extends unknown[], TData = unknown>(
    ipc: IpcMain,
    channel: string,
    spec: CommandSpec<TArgs, TData>
  ): void {
    ipc.handle(channel, async (event, ...raw): Promise<IpcResult<TData>> => {
      try {
        let args: TArgs
        if (spec.parse) {
          const parsed = spec.parse(raw)
          if (parsed === null) return fail('参数错误')
          args = parsed
        } else {
          args = raw as TArgs
        }
        let userId: string | null = null
        if (spec.auth === 'user') {
          if (!requireUserId) throw new Error('未注入登录守卫，不能声明 auth=user')
          userId = requireUserId()
        }
        return ok(await spec.execute({ userId, event }, ...args))
      } catch (err) {
        return fail(errorMessage(err))
      }
    })
  }
}
