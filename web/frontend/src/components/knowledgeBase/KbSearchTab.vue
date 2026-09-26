<script setup lang="ts">
import { ref, computed, reactive } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Search, Zap, Sparkle, Hash, Wand2, FileSearch, AlertTriangle, SlidersHorizontal, Quote,
} from 'lucide-vue-next'
import type { KB, SearchMode, SearchResult, ScoreKind } from '@/types/knowledgeBase'
import { SCORE_KIND_LABEL } from '@/types/knowledgeBase'
import * as kbApi from '@/services/knowledgeBaseApi'
import { readApiError } from '@/services/knowledgeBaseApi'

const props = defineProps<{
  kb: KB
}>()

const mode = ref<SearchMode>('hybrid')
const query = ref('')
const results = ref<SearchResult[]>([])
const searched = ref(false)
const searching = ref(false)
/** 知识库配置要求精排 */
const rerankRequested = ref(false)
/** 精排是否真的生效（模型不可用/接口报错时为 false，此时结果是召回原始顺序） */
const rerankApplied = ref(false)
/** 判定「库里没有相关内容」——与"检索失败"是两回事 */
const noRelevantResult = ref(false)
/** 检索失败原因——失败时页面上要留痕，不能只有一个转瞬即逝的 toast */
const searchError = ref('')
/** 本次生效的最低余弦门槛与过滤条数 */
const effectiveMinSimilarity = ref<number | null>(null)
const filteredCount = ref(0)
/** 本次因近重复/单文档配额被丢弃的条数 */
const dedupedCount = ref(0)
/** 本次实际检索的知识库（>1 时说明是跨库检索，结果需标注来源） */
const searchedKbCount = ref(0)
/** 知识库配置要求做查询改写 */
const rewriteRequested = ref(false)
/** 改写是否真的生效（未配 LLM / 超时 / 解析失败时为 false） */
const rewriteApplied = ref(false)
/** 本次实际参与召回的查询变体（首条恒为原始查询） */
const rewriteQueries = ref<string[]>([])
/** 本次是否额外用了一路 HyDE 假设文档 */
const rewriteHyde = ref(false)
/** 改写未生效的原因 */
const rewriteReason = ref('')

/** 高级参数是否展开 */
const showAdvanced = ref(false)

/**
 * 高级检索参数——留空表示"用知识库配置"。
 *
 * 这几项都是**单次检索的覆盖**，不改知识库配置；想改默认值请去「索引配置」页签。
 */
const advanced = reactive<{
  topK: number | null
  alpha: number | null
  minSimilarity: number | null
  scoreThreshold: number
  enableRerank: boolean
  maxChunksPerDoc: number
  dedupSimilarity: number
  docIds: string[]
  docTypes: string[]
  useRewrite: boolean
  useHyde: boolean
}>({
  topK: null,
  alpha: null,
  minSimilarity: null,
  scoreThreshold: 0,
  enableRerank: true,
  maxChunksPerDoc: 0,      // 0 表示不限制（沿用知识库配置时也传默认值）
  dedupSimilarity: 0.92,
  docIds: [],
  docTypes: [],
  // 查询改写每次都要多调一次 LLM，默认跟随知识库配置（未配置时后端默认关闭）
  useRewrite: false,
  useHyde: false,
})

/** 可选的文件类型（取自该知识库已上传的文档，去重后排序） */
const availableDocTypes = computed(() =>
  [...new Set(props.kb.documents.map((d) => d.type))].sort(),
)

/** 当前生效的 Top-K（未覆盖时用知识库配置） */
const effectiveTopK = computed(() => advanced.topK ?? props.kb.config.topK ?? 5)

