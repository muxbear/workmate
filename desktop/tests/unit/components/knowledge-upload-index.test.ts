import { describe, expect, it } from 'vitest'
import {
  INDEX_FIELD_KEYS,
  KNOWLEDGE_INDEX_STEPS,
  KNOWLEDGE_UPLOAD_OPTIONS,
  UPLOAD_FIELD_KEYS,
  formatIndexValue,
  pickIndexConfig,
  summarizeIndexConfig,
  uploadResultText
} from '../../../src/renderer/src/components/knowledge/uploadIndex'
import {
  KNOWLEDGE_FIELD_DEFS,
  KNOWLEDGE_FIELD_LIST
} from '../../../src/renderer/src/components/knowledge/knowledgeFields'
import type { KnowledgeOverrides } from '../../../src/preload/index.d'

/**
 * 上传弹窗「三选一 + 自定义索引向导」的静态定义验证
 *
 * 重点：向导步骤必须与「知识库设置」的索引项一一对应（不漏不重），
 * 否则上传时能配置的索引项会和设置页漂移。
 */
describe('上传后处理选项', () => {
  it('三个单选项，顺序与取值固定', () => {
    expect(KNOWLEDGE_UPLOAD_OPTIONS.map((option) => option.value)).toEqual([
      'default',
      'custom',
      'none'
    ])
    expect(KNOWLEDGE_UPLOAD_OPTIONS.map((option) => option.label)).toEqual([
      '创建默认索引',
      '自定义索引',
      '只上传文件'
    ])
    for (const option of KNOWLEDGE_UPLOAD_OPTIONS) {
      expect(option.description.length).toBeGreaterThan(0)
    }
  })
})

describe('索引项清单', () => {
  it('= 全部配置项 - 上传相关 3 项', () => {
    const all = KNOWLEDGE_FIELD_LIST.map((field) => field.key)
    expect(UPLOAD_FIELD_KEYS).toEqual(['maxUploadSize', 'uploadTimeout', 'maxFilesPerBatch'])
    expect(INDEX_FIELD_KEYS).toEqual(all.filter((key) => !UPLOAD_FIELD_KEYS.includes(key)))
    expect(INDEX_FIELD_KEYS).toHaveLength(14)
    expect(INDEX_FIELD_KEYS.length + UPLOAD_FIELD_KEYS.length).toBe(all.length)
  })
})

describe('自定义索引向导', () => {
  it('步骤覆盖全部索引项，不漏不重', () => {
    const stepKeys = KNOWLEDGE_INDEX_STEPS.flatMap((step) => step.keys)
    expect([...stepKeys].sort()).toEqual([...INDEX_FIELD_KEYS].sort())
    expect(new Set(stepKeys).size).toBe(stepKeys.length)
  })

  it('每一步都有标题、说明与非空字段，且字段在字段表里存在', () => {
    for (const step of KNOWLEDGE_INDEX_STEPS) {
      expect(step.title.length).toBeGreaterThan(0)
      expect(step.description.length).toBeGreaterThan(0)
      expect(step.keys.length).toBeGreaterThan(0)
      for (const key of step.keys) {
        expect(KNOWLEDGE_FIELD_DEFS[key]).toBeDefined()
      }
    }
  })
})

describe('配置摘要与提交', () => {
  const values: KnowledgeOverrides = {
    maxUploadSize: 200,
    chunkStrategy: 'semantic',
    chunkSize: 800,
    vectorDimensions: 1024,
    rerankEnabled: true,
    graphEnabled: false,
    graphModel: 'GLM-5'
  }

  it('摘要按索引项顺序给出标签与展示值', () => {
    const rows = summarizeIndexConfig(values)
    expect(rows.map((row) => row.key)).toEqual([...INDEX_FIELD_KEYS])
    expect(rows.find((row) => row.key === 'chunkStrategy')?.label).toBe('默认切片算法')
    expect(rows.find((row) => row.key === 'chunkStrategy')?.text).toBe('智能语义切分')
    expect(rows.find((row) => row.key === 'chunkSize')?.text).toBe('800 tokens')
    expect(rows.find((row) => row.key === 'rerankEnabled')?.text).toBe('开启')
    expect(rows.find((row) => row.key === 'graphEnabled')?.text).toBe('关闭')
  })

  it('未设置的项显示「未设置」', () => {
    expect(formatIndexValue('embeddingModel', undefined)).toBe('未设置')
    expect(formatIndexValue('bm25K1', '')).toBe('未设置')
  })

  it('落库配置只保留索引项', () => {
    const picked = pickIndexConfig(values)
    expect(Object.keys(picked).sort()).toEqual([...INDEX_FIELD_KEYS].sort())
    expect(picked.maxUploadSize).toBeUndefined()
    expect(picked.chunkSize).toBe(800)
  })

  it('三种处理方式各自的结果文案', () => {
    expect(uploadResultText('default', 3, '全局索引配置')).toBe(
      '已上传 3 个文件，将按全局索引配置建立索引'
    )
    expect(uploadResultText('custom', 3, '自定义索引配置')).toBe(
      '已上传 3 个文件，将按自定义索引配置建立索引'
    )
    expect(uploadResultText('none', 3, '')).toBe('已上传 3 个文件，未建立索引')
  })
})
