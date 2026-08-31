import axios from 'axios'
import type { ModelService } from '../../model/ModelService'

export interface GenerateImageInput {
  prompt: string
  size?: string
  modelService?: ModelService
  imageModelName?: string | null
}

export interface GenerateImageResult {
  url?: string
  b64_json?: string
  error?: string
  prompt: string
}

export async function generateImage(input: GenerateImageInput): Promise<GenerateImageResult> {
  const modelId = input.imageModelName
  const credential = input.modelService && modelId ? input.modelService.getCredential(modelId) : null
  if (!credential) {
    return { error: 'image_generate tool not configured', prompt: input.prompt }
  }

  const url = credential.url.endsWith('/') ? credential.url : credential.url + '/'
  const response = await axios.post(
    url,
    { model: credential.id, prompt: input.prompt, size: input.size || '512x512' },
    { headers: { Authorization: 'Bearer ' + credential.apiKey }, timeout: 60000 }
  )

  const items = response.data?.data || []
  if (!items.length) {
    return { error: 'image_generate returned no image data', prompt: input.prompt }
  }

  const first = items[0]
  if (first.url) return { url: first.url, prompt: input.prompt }
  if (first.b64_json) return { b64_json: first.b64_json, prompt: input.prompt }
  return { error: 'image_generate returned unsupported image format', prompt: input.prompt }
}