const relevanceLabel = (scoreKind: SearchResult['scoreKind'], score: number, index: number) => {
  // 相关度标签按"分数含义 + 排名"给出，避免把不同量纲的分都叫"综合分"
  if (scoreKind === 'rerank') {
    if (score >= 0.6) return { text: '高相关', cls: 'rel-high' }
    if (score >= 0.3) return { text: '相关', cls: 'rel-mid' }
    return { text: '弱相关', cls: 'rel-low' }
  }
  if (scoreKind === 'cosine') {
    if (score >= 0.7) return { text: '高相关', cls: 'rel-high' }
    if (score >= 0.55) return { text: '相关', cls: 'rel-mid' }
    return { text: '弱相关', cls: 'rel-low' }
  }
  // 融合分 / BM25 没有绝对量纲，只能按名次给"排序位次"而非相关度承诺
  return index < 3
    ? { text: '排序靠前', cls: 'rel-mid' }
    : { text: '排序靠后', cls: 'rel-low' }
}

const scoreTitle = (r: SearchResult) => {
  const label = r.scoreKind ? SCORE_KIND_LABEL[r.scoreKind as ScoreKind] : '得分'
  const parts = [`${label}: ${r.score.toFixed(3)}`]
  if (r.vec !== null) parts.push(`余弦相似度: ${r.vec.toFixed(3)}`)
  if (r.bm25 !== null) parts.push(`BM25: ${r.bm25.toFixed(2)}`)
  return parts.join('\n')
}

/** 复制引用（文档名 + 章节 + 页码），便于粘到别的文档里核对来源 */
async function copyCitation(r: SearchResult) {
  const where = [r.section, r.page ? `第 ${r.page} 页` : ''].filter(Boolean).join(' · ')
  const text = `《${r.doc}》${where ? ` ${where}` : ''}（切片 #${r.chunkIndex}）`
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已复制引用')
  } catch {
    ElMessage.warning(text)
  }
}

const modeOptions: { key: SearchMode; label: string; desc: string; icon: typeof Sparkle }[] = [
  { key: 'hybrid', label: '混合检索', desc: '向量 + BM25 融合', icon: Wand2 },
  { key: 'vector', label: '向量检索', desc: '稠密语义', icon: Sparkle },
  { key: 'bm25', label: 'BM25', desc: '稀疏关键词', icon: Hash },
]

const currentConfig = computed(() => [
  `Embedding: ${props.kb.config.embeddingModel}`,
  `Top-K: ${effectiveTopK.value}`,
  mode.value === 'hybrid' ? `α: ${advanced.alpha ?? props.kb.config.hybridAlpha}` : '',
  props.kb.config.rerankerModel
    ? `Reranker: ${props.kb.config.rerankerModel}`
    : '',
  `相似度门槛: ${advanced.minSimilarity ?? props.kb.config.minSimilarity ?? 0.53}`,
].filter(Boolean).join(' · '))

async function runSearch() {
  const q = query.value.trim()
  if (!q) return
  searching.value = true
  try {
    searchError.value = ''
    const outcome = await kbApi.searchKnowledgeBase(
      props.kb.id,
      q,
      mode.value,
      effectiveTopK.value,
      {
        alpha: advanced.alpha ?? undefined,
        minSimilarity: advanced.minSimilarity ?? undefined,
        scoreThreshold: advanced.scoreThreshold || undefined,
        enableRerank: advanced.enableRerank,
        maxChunksPerDoc: advanced.maxChunksPerDoc,
        dedupSimilarity: advanced.dedupSimilarity,
        docIds: advanced.docIds.length ? advanced.docIds : undefined,
        docTypes: advanced.docTypes.length ? advanced.docTypes : undefined,
        useRewrite: advanced.useRewrite || undefined,
        useHyde: advanced.useRewrite && advanced.useHyde ? true : undefined,
      },
    )
    results.value = outcome.results
    rerankRequested.value = outcome.rerankRequested
    rerankApplied.value = outcome.rerankApplied
    noRelevantResult.value = outcome.noRelevantResult
    effectiveMinSimilarity.value = outcome.minSimilarity
    filteredCount.value = outcome.filteredCount
    dedupedCount.value = outcome.dedupedCount
    searchedKbCount.value = outcome.searchedKbIds.length
    rewriteRequested.value = outcome.rewriteRequested
    rewriteApplied.value = outcome.rewriteApplied
    rewriteQueries.value = outcome.rewriteQueries
    rewriteHyde.value = outcome.rewriteHyde
    rewriteReason.value = outcome.rewriteReason
    searched.value = true
  } catch (err: unknown) {
    // 此前只 console.error：检索失败时用户看到的是"命中 0 条"，无从判断原因
    const msg = readApiError(err)
    results.value = []
    rerankRequested.value = false
    rerankApplied.value = false
    noRelevantResult.value = false
    filteredCount.value = 0
    rewriteRequested.value = false
    rewriteApplied.value = false
    rewriteQueries.value = []
    rewriteHyde.value = false
    rewriteReason.value = ''
    searchError.value = msg
    searched.value = true
    ElMessage.error(msg)
    console.error('Search failed:', msg)
  } finally {
    searching.value = false
  }
}

