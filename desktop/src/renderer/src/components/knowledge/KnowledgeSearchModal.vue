<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useKnowledgeStore } from '../../store/knowledge'
import type { KnowledgeSearchResult } from '../../../../preload/index.d'

/**
 * 检索调试面板（弹窗）
 *
 * 数据来自 `kbStore.search(..., { debug: true })`：各路分数来自命中本身
 * （score / vecScore / bm25Score / source），阶段耗时与通道统计来自 debug 载荷。
 * 这是 `knowledge:search` 通道的第一个渲染层消费者（此前为预置的休眠入口）。
 */
const props = defineProps<{
  open: boolean
  kbId: string
  libraryName?: string
}>()

const emit = defineEmits<{
  close: []
}>()

const kbStore = useKnowledgeStore()

/** 窗口可见性：由父组件 open prop 驱动，保证关闭时有退出动画 */
const visible = ref(props.open)

watch(
  () => props.open,
  (open) => {
    visible.value = open
  },
  { immediate: true }
)

const query = ref('')
const mode = ref<'hybrid' | 'vector' | 'bm25'>('hybrid')
const topKInput = ref('12')
const debugEnabled = ref(true)
const running = ref(false)
const result = ref<KnowledgeSearchResult | null>(null)
const errorMsg = ref('')

/** 换库时清空上次结果（避免张冠李戴） */
watch(
  () => props.kbId,
  () => {
    result.value = null
    errorMsg.value = ''
  }
)

const canRun = computed(() => query.value.trim().length > 0 && !running.value)

async function run(): Promise<void> {
  const text = query.value.trim()
  if (!text || running.value) return
  const topK = Number.parseInt(topKInput.value, 10)
  running.value = true
  errorMsg.value = ''
  const data = await kbStore.search(props.kbId, text, {
    mode: mode.value,
    topK: Number.isFinite(topK) ? topK : undefined,
    debug: debugEnabled.value
  })
  running.value = false
  if (!data) {
    errorMsg.value = kbStore.lastError || '检索失败'
    result.value = null
    return
  }
  result.value = data
}

function closeModal(): void {
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && visible.value) closeModal()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

/** 阶段名（与主进程 RetrievalDebugStage 对齐） */
const STAGE_LABELS: Record<string, string> = {
  rewrite: '查询改写',
  recall: '三路召回',
  fuse: '融合（RRF）',
  fetch: '取内容',
  merge: '相邻合并',
  rerank: '重排',
  decay: '时间衰减',
  mmr: 'MMR 去冗余',
  total: '总计'
}

const SOURCE_LABELS: Record<string, string> = { sparse: 'BM25', dense: '向量', graph: '图谱' }

const debug = computed(() => result.value?.debug ?? null)

const maxStageMs = computed(() => {
  const rows = debug.value?.timings.filter((row) => row.stage !== 'total') ?? []
  return Math.max(0.01, ...rows.map((row) => row.ms))
})

const flagChips = computed(() => {
  const flags = debug.value?.flags
  if (!flags) return []
  const chips: string[] = []
  if (flags.vectorSkipped) chips.push('向量路已跳过')
  if (flags.sparseSkipped) chips.push('稀疏路已跳过')
  if (flags.rerankSkipped) chips.push('重排已跳过')
  if (flags.decayApplied) chips.push('已应用时间衰减')
  if (flags.mmrApplied) chips.push('已应用 MMR')
  if (!chips.length) chips.push('全部通道正常参与')
  return chips
})

function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage
}

function sourceLabel(source?: string): string {
  if (!source) return '—'
  return SOURCE_LABELS[source] ?? source
}

function fmtScore(value?: number): string {
  return value === undefined ? '—' : value.toFixed(4)
}

