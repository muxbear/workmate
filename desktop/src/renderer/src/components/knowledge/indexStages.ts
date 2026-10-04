/**
 * 索引阶段与状态徽标的纯函数（口径对齐 web 后端与主进程）
 *
 * 阶段真源是 web 后端 `web/backend/src/api/knowledge_base/doc_service.py`
 * （STAGE_NAMES / STAGE_STATUS_ORDER / STAGE_PROGRESS），桌面主进程
 * `KnowledgeIndexService.ts` 的 STAGE_PROGRESS 与其逐值一致（0/3/15/30/55/70/100）。
 * 本模块只做「原始状态 → 展示模型」的映射，不依赖 Vue，便于单测
 * （同 knowledgeList.ts / knowledgeTree.ts 的做法）。
 *
 * 两个展示面共用这里的口径：
 * - 表格「状态」列的徽标文案（对齐 web DOC_STATUS_CONFIG）；
 * - 右侧「索引进度」流水线的阶段列表（对齐 web compute_stages）。
 */

/** 七个固定阶段（与主进程 KnowledgeIndexStage 一致） */
export const STAGE_ORDER = [
  'queued',
  'parsing',
  'chunking',
  'embedding',
  'bm25',
  'extracting',
  'indexed'
] as const
export type IndexStageName = (typeof STAGE_ORDER)[number]

/** 流水线面板里的阶段名（web STAGE_NAMES 原文） */
export const STAGE_NAMES: Record<IndexStageName, string> = {
  queued: '排队',
  parsing: '解析',
  chunking: '切片',
  embedding: '向量化',
  bm25: '稀疏索引',
  extracting: '实体关系抽取',
  indexed: '完成'
}

/** 阶段进度基准（进入该阶段时的累计百分比，web 与主进程同值） */
export const STAGE_PROGRESS: Record<IndexStageName, number> = {
  queued: 0,
  parsing: 3,
  chunking: 15,
  embedding: 30,
  bm25: 55,
  extracting: 70,
  indexed: 100
}

/** 状态徽标种类（web DOC_STATUS_CONFIG 的桌面映射） */
export type DocBadgeKind =
  | 'queued'
  | 'parsing'
  | 'chunking'
  | 'embedding'
  | 'bm25'
  | 'extracting'
  | 'indexed'
  | 'failed'

/** 徽标文案与配色类名（文案是 web 原文；配色抄 web KbDocStatusBadge.vue） */
export const DOC_BADGE: Record<DocBadgeKind, { label: string; cls: string }> = {
  queued: { label: '排队', cls: 'kb-doc-badge--queued' },
  parsing: { label: '解析中', cls: 'kb-doc-badge--parsing' },
  chunking: { label: '切片中', cls: 'kb-doc-badge--chunking' },
  embedding: { label: '向量化', cls: 'kb-doc-badge--embedding' },
  bm25: { label: 'BM25 倒排', cls: 'kb-doc-badge--bm25' },
  extracting: { label: '实体抽取', cls: 'kb-doc-badge--extracting' },
  indexed: { label: '已索引', cls: 'kb-doc-badge--indexed' },
  failed: { label: '失败', cls: 'kb-doc-badge--failed' }
}

/** 可作「正在执行」展示的阶段（不含 queued/indexed 两个端点） */
const RUNNING_STAGES = new Set<IndexStageName>(['parsing', 'chunking', 'embedding', 'bm25', 'extracting'])

/**
 * 主进程文档状态 → 徽标种类。
 *
 * - `indexing` 优先用记录中的阶段；阶段缺失（老数据）按进度区间反查；
 * - `none` / 未知返回 null——页面落回桌面自己的「未索引 / 自定义索引」标签。
 */