/** 改写生效时展示的变体（不含原始查询——它就是用户输入的那个） */
const rewriteExtras = computed(() => rewriteQueries.value.slice(1))
/** 本次召回用了几路（HyDE 假设文档也是一路，但它不出现在查询列表里） */
const rewriteVariantCount = computed(
  () => rewriteQueries.value.length + (rewriteHyde.value ? 1 : 0),
)

function highlightText(text: string): { text: string; hl: boolean }[] {
  const q = query.value.trim()
  if (!q) return [{ text, hl: false }]
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'))
  return parts.map((p) => ({
    text: p,
    hl: p.toLowerCase() === q.toLowerCase(),
  }))
}
</script>

<template>
  <div class="search-tab">
    <!-- 检索面板 -->
    <div class="card search-panel">
      <!-- 模式选择 -->
      <div class="mode-row">
        <button
          v-for="opt in modeOptions"
          :key="opt.key"
          :class="['mode-card', { 'mode-active': mode === opt.key }]"
          @click="mode = opt.key"
        >
          <div class="mode-header">
            <component :is="opt.icon" :size="16" :class="mode === opt.key ? 'text-blue-300' : 'text-slate-400'" />
            <span :class="mode === opt.key ? 'text-white' : 'text-slate-300'">{{ opt.label }}</span>
          </div>
          <div class="mode-desc">{{ opt.desc }}</div>
        </button>
      </div>

      <!-- 查询输入 -->
      <div class="query-row">
        <div class="search-input-wrap">
          <Search :size="18" class="q-search-icon" />
          <input
            v-model="query"
            type="text"
            placeholder="输入查询语句…"
            class="q-input"
            @keyup.enter="runSearch"
          />
        </div>
        <button class="btn-search" @click="runSearch" :disabled="searching">
          <Zap :size="16" class="btn-icon" />检索
        </button>
      </div>

      <div class="advanced-toggle">
        <button class="link-btn" @click="showAdvanced = !showAdvanced">
          <SlidersHorizontal :size="14" />
          {{ showAdvanced ? '收起高级参数' : '高级参数（Top-K / 权重 / 相似度门槛 / 精排）' }}
        </button>
      </div>

      <div v-if="showAdvanced" class="advanced-panel">
        <div class="adv-item">
          <span class="adv-label">返回条数 Top-K</span>
          <el-slider
            :model-value="effectiveTopK"
            :min="1"
            :max="50"
            :show-tooltip="false"
            @update:model-value="advanced.topK = $event as number"
          />
          <span class="adv-value">{{ effectiveTopK }}</span>
        </div>
        <div v-if="mode === 'hybrid'" class="adv-item">
          <span class="adv-label">向量权重 α</span>
          <el-slider
            :model-value="advanced.alpha ?? props.kb.config.hybridAlpha"
            :min="0"
            :max="1"
            :step="0.05"
            :show-tooltip="false"
            @update:model-value="advanced.alpha = $event as number"
          />
          <span class="adv-value">{{ (advanced.alpha ?? props.kb.config.hybridAlpha).toFixed(2) }}</span>
        </div>
        <div class="adv-item">
          <span class="adv-label">最低相似度</span>
          <el-slider
            :model-value="advanced.minSimilarity ?? props.kb.config.minSimilarity ?? 0.53"
            :min="0"
            :max="0.9"
            :step="0.01"
            :show-tooltip="false"
            @update:model-value="advanced.minSimilarity = $event as number"
          />
          <span class="adv-value">
            {{ (advanced.minSimilarity ?? props.kb.config.minSimilarity ?? 0.53).toFixed(2) }}
          </span>
        </div>
        <div class="adv-item">
          <span class="adv-label">相对截断</span>
          <el-slider
            v-model="advanced.scoreThreshold"
            :min="0"
            :max="0.9"
            :step="0.05"
            :show-tooltip="false"
          />
          <span class="adv-value">
            {{ advanced.scoreThreshold > 0 ? `≥ ${advanced.scoreThreshold.toFixed(2)}×榜首` : '关闭' }}
          </span>
        </div>
        <div class="adv-item">
          <span class="adv-label">单文档上限</span>
          <el-slider
            v-model="advanced.maxChunksPerDoc"
            :min="0"
            :max="10"
            :step="1"
            :show-tooltip="false"
          />
          <span class="adv-value">
            {{ advanced.maxChunksPerDoc > 0 ? `${advanced.maxChunksPerDoc} 条` : '不限制' }}
          </span>
        </div>
        <div class="adv-item">
          <span class="adv-label">去冗余阈值</span>
          <el-slider
            v-model="advanced.dedupSimilarity"
            :min="0"
            :max="1"
            :step="0.01"
            :show-tooltip="false"
          />
          <span class="adv-value">
            {{ advanced.dedupSimilarity > 0 ? `≥ ${advanced.dedupSimilarity.toFixed(2)}` : '关闭' }}
          </span>
        </div>
        <div class="adv-item adv-switch">
          <span class="adv-label">
            查询改写
            <span class="adv-hint">代词消解 + 多查询扩展，多轮追问时建议开启（多一次 LLM 调用）</span>
          </span>
          <el-switch v-model="advanced.useRewrite" size="small" />
        </div>
        <div v-if="advanced.useRewrite" class="adv-item adv-switch">
          <span class="adv-label">
            HyDE 假设文档
            <span class="adv-hint">额外用"假设的答案原文"召回一路，语义类问题收益明显</span>
          </span>
          <el-switch v-model="advanced.useHyde" size="small" />
        </div>
        <div v-if="props.kb.documents.length > 1" class="adv-item adv-select">
          <span class="adv-label">限定文档</span>
          <el-select
            v-model="advanced.docIds"
            multiple
            collapse-tags
            collapse-tags-tooltip
            placeholder="全部文档"
            size="small"
            class="adv-select-input"
          >
            <el-option
              v-for="d in props.kb.documents"
              :key="d.id"
              :label="d.name"
              :value="d.id"
            />
          </el-select>
        </div>
        <div v-if="availableDocTypes.length > 1" class="adv-item adv-select">
          <span class="adv-label">限定类型</span>
          <el-select
            v-model="advanced.docTypes"
            multiple
            collapse-tags
            placeholder="全部类型"
            size="small"
            class="adv-select-input"
          >
            <el-option v-for="t in availableDocTypes" :key="t" :label="t" :value="t" />
          </el-select>
        </div>
        <div class="adv-item adv-switch">
          <span class="adv-label">启用精排</span>
          <el-switch v-model="advanced.enableRerank" size="small" />
        </div>
      </div>

      <div class="config-info">
        {{ currentConfig }}
      </div>
    </div>

    <!-- 检索失败 -->
    <div v-if="searchError" class="search-error">
      <AlertTriangle :size="16" />
      <span>{{ searchError }}</span>
    </div>

    <!-- 检索结果 -->
    <div v-if="searched" class="results-section">
      <div
        v-if="rerankRequested && !rerankApplied && results.length > 1"
        class="rerank-warn"
      >
        <AlertTriangle :size="14" />
        <span>
          知识库启用了精排，但本次<strong>未生效</strong>（重排模型不可用或调用失败），
          下方为召回原始顺序。请检查「模型」页面中 rerank 模型的 API_BASE 配置。
        </span>
      </div>
      <div v-if="rewriteRequested && !rewriteApplied" class="rewrite-warn">
        <AlertTriangle :size="14" />
        <span>
          本次<strong>未改写</strong>（{{ rewriteReason || '原因未知' }}），
          下方为原始查询的召回结果。改写需要知识库配置可用的 LLM（与图谱抽取同一个模型）。
        </span>
      </div>
      <div v-else-if="rewriteApplied" class="rewrite-ok">
        <Wand2 :size="14" />
        <span>
          已改写，本次用 {{ rewriteVariantCount }} 路共同召回（按排名融合）：
          <em v-for="(q, i) in rewriteExtras" :key="i">「{{ q }}」</em>
          <em v-if="rewriteHyde">「HyDE 假设文档」</em>
        </span>
      </div>
      <div v-if="noRelevantResult" class="no-relevant">
        <AlertTriangle :size="16" />
        <div>
          <div class="no-relevant-title">知识库中没有找到相关内容</div>
          <div class="no-relevant-desc">
            最高相似度低于门槛（{{ effectiveMinSimilarity ?? '—' }}），
            已过滤 {{ filteredCount }} 条低相关结果——这些内容库里确实没有讲过，
            而不是"检索出错"。可换用更贴近原文的关键词，或切到 BM25 模式；
            确认库里有资料时可在「高级参数」里降低门槛。
          </div>
        </div>
      </div>

      <div v-if="results.length > 0" class="results-count">
        命中 {{ results.length }} 条结果
        <span v-if="rerankApplied" class="rerank-ok">已精排</span>
        <span v-if="filteredCount > 0" class="filter-ok">已过滤 {{ filteredCount }} 条低相关</span>
        <span v-if="dedupedCount > 0" class="filter-ok">已去冗余 {{ dedupedCount }} 条</span>
      </div>
      <div v-for="(r, i) in results" :key="r.id" class="card result-card">
        <div class="result-header">
          <el-tag size="small" type="info" class="result-rank">#{{ i + 1 }}</el-tag>
          <span class="result-doc">{{ r.doc }}</span>
          <span v-if="searchedKbCount > 1 && r.kbName" class="result-kb">
            来自《{{ r.kbName }}》
          </span>
          <span v-if="r.section" class="result-cite">· {{ r.section }}</span>
          <span v-if="r.page" class="result-cite">· 第 {{ r.page }} 页</span>
          <span v-if="r.parentExpanded" class="result-expanded" title="命中子块后返回的是它所属父块的完整上下文">
            已扩展上下文
          </span>
          <span :class="['rel-badge', relevanceLabel(r.scoreKind, r.score, i).cls]">
            {{ relevanceLabel(r.scoreKind, r.score, i).text }}
          </span>
          <div class="result-scores" :title="scoreTitle(r)">
            <span class="score-label">
              {{ r.scoreKind ? SCORE_KIND_LABEL[r.scoreKind as ScoreKind] : '得分' }}
            </span>
            <span class="score-value score-primary">{{ r.score.toFixed(3) }}</span>
            <span v-if="r.vec !== null" class="score-label">| 余弦 {{ r.vec.toFixed(3) }}</span>
            <span v-if="r.bm25 !== null" class="score-label">| BM25 {{ r.bm25.toFixed(2) }}</span>
            <el-tooltip content="复制引用" placement="top" :show-after="300">
              <button class="copy-cite" @click.stop="copyCitation(r)">
                <Quote :size="12" />
              </button>
            </el-tooltip>
          </div>
        </div>
        <p class="result-chunk">
          <template v-for="(part, j) in highlightText(r.chunk)" :key="j">
            <mark v-if="part.hl" class="highlight">{{ part.text }}</mark>
            <span v-else>{{ part.text }}</span>
          </template>
        </p>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-if="!searched" class="card empty-card">
      <FileSearch :size="40" class="empty-icon" />
      <div class="empty-text">输入查询语句后开始检索</div>
    </div>
  </div>
