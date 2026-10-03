import { DynamicStructuredTool } from '@langchain/core/tools'
import type { RunnableConfig } from '@langchain/core/runnables'
import { z } from 'zod'

/** 从工具运行配置中解析当前会话的工作区目录（agent:send 注入 configurable.workspace_dir） */
function resolveWorkspaceDir(config?: RunnableConfig): string {
  const raw = config as
    | {
        configurable?: Record<string, unknown>
        config?: { configurable?: Record<string, unknown> }
      }
    | undefined
  const value = raw?.configurable?.workspace_dir ?? raw?.config?.configurable?.workspace_dir
  return typeof value === 'string' ? value : ''
}
import type { ModelService } from '../../model/ModelService'
import {
  CAPABILITY_DOCUMENT_ASSEMBLE,
  CAPABILITY_IMAGE_GENERATE,
  CAPABILITY_KNOWLEDGE_SEARCH
} from '../../experts/expertContract'
import { buildKnowledgeTools, type KnowledgeToolDeps } from './KnowledgeTool'
import { downloadAssetToWorkspace } from './ArtifactAssetService'
import { generateImage } from './ImageGenerationService'

export interface ExpertToolExtras {
  /**
   * 本地知识库检索依赖（提供且专家声明 knowledge.search 时注册 kb_search /
   * list_knowledge_bases）。
   *
   * 与云端的关系：声明该能力的专家**仍然可以**通过 mcp_configs 挂「云知识库检索」
   * MCP 服务；两条通道同名时优先本地内置（AgentManager 装配处按名字去重）。
   */
  knowledge?: KnowledgeToolDeps
}

export function buildExpertTools(
  toolNames: string[],
  modelService?: ModelService,
  imageModelName?: string | null,
  /** 专家声明的能力（声明式驱动；缺省或为空时回退到工具名匹配，兼容存量专家） */
  capabilities: string[] = [],
  extras: ExpertToolExtras = {}
): DynamicStructuredTool[] {
  const tools: DynamicStructuredTool[] = []
  const enabled = (capability: string, toolName: string): boolean =>
    capabilities.includes(capability) || toolNames.includes(toolName)

  if (enabled(CAPABILITY_IMAGE_GENERATE, 'image_generate')) {
    tools.push(
      new DynamicStructuredTool({
        name: 'image_generate',
        description: '根据文本提示生成图片，返回图片 URL 或 base64。',
        schema: z.object({
          prompt: z.string().describe('图片描述'),
          size: z.string().optional().describe('图片尺寸，如 512x512')
        }),
        func: async ({ prompt, size }) => {
          const result = await generateImage({ prompt, size, modelService, imageModelName })
          return JSON.stringify(result)
        }
      })
    )
  }

  if (enabled(CAPABILITY_DOCUMENT_ASSEMBLE, 'download_asset')) {
    tools.push(
      new DynamicStructuredTool({
        name: 'download_asset',
        description:
          '把远程素材（AI 生成服务返回的图片或视频临时地址）下载到工作区交付目录，' +
          '返回保存路径、大小与类型。图片与视频共用本工具，不要用 shell 命令下载素材。',
        schema: z.object({
          url: z.string().describe('素材地址（http/https）'),
          rel_path: z
            .string()
            .describe('相对交付目录的保存路径，如 文章标题/figure-1.png、视频标题/成片-1.mp4')
        }),
        func: async ({ url, rel_path }, _runManager, config) => {
          const workspaceDir = resolveWorkspaceDir(config)
          if (!workspaceDir) {
            return JSON.stringify({ error: '缺少工作区目录，无法保存素材' })
          }
          try {
            const saved = await downloadAssetToWorkspace({ url, relPath: rel_path, workspaceDir })
            return JSON.stringify(saved)
          } catch (error) {
            return JSON.stringify({ error: (error as Error).message })
          }
        }
      })
    )
  }

  if (enabled(CAPABILITY_KNOWLEDGE_SEARCH, 'kb_search') && extras.knowledge) {
    // 本地知识库检索（与主智能体同一实现；身份取自运行时 configurable，失败关闭）
    tools.push(...buildKnowledgeTools(extras.knowledge))
  }

  return tools
}

export function buildExpertSkills(_skills: unknown[]): string[] {
  return []
}