export function resolveDocBadgeKind(input: {
  status?: string | null
  stage?: string | null
  progress?: number | null
}): DocBadgeKind | null {
  const status = input.status ?? ''
  if (status === 'queued') return 'queued'
  if (status === 'indexed') return 'indexed'
  if (status === 'failed') return 'failed'
  if (status !== 'indexing') return null
  const stage = input.stage ?? ''
  if (RUNNING_STAGES.has(stage as IndexStageName)) return stage as DocBadgeKind
  const byProgress = STAGE_ORDER[stageIndexFromProgress(input.progress)]
  return byProgress === 'indexed' ? 'extracting' : byProgress
}

/**
 * 进度值 → 阶段下标：取「基准值不超过该进度的最后阶段」。
 * 对齐 web `_resolve_stopped_stage` 的进度反查（progress 优先于错误文案）。
 */
export function stageIndexFromProgress(progress: number | null | undefined): number {
  const value = typeof progress === 'number' && Number.isFinite(progress) ? progress : 0
  let index = 0
  for (let i = 0; i < STAGE_ORDER.length; i += 1) {
    if (STAGE_PROGRESS[STAGE_ORDER[i]] <= value) index = i
  }
  return index
}

/** 错误文案关键词兜底（对齐 web `_infer_failed_stage_index`，默认归到「解析」） */
export function stageIndexFromError(errorMessage: string | null | undefined): number {
  const text = errorMessage ?? ''
  if (/向量化/.test(text)) return 3
  if (/切片/.test(text)) return 2
  if (/BM25|稀疏/i.test(text)) return 4
  if (/实体|关系|图谱/.test(text)) return 5
  return 1
}

export type IndexStageStatus = 'done' | 'running' | 'pending' | 'failed'

/** 流水线面板的一行 */
export interface IndexStageItem {
  name: string
  status: IndexStageStatus
  /** 运行中阶段的进度（该阶段基准值）；已完成 100，其余 0 */
  pct: number
}

/**
 * 文档状态 → 七阶段流水线（语义对齐 web compute_stages）：
 * 已走过的阶段 done、当前阶段 running、未到的 pending；
 * 失败文档把中断阶段标 failed（记录的阶段 → 进度区间 → 错误关键词，逐级兜底）。
 */
export function computeIndexStages(input: {
  status?: string | null
  stage?: string | null
  progress?: number | null
  errorMessage?: string | null
}): IndexStageItem[] {
  const status = input.status ?? ''
  const pending: IndexStageItem[] = STAGE_ORDER.map((stage) => ({
    name: STAGE_NAMES[stage],
    status: 'pending' as const,
    pct: 0
  }))

  if (status === 'none' || status === '') return pending

  const markDoneBefore = (items: IndexStageItem[], index: number): void => {
    for (let i = 0; i < index; i += 1) {
      items[i] = { ...items[i], status: 'done', pct: 100 }
    }
  }

  if (status === 'indexed') {
    return STAGE_ORDER.map((stage) => ({
      name: STAGE_NAMES[stage],
      status: 'done' as const,
      pct: 100
    }))
  }

  if (status === 'queued') {
    const items = [...pending]
    items[0] = { ...items[0], status: 'running', pct: STAGE_PROGRESS.queued }
    return items
  }

  if (status === 'failed') {
    const recorded = STAGE_ORDER.indexOf((input.stage ?? '') as IndexStageName)
    const hasProgress = typeof input.progress === 'number' && Number.isFinite(input.progress)
    const index =
      recorded >= 0
        ? recorded
        : hasProgress
          ? stageIndexFromProgress(input.progress)
          : stageIndexFromError(input.errorMessage)
    const items = [...pending]
    markDoneBefore(items, index)
    items[index] = { ...items[index], status: 'failed' }
    return items
  }

  if (status === 'indexing') {
    const recorded = STAGE_ORDER.indexOf((input.stage ?? '') as IndexStageName)
    const index =
      recorded >= 0 ? recorded : stageIndexFromProgress(input.progress)
    const items = [...pending]
    markDoneBefore(items, index)
    items[index] = {
      ...items[index],
      status: 'running',
      pct: STAGE_PROGRESS[STAGE_ORDER[index]]
    }
    return items
  }

  return pending
}