</template>

<style scoped>
.search-tab {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.card {
  padding: 20px;
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card);
}

.search-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.mode-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.mode-card {
  padding: 12px;
  background: var(--surface-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xl);
  cursor: pointer;
  transition: all 0.15s;
  text-align: left;
  outline: none;
  font-family: inherit;
}

.mode-card:hover {
  border-color: rgba(59, 130, 246, 0.35);
}

.mode-active {
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(139, 92, 246, 0.2));
  border-color: rgba(59, 130, 246, 0.4);
}

.mode-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mode-header span {
  font-size: var(--font-size-sm);
}

.mode-desc {
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
  margin-top: 6px;
}

.query-row {
  display: flex;
  gap: 10px;
}

.search-input-wrap {
  position: relative;
  flex: 1;
}

.q-search-icon {
  position: absolute;
  left: 14px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--foreground-secondary);
  pointer-events: none;
  z-index: 1;
}

.q-input {
  width: 100%;
  height: 44px;
  padding: 0 16px 0 42px;
  background: var(--surface-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-input);
  color: var(--foreground-primary);
  font-size: var(--font-size-base);
  font-family: inherit;
  outline: none;
  transition: border-color 0.2s;
}

.q-input::placeholder {
  color: var(--foreground-muted);
}

.q-input:focus {
  border-color: rgba(59, 130, 246, 0.4);
}

