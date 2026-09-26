import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 图谱接口的响应映射（迭代 6 T6.5）。
 *
 * 这里盯两件容易**静默**出错的事：
 *
 * 1. 后端把 404 编在响应体的 `code` 里（HTTP 状态恒为 200）——不看体就会把"实体不存在"
 *    当成一次成功的空响应；
 * 2. 边的两端挂 `from_key`/`to_key`（归一键），回退才是展示名——回退用错会让边挂到
 *    节点集里不存在的 id 上，前端随后把它们静默丢掉（useKnowledgeGraph 的过滤）。
 */

const get = vi.fn()
const post = vi.fn()

vi.mock('@/services/request', () => ({
  default: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
  ApiError: class ApiError extends Error {
    constructor(
      public code: string | number,
      message: string,
    ) {
      super(message)
    }
  },
  getAccessToken: () => 'token',
  getStreamToken: () => 'token',
}))

const { ApiError } = await import('@/services/request')
const { fetchEntityDetail, fetchGraphData } = await import('@/services/knowledgeBaseApi')

beforeEach(() => {
  get.mockReset()
  post.mockReset()
})

describe('fetchGraphData', () => {
  it('边的两端用归一键，不用展示名', async () => {
    get.mockResolvedValue({
      data: {
        code: 0,
        data: {
          entities: [{ id: 'langchain', name: 'LangChain', type: '产品', mentions: 2 }],
          relations: [
            {
              id: 'r1',
              from_key: 'langchain',
              to_key: 'openai',
              from_entity: 'LangChain',
              to_entity: 'OpenAI',
              label: '使用',
              weight: 2,
            },
          ],
        },
      },
    })

    const result = await fetchGraphData('kb-1')

    expect(result.relations[0].from).toBe('langchain')
    expect(result.relations[0].to).toBe('openai')
    // 节点 id 与边端点必须同口径，否则边会被前端丢掉
    expect(result.entities.map((e) => e.id)).toContain(result.relations[0].from)
  })

  it('缺 key 时回退到展示名，不至于让边整条消失', async () => {
    get.mockResolvedValue({
      data: {
        code: 0,
        data: {
          entities: [],
          relations: [
            { id: 'r1', from_entity: 'A', to_entity: 'B', label: '使用', weight: 1 },
          ],
        },
      },
    })

    const result = await fetchGraphData('kb-1')
    expect(result.relations[0].from).toBe('A')
    expect(result.relations[0].to).toBe('B')
  })
})

describe('fetchEntityDetail', () => {
  const detail = {
    id: 'langchain',
    name: 'LangChain',
    type: '产品',
    mentions: 2,
    source_text: 'LangChain 是一个框架',
    documents: [
      { id: 'doc-1', name: '方案.md' },
      { id: 'doc-2', name: '调研.md' },
    ],
    relations: [
      {
        id: 'r1',
        from_key: 'langchain',
        to_key: 'openai',
        from_entity: 'LangChain',
        to_entity: 'OpenAI',
        label: '使用',
        weight: 1,
      },
    ],
  }

  it('把归一键拼进路径并做转义', async () => {
    get.mockResolvedValue({ data: { code: 0, data: detail } })

    await fetchEntityDetail('kb-1', 'a/b c')

    const [url] = get.mock.calls[0]
    expect(url).toBe('/knowledge-bases/kb-1/graph/entities/a%2Fb%20c')
  })

  it('返回来源文档——点开节点最想知道的就是这个', async () => {
    get.mockResolvedValue({ data: { code: 0, data: detail } })

    const result = await fetchEntityDetail('kb-1', 'langchain')

    expect(result?.documents.map((d) => d.name)).toEqual(['方案.md', '调研.md'])
    expect(result?.mentions).toBe(2)
  })

  it('code=404 视为"不存在"而不是错误', async () => {
    // 关键：响应拦截器对**任何非零 code 都 reject**（request.ts:62），所以后端的
    // `code: 404` 是以**异常**形式到达的，不是响应体。第一版用例把它写成 resolved
    // 响应，结果去掉 code 判断也照样通过——空转。这里按真实链路模拟为 rejection。
    get.mockRejectedValue(new ApiError(404, '实体不存在'))

    expect(await fetchEntityDetail('kb-1', '不存在')).toBeNull()
  })

  it('其它错误照常抛出，不被静默当成"不存在"', async () => {
    get.mockRejectedValue(new ApiError(500, '服务器错误'))

    await expect(fetchEntityDetail('kb-1', 'langchain')).rejects.toThrow('服务器错误')
  })

  it('缺字段时给出空数组而不是 undefined', async () => {
    get.mockResolvedValue({ data: { code: 0, data: { ...detail, documents: undefined } } })

    const result = await fetchEntityDetail('kb-1', 'langchain')
    expect(result?.documents).toEqual([])
  })
})
