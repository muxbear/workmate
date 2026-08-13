import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { initChatModelMock } = vi.hoisted(() => ({ initChatModelMock: vi.fn() }))

vi.mock('langchain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('langchain')>()
  return { ...actual, initChatModel: initChatModelMock }
})

import {
  createModelFromCredential,
  normalizeBaseUrl,
  resolveDefaultModel
} from '../../../src/main/agent/ModelFactory'
import type { ModelService } from '../../../src/main/model/ModelService'
import type { ModelRecord } from '../../../src/main/model/types'

function createFakeModelService(
  credential: Pick<ModelRecord, 'id' | 'name' | 'apiKey' | 'url'> | null,
  models: ModelRecord[] = []
): ModelService {
  return {
    getCredential: vi.fn().mockReturnValue(credential),
    list: vi.fn().mockReturnValue(models),
    listProviders: vi.fn().mockReturnValue([])
  } as unknown as ModelService
}

describe('ModelFactory', () => {
  beforeEach(() => {
    initChatModelMock.mockClear()
    initChatModelMock.mockResolvedValue({ id: 'mock-model' })
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    vi.stubEnv('DEEPSEEK_BASE_URL', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('normalizeBaseUrl 去除末尾 /chat/completions', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com/chat/completions')).toBe(
      'https://api.deepseek.com'
    )
    expect(normalizeBaseUrl('https://api.deepseek.com/v1')).toBe(
      'https://api.deepseek.com/v1'
    )
  })

  it('createModelFromCredential 使用 OpenAI 兼容方式创建模型', async () => {
    const model = await createModelFromCredential({
      id: 'deepseek-v4-pro',
      apiKey: 'sk-test',
      url: 'https://api.deepseek.com/chat/completions'
    })

    expect(model).toEqual({ id: 'mock-model' })
    expect(initChatModelMock).toHaveBeenCalledWith('deepseek-v4-pro', {
      modelProvider: 'openai',
      apiKey: 'sk-test',
      configuration: { baseURL: 'https://api.deepseek.com' }
    })
  })

  it('resolveDefaultModel 对模型实例直接返回', async () => {
    const existing = { id: 'existing' } as never
    const model = await resolveDefaultModel(
      createFakeModelService(null),
      existing as never
    )

    expect(model).toBe(existing)
    expect(initChatModelMock).not.toHaveBeenCalled()
  })

  it('resolveDefaultModel 优先使用 models.json 中同 ID 凭据', async () => {
    const model = await resolveDefaultModel(
      createFakeModelService({
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        apiKey: 'sk-configured',
        url: 'https://api.deepseek.com/v1/chat/completions'
      }),
      'deepseek:deepseek-v4-pro'
    )

    expect(model).toEqual({ id: 'mock-model' })
    expect(initChatModelMock).toHaveBeenCalledWith('deepseek-v4-pro', {
      modelProvider: 'openai',
      apiKey: 'sk-configured',
      configuration: { baseURL: 'https://api.deepseek.com/v1' }
    })
  })

  it('resolveDefaultModel 在同 ID 不存在时使用环境变量', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-env')
    vi.stubEnv('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/chat/completions')

    const model = await resolveDefaultModel(
      createFakeModelService(null),
      'deepseek:deepseek-v4-pro'
    )

    expect(model).toEqual({ id: 'mock-model' })
    expect(initChatModelMock).toHaveBeenCalledWith('deepseek-v4-pro', {
      modelProvider: 'openai',
      apiKey: 'sk-env',
      configuration: { baseURL: 'https://api.deepseek.com' }
    })
  })

  it('resolveDefaultModel 在没有同 ID 和环境变量时退回第一个自定义模型', async () => {
    const first = {
      id: 'first-model',
      name: 'First',
      vendor: 'DeepSeek',
      url: 'https://api.deepseek.com/chat/completions',
      apiKey: 'sk-first',
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: false
    }

    const model = await resolveDefaultModel(
      createFakeModelService(null, [first]),
      'deepseek:deepseek-v4-pro'
    )

    expect(model).toEqual({ id: 'mock-model' })
    expect(initChatModelMock).toHaveBeenCalledWith('first-model', {
      modelProvider: 'openai',
      apiKey: 'sk-first',
      configuration: { baseURL: 'https://api.deepseek.com' }
    })
  })

  it('resolveDefaultModel 在无任何凭据时抛出明确错误', async () => {
    await expect(
      resolveDefaultModel(
        createFakeModelService(null, []),
        'deepseek:deepseek-v4-pro'
      )
    ).rejects.toThrow(/未找到默认模型凭据/)
  })
})