.btn-search {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 44px;
  padding: 0 20px;
  background: linear-gradient(135deg, #3b82f6, #8b5cf6);
  border: none;
  border-radius: var(--radius-input);
  color: #fff;
  font-size: var(--font-size-base);
  font-family: inherit;
  cursor: pointer;
  transition: opacity 0.2s;
  white-space: nowrap;
}

.btn-search:hover {
  opacity: 0.9;
}

.btn-search:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.config-info {
  font-size: var(--font-size-xs);
  color: var(--foreground-secondary);
}

.results-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.results-count {
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
}

.advanced-toggle {
  display: flex;
  justify-content: flex-end;
}

.link-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  border: none;
  background: none;
  color: var(--foreground-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.link-btn:hover {
  color: var(--brand-primary, #6366f1);
}

.advanced-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card);
  background: var(--surface-muted, rgba(148, 163, 184, 0.06));
}

.adv-item {
  display: flex;
  align-items: center;
  gap: 12px;
}

.adv-label {
  flex: 0 0 92px;
  font-size: var(--font-size-xs, 12px);
  color: var(--foreground-secondary);
}

.adv-item :deep(.el-slider) {
  flex: 1;
}

.adv-value {
  flex: 0 0 76px;
  text-align: right;
  font-size: var(--font-size-xs, 12px);
  color: var(--foreground-secondary);
}

.adv-switch {
  justify-content: space-between;
}

.adv-hint {
  display: block;
  margin-top: 2px;
  color: var(--foreground-muted, rgba(148, 163, 184, 0.9));
  font-size: 11px;
  line-height: 1.4;
}

.adv-select {
  align-items: flex-start;
}

.adv-select-input {
  flex: 1;
}

.search-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border: 1px solid rgba(244, 63, 94, 0.35);
  border-radius: var(--radius-card);
  background: rgba(244, 63, 94, 0.08);
  color: var(--status-error-text, #f43f5e);
  font-size: var(--font-size-sm);
}

.no-relevant {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card);
  background: var(--surface-card);
  color: var(--foreground-secondary);
}

