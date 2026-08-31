import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { ModelService } from '../../model/ModelService'
import { generateImage } from './ImageGenerationService'

export function buildExpertTools(
  toolNames: string[],
  modelService?: ModelService,
  imageModelName?: string | null
): DynamicStructuredTool[] {
  const tools: DynamicStructuredTool[] = []

  if (toolNames.includes('image_generate')) {
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

  return tools
}

export function buildExpertSkills(_skills: unknown[]): string[] {
  return []
}
