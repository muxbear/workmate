import { describe, expect, it, vi } from 'vitest'
import { canonicalType, ENTITY_TYPES, normalizeName } from '../../../src/main/knowledge/entity-norm'
import {
  buildWindows,
  convertExtraction,
  GraphExtractionError,
  GraphService,
  isToolChoiceRejection,
  parseExtractionText,
  type GraphChatModel
} from '../../../src/main/knowledge/GraphService'
import type { KnowledgeStore } from '../../../src/main/knowledge/KnowledgeStore'
import type { KnowledgeEngineConfig } from '../../../src/main/knowledge/knowledge-config'

/** store 替身：只记录写入的图谱（GraphService 单测不需要真实 SQLite） */
function createStoreFake(): {
  store: KnowledgeStore
  written: Array<{ entities: unknown[]; relations: unknown[]; docId: string }>
} {
  const written: Array<{ entities: unknown[]; relations: unknown[]; docId: string }> = []
  const store = {
    replaceDocumentGraph: (input: {
      docId: string
      entities: unknown[]
      relations: unknown[]
    }): { entities: number; relations: number } => {
      written.push({ docId: input.docId, entities: input.entities, relations: input.relations })
      return { entities: input.entities.length, relations: input.relations.length }
    }
  } as unknown as KnowledgeStore
  return { store, written }
}

function config(overrides: Partial<KnowledgeEngineConfig> = {}): KnowledgeEngineConfig {
  return {
    chunkStrategy: 'recursive',
    chunkSize: 800,
    chunkOverlap: 120,
    embeddingModel: '',
    vectorDimensions: 1024,
    embeddingBaseUrl: '',
    embeddingApiKey: '',
    sparseRetrieval: true,
    bm25K1: 1.5,
    bm25B: 0.75,
    hybridWeight: 0.65,
    rerankEnabled: false,
    rerankModel: '',
    rerankBaseUrl: '',
    rerankApiKey: '',
    topK: 12,
    minSimilarity: 0.53,
    queryRewriteEnabled: false,
    mmrEnabled: false,
    mmrLambda: 0.7,
    timeDecayHalfLifeDays: 0,
    graphEnabled: true,
    graphModel: 'GLM-5',
    ...overrides
  }
}

const CHUNKS = [
  { id: 11, index: 0, content: 'Transformer 架构由 Vaswani 等人在 2017 年提出。' },
  { id: 12, index: 1, content: 'BERT 模型由 Google 在 2018 年发布，基于 Transformer。' }
]

describe('entity-norm（与 web entity_norm.py 同口径）', () => {
  it('归一键：折叠空白 + 小写；刻意不做全半角折叠', () => {
    expect(normalizeName('  LangChain  ')).toBe('langchain')
    expect(normalizeName('Deep\t Agents')).toBe('deep agents')
    expect(normalizeName('短期记忆（状态）')).toBe('短期记忆（状态）')
    expect(normalizeName('   ')).toBe('')
  })

  it('类型收窄：受控词表直通、旧词表折叠、未知回退「概念」', () => {
    expect(canonicalType('产品')).toBe('产品')
    expect(canonicalType('框架')).toBe('产品')
    expect(canonicalType('模型')).toBe('产品')
    expect(canonicalType('数据集')).toBe('产品')
    expect(canonicalType('技术')).toBe('概念')
    expect(canonicalType('不存在的类型')).toBe('概念')
    expect(canonicalType(undefined)).toBe('概念')
  })

  it('词表就是设计里的 8 类（提示词白名单同源）', () => {
    expect([...ENTITY_TYPES]).toEqual(['人物', '组织', '产品', '概念', '算法', '地点', '时间', '事件'])
  })
})

describe('buildWindows', () => {
  it('相邻切片合并到 ~2000 字符，保留切片引用', () => {
    const chunks = [
      { id: 1, index: 0, content: 'a'.repeat(1200) },
      { id: 2, index: 1, content: 'b'.repeat(700) },
      { id: 3, index: 2, content: 'c'.repeat(700) }
    ]
    const windows = buildWindows(chunks)
    expect(windows).toHaveLength(2)
    expect(windows[0].chunks.map((c) => c.id)).toEqual([1, 2])
    expect(windows[1].chunks.map((c) => c.id)).toEqual([3])
  })

  it('单个超长切片独占一个窗口（不丢内容）', () => {
    const windows = buildWindows([{ id: 1, index: 0, content: 'x'.repeat(5000) }])
    expect(windows).toHaveLength(1)
    expect(windows[0].text.length).toBe(5000)
  })

  it('空输入返回空数组', () => {
    expect(buildWindows([])).toEqual([])
  })
})