function fmtTime(ts?: number): string {
  if (!ts) return '—'
  const date = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function snippet(content: string): string {
  const text = content.replace(/\s+/g, ' ').trim()
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}
</script>

<template>
  <Transition name="ks-modal">
    <div v-if="visible" class="ks-mask" @click.self="closeModal">
      <div class="ks-card" role="dialog" aria-modal="true" aria-label="检索调试">
        <header class="ks-header">
          <div class="ks-heading">
            <h2 class="ks-title">检索调试</h2>
            <p class="ks-subtitle">
              {{ libraryName || '知识库' }} · 各路分数与阶段耗时可观测（只读，不影响索引）
            </p>
          </div>
          <button class="ks-close" type="button" aria-label="关闭" @click="closeModal">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        <div class="ks-body">
          <div class="ks-form">
            <input
              v-model="query"
              class="ks-input"
              placeholder="输入检索内容后回车"
              @keydown.enter="run"
            />
            <div class="ks-select-wrap">
              <select v-model="mode" class="ks-input ks-select">
                <option value="hybrid">混合检索</option>
                <option value="vector">仅向量</option>
                <option value="bm25">仅关键词</option>
              </select>
              <svg
                class="ks-select-chevron"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </div>
            <input v-model="topKInput" class="ks-input ks-input--topk" title="召回 Top" />
            <button class="ks-run" type="button" :disabled="!canRun" @click="run">
              {{ running ? '检索中…' : '检索' }}
            </button>
          </div>
          <label class="ks-debug-toggle">
            <input v-model="debugEnabled" type="checkbox" />
            采集分阶段耗时（关闭则只返回命中列表）
          </label>

          <p v-if="errorMsg" class="ks-error">{{ errorMsg }}</p>

          <div v-if="result && result.noRelevantResult" class="ks-empty">
            没有相关内容（门限过滤后为空）
          </div>

          <template v-if="result && !result.noRelevantResult">
            <section v-if="debug" class="ks-section">
              <h3 class="ks-section-title">阶段耗时</h3>
              <div class="ks-timings">
                <div v-for="row in debug.timings" :key="row.stage" class="ks-timing-row">
                  <span class="ks-timing-label">{{ stageLabel(row.stage) }}</span>
                  <span class="ks-timing-bar">
                    <span
                      class="ks-timing-fill"
                      :class="{ 'ks-timing-fill--total': row.stage === 'total' }"
                      :style="{ width: `${Math.min(100, (row.ms / maxStageMs) * 100)}%` }"
                    ></span>
                  </span>
                  <span class="ks-timing-ms">{{ row.ms }} ms</span>
                </div>
              </div>
            </section>

            <section v-if="debug" class="ks-section">
              <h3 class="ks-section-title">通道与标记</h3>
              <div class="ks-chips">
                <span v-for="chip in flagChips" :key="chip" class="ks-chip">{{ chip }}</span>
              </div>
              <div class="ks-channels">
                <span class="ks-channel">
                  BM25 候选 <b>{{ debug.channels.sparse.candidates }}</b>（{{ debug.channels.sparse.ms }} ms）
                </span>
                <span class="ks-channel">
                  向量候选 <b>{{ debug.channels.dense.candidates }}</b>（{{ debug.channels.dense.ms }} ms）
                </span>
                <span class="ks-channel">
                  图谱候选 <b>{{ debug.channels.graph.candidates }}</b>（{{ debug.channels.graph.ms }} ms）
                </span>
                <span class="ks-channel">融合候选 <b>{{ debug.fusedCount }}</b></span>
              </div>
              <p v-if="debug.denseGate" class="ks-gate">
                相似度门限 {{ debug.denseGate.threshold }} · 稠密路最高分
                {{ fmtScore(debug.denseGate.topScore) }} ·
                {{ debug.denseGate.failed ? '已触发（稠密候选被挡下）' : '未触发' }}
              </p>
              <p v-if="debug.variants.length > 1" class="ks-variants">
                实际查询：{{ debug.variants.join(' ｜ ') }}
              </p>
            </section>

            <section class="ks-section">
              <h3 class="ks-section-title">命中（{{ result.hits.length }}）</h3>
              <div class="ks-hits">
                <div v-for="(hit, index) in result.hits" :key="hit.chunkId" class="ks-hit">
                  <div class="ks-hit-head">
                    <span class="ks-hit-rank">#{{ index + 1 }}</span>
                    <span class="ks-hit-doc">{{ hit.docName }} › {{ hit.relPath }}</span>
                    <span class="ks-hit-chunk">切片 #{{ hit.chunkIndex }}</span>
                    <span class="ks-hit-source">{{ sourceLabel(hit.source) }}</span>
                  </div>
                  <div class="ks-hit-scores">
                    <span>融合 {{ fmtScore(hit.score) }}</span>
                    <span>向量 {{ fmtScore(hit.vecScore) }}</span>
                    <span>BM25 {{ fmtScore(hit.bm25Score) }}</span>
                    <span>导入 {{ fmtTime(hit.uploadedAt) }}</span>
                  </div>
                  <p class="ks-hit-snippet">{{ snippet(hit.content) }}</p>
                </div>
              </div>
            </section>
          </template>
        </div>

        <footer class="ks-footer">
          <button class="ks-btn" type="button" @click="closeModal">关闭</button>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.ks-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(4px);
}

