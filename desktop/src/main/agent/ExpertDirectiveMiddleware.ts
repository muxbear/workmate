import { createMiddleware, type AgentMiddleware } from 'langchain'
import { SystemMessage } from '@langchain/core/messages'
import type { DesktopExpert } from '../../preload/index.d'

/**
 * 专家委派中间件：选中专家的那一轮给主智能体系统提示词追加强制委派指令。
 *
 * 与 Web 端 `backend/src/agent/middleware/expert_directive.py` 同款设计：
 * 委派指令走系统提示词（用户不可见、不可误改），用户消息只保留用户原文。
 * 此前的做法是把专家 promptTemplate 预填进输入框、随用户消息发出，
 * 导致输入框/气泡/会话标题被长提示词污染（02 端体验不一致）。
 *
 * - 只在「单选专家」模式且专家列表非空时注入（自动化全量专家模式不注入）
 * - 固定指令（先 task 委派 → 等待 → 基于产出汇总）+ 专家自带 promptTemplate 细则
 * - deepagents 子智能体有独立中间件链，本中间件只作用于主智能体
 */

/** 追加到系统提示词末尾的强制委派指令（与 Web 端文案对齐） */
const DIRECTIVE_TEMPLATE =
  '\n\n## 本次任务的强制委派要求\n' +
  '本次任务已选择专家「{name}」。请严格按以下顺序执行：\n' +
  '1. 先调用 task 工具，subagent_type 使用「{name}」，把用户的完整需求作为任务描述交给该专家；\n' +
  '2. 等待该专家返回结果；\n' +
  '3. 基于专家的产出给用户最终回复，不要自己重复完成专家的工作。\n'

/** 系统消息内容（string 或 blocks 数组）统一取文本 */
function systemMessageText(message: unknown): string {
  const content = (message as { content?: unknown } | null | undefined)?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        const text = (part as { text?: unknown })?.text
        return typeof text === 'string' ? text : ''
      })
      .join('')
  }
  return ''
}

/** 模板占位符替换（{name}/{title} 全部出现处都替换，避免残留字面量） */
function fillTemplate(template: string, expert: DesktopExpert): string {
  return template.replaceAll('{name}', expert.name).replaceAll('{title}', expert.title)
}

/** 构造本轮委派指令；无可用专家时返回空串 */
export function buildExpertDirective(experts: DesktopExpert[]): string {
  const blocks: string[] = []
  for (const expert of experts) {
    const name = (expert.name || '').trim()
    if (!name) continue
    let block = DIRECTIVE_TEMPLATE.replaceAll('{name}', name)
    // 专家自带的委派细则（如检索专家要求的"原样保留来源链接、不要改写结论"）随行注入
    const detail = fillTemplate((expert.promptTemplate || '').trim(), expert)
    if (detail) {
      block += '\n委派细则（来自专家配置，必须遵守）：\n' + detail + '\n'
    }
    blocks.push(block)
  }
  return blocks.join('')
}

/**
 * 创建专家委派中间件。
 * @param getExperts 当前选中专家（单选模式）；返回空数组时不改动请求
 */
export function createExpertDirectiveMiddleware(
  getExperts: () => DesktopExpert[]
): AgentMiddleware {
  return createMiddleware({
    name: 'expertDirectiveMiddleware',
    wrapModelCall: async (request, handler) => {
      const directive = buildExpertDirective(getExperts())
      if (!directive) return handler(request)
      const base = systemMessageText(request.systemMessage)
      const merged = base ? base + directive : directive.trim()
      console.log('[ExpertDirective] 已注入强制委派指令，长度:', directive.length)
      return handler({ ...request, systemMessage: new SystemMessage(merged) })
    }
  })
}