describe('convertExtraction（幻觉过滤 + 原文定位）', () => {
  const window = {
    text: 'Transformer 架构由 Vaswani 提出。BERT 基于 Transformer。',
    chunks: [
      { id: 11, index: 0, content: 'Transformer 架构由 Vaswani 提出。' },
      { id: 12, index: 1, content: 'BERT 基于 Transformer。' }
    ]
  }

  it('丢弃原文中不存在的实体（幻觉）', () => {
    const { entities } = convertExtraction(window, {
      entities: [
        { name: 'Transformer', type: '产品' },
        { name: '不存在的实体', type: '产品' }
      ],
      relations: []
    })
    expect(entities.map((item) => item.name)).toEqual(['Transformer'])
  })

  it('source_text 非原文子串时回退为实体名；类型折叠；chunk 定位到含该实体的切片', () => {
    const { entities } = convertExtraction(window, {
      entities: [
        { name: 'BERT', type: '模型', source_text: '这句是编的' },
        { name: 'Vaswani', type: '人物', source_text: 'Transformer 架构由 Vaswani 提出。' }
      ],
      relations: []
    })
    expect(entities[0]).toMatchObject({ nameKey: 'bert', type: '产品', sourceText: 'BERT', chunkId: 12 })
    expect(entities[1]).toMatchObject({ type: '人物', chunkId: 11, sourceText: 'Transformer 架构由 Vaswani 提出。' })
    expect(entities[1].charStart).toBeGreaterThanOrEqual(0)
  })

  it('关系两端必须是本次抽出的实体（精确同名），自环与悬挂边丢弃', () => {
    const { relations } = convertExtraction(window, {
      entities: [
        { name: 'Transformer', type: '产品' },
        { name: 'BERT', type: '产品' }
      ],
      relations: [
        { from: 'BERT', to: 'Transformer', label: '基于' },
        { from: 'BERT', to: 'Vaswani', label: '不存在' },
        { from: 'BERT', to: 'BERT', label: '自环' }
      ]
    })
    expect(relations).toHaveLength(1)
    expect(relations[0]).toMatchObject({ fromKey: 'bert', toKey: 'transformer', label: '基于', chunkId: 12 })
  })
})

describe('GraphService.extract', () => {
  function makeService(model: GraphChatModel): ReturnType<typeof createStoreFake> & {
    service: GraphService
  } {
    const fake = createStoreFake()
    const service = new GraphService({
      store: fake.store,
      resolveModel: async () => model
    })
    return { ...fake, service }
  }

  it('成功路径：入库实体与关系，返回计数', async () => {
    const model: GraphChatModel = {
      extract: async () => ({
        entities: [
          { name: 'Transformer', type: '产品', source_text: 'Transformer 架构' },
          { name: 'Vaswani', type: '人物', source_text: 'Vaswani' }
        ],
        relations: [{ from: 'Vaswani', to: 'Transformer', label: '提出' }]
      })
    }
    const { service, written } = makeService(model)
    const result = await service.extract({
      userId: 'u1',
      kbId: 'kb',
      docId: 'doc',
      chunks: CHUNKS,
      config: config()
    })
    expect(result).toEqual({ entities: 2, relations: 1 })
    expect(written[0].docId).toBe('doc')
    // 抽取请求带上了系统提示词（含 8 类白名单）
    expect(written).toHaveLength(1)
  })

  it('失败可见：窗口抽取一直失败 → 抛 GraphExtractionError（不静默）', async () => {
    const model: GraphChatModel = {
      extract: vi.fn(async () => {
        throw new Error('模型不可用(402)')
      })
    }
    const { service, written } = makeService(model)
    await expect(
      service.extract({ userId: 'u1', kbId: 'kb', docId: 'doc', chunks: CHUNKS, config: config() })
    ).rejects.toBeInstanceOf(GraphExtractionError)
    // 失败也要落一次库（清空旧图），保证「重抽失败 → 旧图不残留」
    expect(written).toHaveLength(1)
    expect(written[0].entities).toEqual([])
  })

  it('部分窗口失败：已抽到的部分仍然入库，且错误里带计数', async () => {
    let call = 0
    const model: GraphChatModel = {
      extract: async () => {
        call += 1
        // 第 1 个窗口成功；第 2 个窗口的两次尝试都失败
        if (call <= 1) {
          return {
            entities: [{ name: 'Transformer', type: '产品', source_text: 'Transformer' }],
            relations: []
          }
        }
        throw new Error('超时')
      }
    }
    const { service, written } = makeService(model)
    const longChunks = [
      { id: 1, index: 0, content: 'Transformer 架构。' },
      { id: 2, index: 1, content: `${'填充'.repeat(1100)}` }
    ]
    await expect(
      service.extract({
        userId: 'u1',
        kbId: 'kb',
        docId: 'doc',
        chunks: longChunks,
        config: config()
      })
    ).rejects.toThrow(/1\/2 个窗口抽取失败/)
    expect(written[0].entities).toHaveLength(1)
  })

  it('抽取重试：首次失败第二次成功不报错', async () => {
    let attempt = 0
    const model: GraphChatModel = {
      extract: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('偶发超时')
        return { entities: [{ name: 'BERT', type: '产品' }], relations: [] }
      }
    }
    const { service } = makeService(model)
    const result = await service.extract({
      userId: 'u1',
      kbId: 'kb',
      docId: 'doc',
      chunks: CHUNKS,
      config: config()
    })
    expect(result.entities).toBe(1)
    expect(attempt).toBe(2)
  })

  it('取消：抛出「已取消」且不落库', async () => {
    const controller = new AbortController()
    controller.abort()
    const model: GraphChatModel = { extract: vi.fn() }
    const { service, written } = makeService(model)
    await expect(
      service.extract({
        userId: 'u1',
        kbId: 'kb',
        docId: 'doc',
        chunks: CHUNKS,
        config: config(),
        signal: controller.signal
      })
    ).rejects.toThrow('已取消')
    expect(written).toHaveLength(0)
    expect(model.extract).not.toHaveBeenCalled()
  })
})