.ks-card {
  display: flex;
  flex-direction: column;
  width: min(720px, calc(100vw - 48px));
  max-height: min(82vh, 760px);
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid var(--kw-color-border-brand);
  background: var(--kw-color-surface);
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.2);
}

.ks-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 24px;
  border-bottom: 1px solid var(--kw-color-border-brand);
}

.ks-heading {
  min-width: 0;
}

.ks-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.ks-subtitle {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--kw-color-text-muted);
}

.ks-close {
  padding: 4px;
  border: none;
  background: transparent;
  color: var(--kw-color-text-faint);
  cursor: pointer;
}

.ks-close:hover {
  color: var(--kw-color-text);
}

.ks-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 24px;
}

.ks-form {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ks-input {
  min-width: 0;
  flex: 1;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid var(--kw-color-border-brand);
  background: var(--kw-color-surface);
  color: var(--kw-color-text);
  font-size: 13px;
  font-family: inherit;
}

.ks-select-wrap {
  position: relative;
  display: flex;
  flex-shrink: 0;
}

.ks-select {
  flex: none;
  width: 110px;
  appearance: none;
  padding-right: 26px;
}

.ks-select-chevron {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--kw-color-text-faint);
  pointer-events: none;
}

.ks-input--topk {
  flex: none;
  width: 56px;
  text-align: center;
}

.ks-run {
  flex-shrink: 0;
  padding: 8px 18px;
  border-radius: 10px;
  border: none;
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
}

.ks-run:disabled {
  opacity: 0.5;
  cursor: default;
}

.ks-debug-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--kw-color-text-muted);
}

.ks-error {
  margin: 12px 0 0;
  font-size: 13px;
  color: #c0392b;
}

.ks-empty {
  margin-top: 16px;
  padding: 20px;
  border-radius: 12px;
  border: 1px dashed var(--kw-color-border-brand);
  text-align: center;
  font-size: 13px;
  color: var(--kw-color-text-muted);
}

.ks-section {
  margin-top: 18px;
}

.ks-section-title {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--kw-color-text-muted);
}

.ks-timings {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ks-timing-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.ks-timing-label {
  width: 92px;
  flex-shrink: 0;
  color: var(--kw-color-text-secondary);
}

.ks-timing-bar {
  flex: 1;
  height: 8px;
  border-radius: 4px;
  background: rgba(15, 23, 42, 0.06);
  overflow: hidden;
}

.ks-timing-fill {
  display: block;
  height: 100%;
  border-radius: 4px;
  background: var(--kw-color-brand);
  opacity: 0.55;
}

.ks-timing-fill--total {
  opacity: 1;
}

.ks-timing-ms {
  width: 70px;
  flex-shrink: 0;
  text-align: right;
  color: var(--kw-color-text-muted);
  font-variant-numeric: tabular-nums;
}

.ks-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ks-chip {
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.05);
  font-size: 12px;
  color: var(--kw-color-text-secondary);
}

.ks-channels {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 10px;
  font-size: 12px;
  color: var(--kw-color-text-muted);
}

.ks-channel b {
  color: var(--kw-color-text);
  font-weight: 600;
}

.ks-gate,
.ks-variants {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--kw-color-text-muted);
}

.ks-hits {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ks-hit {
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--kw-color-border-brand);
}

.ks-hit-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.ks-hit-rank {
  color: var(--kw-color-text-faint);
  font-variant-numeric: tabular-nums;
}

.ks-hit-doc {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--kw-color-text);
  font-weight: 500;
}

.ks-hit-chunk,
.ks-hit-source {
  flex-shrink: 0;
  color: var(--kw-color-text-muted);
}

.ks-hit-source {
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.05);
}

.ks-hit-scores {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--kw-color-text-muted);
  font-variant-numeric: tabular-nums;
}

.ks-hit-snippet {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--kw-color-text-secondary);
}

.ks-footer {
  display: flex;
  padding: 12px 24px 16px;
  border-top: 1px solid var(--kw-color-border-brand);
}

.ks-btn {
  flex: 1;
  padding: 10px;
  border-radius: 12px;
  border: none;
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
  font-size: 14px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
}

.ks-btn:hover {
  opacity: 0.92;
}

.ks-modal-enter-active,
.ks-modal-leave-active {
  transition: opacity 0.2s;
}

.ks-modal-enter-active .ks-card,
.ks-modal-leave-active .ks-card {
  transition: transform 0.2s;
}

.ks-modal-enter-from,
.ks-modal-leave-to {
  opacity: 0;
}

.ks-modal-enter-from .ks-card,
.ks-modal-leave-to .ks-card {
  transform: scale(0.96);
}
</style>