.no-relevant-title {
  margin-bottom: 4px;
  color: var(--foreground-primary, inherit);
  font-size: var(--font-size-md, 14px);
}

.no-relevant-desc {
  font-size: var(--font-size-sm);
  line-height: 1.6;
}

.result-expanded {
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(139, 92, 246, 0.15);
  color: #8b5cf6;
  font-size: var(--font-size-xs, 12px);
  white-space: nowrap;
}

.result-kb {
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(59, 130, 246, 0.12);
  color: #3b82f6;
  font-size: var(--font-size-xs, 12px);
  white-space: nowrap;
}

.result-cite {
  font-size: var(--font-size-xs, 12px);
  color: var(--foreground-secondary);
}

.rel-badge {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: var(--font-size-xs, 12px);
  white-space: nowrap;
}

.rel-high {
  background: rgba(16, 185, 129, 0.15);
  color: var(--status-ready-text, #10b981);
}

.rel-mid {
  background: rgba(59, 130, 246, 0.15);
  color: #3b82f6;
}

.rel-low {
  background: rgba(148, 163, 184, 0.15);
  color: var(--foreground-secondary);
}

.filter-ok {
  margin-left: 8px;
  font-size: var(--font-size-xs, 12px);
  color: var(--foreground-secondary);
}

.copy-cite {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border: none;
  background: none;
  color: var(--foreground-secondary);
  cursor: pointer;
}

.copy-cite:hover {
  color: var(--brand-primary, #6366f1);
}

.rerank-ok {
  margin-left: 8px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--surface-muted, rgba(255, 255, 255, 0.08));
  font-size: var(--font-size-xs, 12px);
}

.rerank-warn {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--warning-border, rgba(245, 158, 11, 0.4));
  border-radius: var(--radius-card);
  background: var(--warning-bg, rgba(245, 158, 11, 0.1));
  color: var(--warning-text, #f59e0b);
  font-size: var(--font-size-sm);
  line-height: 1.5;
}

.rewrite-warn {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--warning-border, rgba(245, 158, 11, 0.4));
  border-radius: var(--radius-card);
  background: var(--warning-bg, rgba(245, 158, 11, 0.08));
  color: var(--warning-text, #f59e0b);
  font-size: var(--font-size-xs, 12px);
  line-height: 1.5;
}

.rewrite-ok {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid rgba(139, 92, 246, 0.3);
  border-radius: var(--radius-card);
  background: rgba(139, 92, 246, 0.08);
  color: #8b5cf6;
  font-size: var(--font-size-xs, 12px);
  line-height: 1.5;
}

.rewrite-ok em {
  font-style: normal;
  color: var(--foreground-secondary);
}

.result-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.result-header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.result-rank {
  flex-shrink: 0;
}

.result-doc {
  font-size: var(--font-size-sm);
  color: var(--foreground-primary);
  flex: 1;
}

.result-scores {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
}

.score-label {
  color: var(--foreground-muted);
}

.score-value {
  color: var(--foreground-primary);
}

.score-primary {
  color: var(--status-ready-text);
  font-weight: var(--font-weight-semibold);
}

.result-chunk {
  font-size: var(--font-size-sm);
  color: var(--foreground-primary);
  line-height: 1.7;
  margin: 0;
}

.highlight {
  background: rgba(250, 204, 21, 0.3);
  color: var(--status-highlight-text);
  padding: 0 2px;
  border-radius: 2px;
}

.empty-card {
  text-align: center;
  padding: 64px 20px;
}

.empty-icon {
  color: var(--foreground-muted);
  margin-bottom: 12px;
  opacity: 0.5;
}

.empty-text {
  font-size: var(--font-size-base);
  color: var(--foreground-secondary);
}

.btn-icon {
  margin-right: 4px;
}

.text-blue-300 { color: var(--accent-primary); }
.text-slate-400 { color: var(--foreground-secondary); }
.text-white { color: var(--foreground-primary); }
.text-slate-300 { color: var(--foreground-secondary); }
</style>
