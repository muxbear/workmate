import { describe, expect, it } from 'vitest'
import {
  DOC_BADGE,
  STAGE_NAMES,
  STAGE_ORDER,
  STAGE_PROGRESS,
  computeIndexStages,
  resolveDocBadgeKind,
  stageIndexFromError,
  stageIndexFromProgress
} from '../../../src/renderer/src/components/knowledge/indexStages'

describe('indexStages · 常量口径（与 web / 主进程一致）', () => {
  it('阶段与名称一一对应，共七个', () => {
    expect(STAGE_ORDER).toHaveLength(7)
    expect(Object.keys(STAGE_NAMES)).toHaveLength(7)
    for (const stage of STAGE_ORDER) expect(STAGE_NAMES[stage]).toBeTruthy()
  })

  it('进度基准与 web / 主进程逐值一致（0/3/15/30/55/70/100）', () => {
    expect(STAGE_ORDER.map((stage) => STAGE_PROGRESS[stage])).toEqual([0, 3, 15, 30, 55, 70, 100])
  })

  it('徽标文案与 web DOC_STATUS_CONFIG 一致', () => {
    expect(DOC_BADGE.queued.label).toBe('排队')
    expect(DOC_BADGE.parsing.label).toBe('解析中')
    expect(DOC_BADGE.chunking.label).toBe('切片中')
    expect(DOC_BADGE.embedding.label).toBe('向量化')
    expect(DOC_BADGE.bm25.label).toBe('BM25 倒排')
    expect(DOC_BADGE.extracting.label).toBe('实体抽取')
    expect(DOC_BADGE.indexed.label).toBe('已索引')
    expect(DOC_BADGE.failed.label).toBe('失败')
  })
})

describe('resolveDocBadgeKind', () => {
  it('queued / indexed / failed 各归其类', () => {
    expect(resolveDocBadgeKind({ status: 'queued' })).toBe('queued')
    expect(resolveDocBadgeKind({ status: 'indexed' })).toBe('indexed')
    expect(resolveDocBadgeKind({ status: 'failed' })).toBe('failed')
  })

  it('indexing 优先用记录中的阶段', () => {
    expect(resolveDocBadgeKind({ status: 'indexing', stage: 'chunking' })).toBe('chunking')
    expect(resolveDocBadgeKind({ status: 'indexing', stage: 'bm25' })).toBe('bm25')
  })

  it('indexing 阶段缺失时按进度区间反查', () => {
    expect(resolveDocBadgeKind({ status: 'indexing', stage: null, progress: 55 })).toBe('bm25')
    expect(resolveDocBadgeKind({ status: 'indexing', stage: null, progress: 30 })).toBe('embedding')
    expect(resolveDocBadgeKind({ status: 'indexing', stage: null, progress: 15 })).toBe('chunking')
    expect(resolveDocBadgeKind({ status: 'indexing', stage: null, progress: 3 })).toBe('parsing')
    expect(resolveDocBadgeKind({ status: 'indexing', stage: null, progress: 0 })).toBe('queued')
  })

  it('none / 未知状态返回 null（页面落回未索引、自定义索引标签）', () => {
    expect(resolveDocBadgeKind({ status: 'none' })).toBeNull()
    expect(resolveDocBadgeKind({ status: undefined })).toBeNull()
    expect(resolveDocBadgeKind({ status: 'whatever' })).toBeNull()
  })
})

describe('stageIndexFromProgress / stageIndexFromError', () => {
  it('进度反查取「基准值不超过进度的最后阶段」', () => {
    expect(stageIndexFromProgress(0)).toBe(0)
    expect(stageIndexFromProgress(3)).toBe(1)
    expect(stageIndexFromProgress(14)).toBe(1)
    expect(stageIndexFromProgress(15)).toBe(2)
    expect(stageIndexFromProgress(55)).toBe(4)
    expect(stageIndexFromProgress(70)).toBe(5)
    expect(stageIndexFromProgress(100)).toBe(6)
    expect(stageIndexFromProgress(null)).toBe(0)
  })

  it('错误关键词兜底：向量化 / 切片 / BM25|稀疏 / 实体|关系|图谱 / 解析，默认解析', () => {
    expect(stageIndexFromError('向量化失败: timeout')).toBe(3)
    expect(stageIndexFromError('切片阶段出错')).toBe(2)
    expect(stageIndexFromError('BM25 写入失败')).toBe(4)
    expect(stageIndexFromError('稀疏索引异常')).toBe(4)
    expect(stageIndexFromError('关系抽取失败')).toBe(5)
    expect(stageIndexFromError('图谱写入失败')).toBe(5)
    expect(stageIndexFromError('解析失败')).toBe(1)
    expect(stageIndexFromError('未知错误')).toBe(1)
    expect(stageIndexFromError(null)).toBe(1)
    // 兜底下标必须落在阶段数组范围内
    expect(stageIndexFromError('未知错误')).toBeLessThan(STAGE_ORDER.length)
  })
})