describe('parseExtractionText（思考模式降级的纯文本解析）', () => {
  it('直出 JSON：正常解析实体与关系', () => {
    const payload = parseExtractionText(
      '{"entities":[{"name":"Transformer","type":"产品","source_text":"Transformer"}],' +
        '"relations":[{"from":"Vaswani","to":"Transformer","label":"提出","description":""}]}'
    )
    expect(payload.entities).toEqual([
      { name: 'Transformer', type: '产品', source_text: 'Transformer' }
    ])
    expect(payload.relations).toHaveLength(1)
  })

  it('容忍 ```json 围栏与前后说明文字（取第一个配平的 JSON 对象）', () => {
    const text = [
      '好的，以下是抽取结果：',
      '```json',
      '{"entities":[{"name":"BERT","type":"产品"}],"relations":[]}',
      '```',
      '如需调整请告诉我。'
    ].join('\n')
    const payload = parseExtractionText(text)
    expect(payload.entities[0]).toMatchObject({ name: 'BERT', type: '产品' })
  })

  it('字符串值里的花括号 / 转义引号不影响括号配平', () => {
    const text = '{"entities":[{"name":"含{括号}的\\"名字\\"","type":"概念"}],"relations":[]}'
    const payload = parseExtractionText(text)
    expect(payload.entities[0].name).toBe('含{括号}的"名字"')
  })

  it('宽容归一：缺字段补默认、非数组容错、空名丢弃（类型留给下游折叠）', () => {
    const payload = parseExtractionText(
      '{"entities":[{"name":"甲"},{"type":"概念"}],"relations":[{"from":"甲","to":"乙"}]}'
    )
    expect(payload.entities).toEqual([{ name: '甲', type: '概念', source_text: '' }])
    expect(payload.relations[0]).toMatchObject({ from: '甲', to: '乙', label: '相关' })
    expect(parseExtractionText('{"entities":"oops","relations":null}')).toEqual({
      entities: [],
      relations: []
    })
  })

  it('空文本 / 无 JSON / 截断 JSON：抛出可读错误（走窗口失败计数）', () => {
    expect(() => parseExtractionText('')).toThrow('空文本')
    expect(() => parseExtractionText('抱歉，我无法完成')).toThrow('未返回 JSON')
    expect(() => parseExtractionText('{"entities":[')).toThrow('不完整')
  })
})

describe('isToolChoiceRejection（思考模式拒收强制 tool_choice 的判定）', () => {
  it('命中：DeepSeek 思考模式 400 原文', () => {
    expect(
      isToolChoiceRejection(
        new Error('400 Thinking mode does not support this tool_choice (request_id: d223362c)')
      )
    ).toBe(true)
  })

  it('命中：任何提到 tool_choice 的错误', () => {
    expect(isToolChoiceRejection(new Error('Invalid parameter: tool_choice'))).toBe(true)
  })

  it('不误伤：超时 / 额度 / 空错误不触发降级', () => {
    expect(isToolChoiceRejection(new Error('Request timed out'))).toBe(false)
    expect(isToolChoiceRejection(new Error('402 Insufficient Balance'))).toBe(false)
    expect(isToolChoiceRejection(undefined)).toBe(false)
  })
})
