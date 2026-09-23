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
  CAPABILITY_IMAGE_GENERATE
} from '../../experts/expertContract'
import { downloadAssetToWorkspace } from './ArtifactAssetService'
import { generateImage } from './ImageGenerationService'

export function buildExpertTools(
  toolNames: string[],
  modelService?: ModelService,
  imageModelName?: string | null,
  /** 专家声明的能力（声明式驱动；缺省或为空时回退到工具名匹配，兼容存量专家） */
  capabilities: string[] = []
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

  return tools
}

export function buildExpertSkills(_skills: unknown[]): string[] {
  return []
}