describe('computeIndexStages', () => {
  it('indexed：全部 done 且无 running/pending（web 回归点）', () => {
    const stages = computeIndexStages({ status: 'indexed', progress: 100 })
    expect(stages.map((stage) => stage.status)).toEqual(Array(7).fill('done'))
    expect(stages.every((stage) => stage.pct === 100)).toBe(true)
    expect(stages.some((stage) => stage.status === 'running' || stage.status === 'pending')).toBe(
      false
    )
  })

  it('queued：排队 running，其余 pending', () => {
    const stages = computeIndexStages({ status: 'queued', progress: 0 })
    expect(stages[0]).toEqual({ name: '排队', status: 'running', pct: 0 })
    expect(stages.slice(1).every((stage) => stage.status === 'pending')).toBe(true)
  })

  it('indexing + 记录阶段：之前 done、当前 running、之后 pending', () => {
    const stages = computeIndexStages({ status: 'indexing', stage: 'embedding', progress: 30 })
    expect(stages.map((stage) => stage.status)).toEqual([
      'done',
      'done',
      'done',
      'running',
      'pending',
      'pending',
      'pending'
    ])
    expect(stages[3].pct).toBe(30)
  })

  it('indexing + 阶段缺失（老数据）：按进度反查', () => {
    const stages = computeIndexStages({ status: 'indexing', stage: null, progress: 30 })
    expect(stages[3].status).toBe('running')
    expect(stages[3].pct).toBe(30)
  })

  it('failed + 记录阶段：中断阶段标 failed', () => {
    const stages = computeIndexStages({ status: 'failed', stage: 'embedding' })
    expect(stages.map((stage) => stage.status)).toEqual([
      'done',
      'done',
      'done',
      'failed',
      'pending',
      'pending',
      'pending'
    ])
  })

  it('failed + 阶段缺失：进度区间优先于关键词', () => {
    const stages = computeIndexStages({
      status: 'failed',
      stage: null,
      progress: 55,
      errorMessage: '向量化失败'
    })
    expect(stages[4].status).toBe('failed')
  })

  it('failed + 进度为 0：按 progress 反查归到排队（与 web 一致）', () => {
    const stages = computeIndexStages({
      status: 'failed',
      stage: null,
      progress: 0,
      errorMessage: '应用退出中断，请重新索引'
    })
    expect(stages[0].status).toBe('failed')
  })

  it('failed + 无进度：回退到错误关键词', () => {
    const stages = computeIndexStages({
      status: 'failed',
      stage: null,
      progress: null,
      errorMessage: '向量化失败: timeout'
    })
    expect(stages[3].status).toBe('failed')
  })

  it('failed + 无进度无关键词：默认归到解析', () => {
    const stages = computeIndexStages({
      status: 'failed',
      stage: null,
      progress: null,
      errorMessage: '未知错误'
    })
    expect(stages[1].status).toBe('failed')
  })

  it('none / 未知状态：全部 pending', () => {
    for (const status of ['none', 'whatever', undefined]) {
      const stages = computeIndexStages({ status })
      expect(stages.every((stage) => stage.status === 'pending')).toBe(true)
    }
  })

  it('纯函数：不修改入参，每次都返回新数组', () => {
    const input = { status: 'indexing', stage: 'parsing', progress: 3 }
    const before = JSON.stringify(input)
    const first = computeIndexStages(input)
    const second = computeIndexStages(input)
    expect(JSON.stringify(input)).toBe(before)
    expect(first).not.toBe(second)
    first[0].status = 'pending'
    expect(second[0].status).toBe('done')
  })
})
