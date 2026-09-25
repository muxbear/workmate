<script setup lang="ts">
import { ref, computed, onMounted, watchEffect, reactive } from 'vue'
import {
  Scissors, Sparkle, Hash, Network, Target,
} from 'lucide-vue-next'
import type { IndexConfig, SparseAlgo } from '@/types/knowledgeBase'
import {
  CHUNK_STRATEGY_OPTIONS,
  RERANKER_MODEL_TYPE,
} from '@/types/knowledgeBase'
import {
  fetchAvailableProviders,
  type AvailableProvider,
} from '@/services/knowledgeBaseApi'

const props = defineProps<{
  modelValue: IndexConfig
  /** 只读态：整个表单禁用（公共库 / 他人分享的库） */
  readonly?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [config: IndexConfig]
}>()

let draft = reactive<IndexConfig>({ ...props.modelValue })

watchEffect(() => {
  Object.assign(draft, props.modelValue)
})

function set<K extends keyof IndexConfig>(key: K, value: IndexConfig[K]) {
  if (props.readonly) return
  ;(draft as Record<string, unknown>)[key] = value
  emit('update:modelValue', { ...draft })
}

// ── embedding 提供商 + 模型 ──
const embProviders = ref<AvailableProvider[]>([])
const embProviderId = ref('')
const embProviderModels = computed(() => {
  if (!embProviderId.value) return []
  const p = embProviders.value.find(x => x.id === embProviderId.value)
  return p?.models || []
})

// ── LLM 提供商 + 模型 ──
const llmProviders = ref<AvailableProvider[]>([])
const llmProviderId = ref('')
const llmProviderModels = computed(() => {
  if (!llmProviderId.value) return []
  const p = llmProviders.value.find(x => x.id === llmProviderId.value)
  return p?.models || []
})

// ── Reranker 提供商 + 模型（来自「模型」页 type=rerank）──
const rerankProviders = ref<AvailableProvider[]>([])
const rerankProviderId = ref('')
const rerankProviderModels = computed(() => {
  if (!rerankProviderId.value) return []
  const p = rerankProviders.value.find(x => x.id === rerankProviderId.value)
  return p?.models || []
})

/** 按模型名反查提供商，返回命中的 provider id（未命中返回空串）。 */
function findProviderId(providers: AvailableProvider[], modelName: string): string {
  if (!modelName) return ''
  for (const p of providers) {
    if (p.models.some(m => m.name === modelName)) return p.id
  }
  return ''
}

onMounted(async () => {
  try {
    const [ep, lp, rp] = await Promise.all([
      fetchAvailableProviders('embedding'),
      fetchAvailableProviders('llm'),
      fetchAvailableProviders(RERANKER_MODEL_TYPE),
    ])
    embProviders.value = ep
    llmProviders.value = lp
    rerankProviders.value = rp

    // 提供商优先用配置里已保存的值，其次按模型名反查
    embProviderId.value =
      draft.embeddingProviderId || findProviderId(ep, draft.embeddingModel)
    llmProviderId.value = findProviderId(lp, draft.entityModel)
    rerankProviderId.value =
      draft.rerankerProviderId || findProviderId(rp, draft.rerankerModel)

    if (!embProviderId.value && ep.length > 0) embProviderId.value = ep[0].id
    if (!llmProviderId.value && lp.length > 0) llmProviderId.value = lp[0].id
    if (!rerankProviderId.value && rp.length > 0) rerankProviderId.value = rp[0].id
  } catch {
    /* ignore */
  }
})

function inferDim(name: string, display: string): number {
  const combined = `${name} ${display}`.toLowerCase()
  if (combined.includes('4096')) return 4096
  if (combined.includes('3072')) return 3072
  if (combined.includes('1536')) return 1536
  if (combined.includes('1024')) return 1024
  if (combined.includes('768')) return 768
  if (combined.includes('512')) return 512
  return 1024
}

function onEmbProviderChange(pid: string) {
  embProviderId.value = pid
  set('embeddingProviderId', pid)
  const p = embProviders.value.find(x => x.id === pid)
  if (p && p.models.length > 0) {
    set('embeddingModel', p.models[0].name)
    set('embeddingDim', inferDim(p.models[0].name, p.models[0].display_name))
  }
}

function onEmbModelChange(name: string) {
  set('embeddingModel', name)
  const p = embProviders.value.find(x => x.id === embProviderId.value)
  const m = p?.models.find(x => x.name === name)
  if (m) set('embeddingDim', inferDim(m.name, m.display_name))
}

function onLlmProviderChange(pid: string) {
  llmProviderId.value = pid
  const p = llmProviders.value.find(x => x.id === pid)
  if (p && p.models.length > 0) {
    set('entityModel', p.models[0].name)
  }
}

function onRerankProviderChange(pid: string) {
  rerankProviderId.value = pid
  set('rerankerProviderId', pid)
  const p = rerankProviders.value.find(x => x.id === pid)
  if (p && p.models.length > 0) {
    set('rerankerModel', p.models[0].name)
  }
}

function onRerankModelChange(name: string) {
  set('rerankerModel', name)
}
</script>

<template>
  <div class="index-config-form" :class="{ 'is-readonly': readonly }">
    <!-- 文档切片 -->
    <div class="section-card">
      <h3 class="section-title">
        <span class="section-icon icon-cyan"><Scissors :size="16" /></span>文档切片
      </h3>

      <div class="field">
        <label class="field-label">切片算法</label>
        <el-select :model-value="draft.chunkStrategy" style="width: 100%" popper-class="config-select-popper" @update:model-value="(v: string) => set('chunkStrategy', v as IndexConfig['chunkStrategy'])">
          <el-option
            v-for="s in CHUNK_STRATEGY_OPTIONS"
            :key="s.value"
            :label="s.label"
            :value="s.value"
          >
            <div class="select-option-with-desc">
              <span>{{ s.label }}</span>
              <span class="select-option-desc">{{ s.desc }}</span>
            </div>
          </el-option>
        </el-select>
      </div>

      <div class="field-row">
        <div class="field flex-1">
          <label class="field-label">分片大小: {{ draft.chunkSize }} tokens</label>
          <el-slider
            :model-value="draft.chunkSize"
            :min="128" :max="2048" :step="64"
            @update:model-value="(v: number) => set('chunkSize', v)"
          />
        </div>
        <div class="field flex-1">
          <label class="field-label">重叠: {{ draft.chunkOverlap }} tokens</label>
          <el-slider
            :model-value="draft.chunkOverlap"
            :min="0" :max="512" :step="16"
            @update:model-value="(v: number) => set('chunkOverlap', v)"
          />
        </div>
      </div>
    </div>

    <!-- Embedding -->
    <div class="section-card">
      <h3 class="section-title">
        <span class="section-icon icon-purple"><Sparkle :size="16" /></span>向量化 (Embedding)
      </h3>
      <div class="field-row">
        <div class="field flex-1">
          <label class="field-label">Embedding 提供商</label>
          <el-select
            :model-value="embProviderId"
            @update:model-value="onEmbProviderChange"
            style="width: 100%"
            popper-class="config-select-popper"
          >
            <el-option v-for="p in embProviders" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </div>
        <div class="field flex-1">
          <label class="field-label">Embedding 模型</label>
          <el-select
            :model-value="draft.embeddingModel"
            @update:model-value="onEmbModelChange"
            style="width: 100%"
            popper-class="config-select-popper"
          >
            <el-option v-for="m in embProviderModels" :key="m.id" :label="m.display_name || m.name" :value="m.name" />
          </el-select>
        </div>
      </div>
    </div>

    <!-- BM25 -->
    <div class="section-card">
      <h3 class="section-title">
        <span class="section-icon icon-amber"><Hash :size="16" /></span>稀疏检索 (BM25)
      </h3>
      <div class="field">
        <label class="field-label">算法</label>
        <el-select
          :model-value="draft.sparseAlgo"
          @update:model-value="(v: SparseAlgo) => set('sparseAlgo', v)"
          style="width: 100%"
          popper-class="config-select-popper"
        >
          <el-option label="BM25 (经典)" value="bm25" />
          <el-option label="BM25+ (改进版)" value="bm25_plus" />
          <el-option label="TF-IDF" value="tf_idf" />
          <el-option label="不启用" value="none" />
        </el-select>
      </div>
      <div v-if="draft.sparseAlgo !== 'none'" class="field-row">
        <div class="field flex-1">
          <label class="field-label">k1: {{ draft.bm25K1.toFixed(2) }} (词频饱和)</label>
          <el-slider
            :model-value="draft.bm25K1"
            :min="0.5" :max="3.0" :step="0.1"
            @update:model-value="(v: number) => set('bm25K1', v)"
          />
        </div>
        <div class="field flex-1">
          <label class="field-label">b: {{ draft.bm25B.toFixed(2) }} (长度归一)</label>
          <el-slider
            :model-value="draft.bm25B"
            :min="0" :max="1" :step="0.05"
            @update:model-value="(v: number) => set('bm25B', v)"
          />
        </div>
      </div>
    </div>

    <!-- 知识图谱 -->
    <div class="section-card">
      <h3 class="section-title">
        <span class="section-icon icon-green"><Network :size="16" /></span>知识图谱抽取
      </h3>
      <div class="toggle-row">
        <div class="toggle-info">
          <div class="toggle-label">启用知识图谱</div>
          <div class="toggle-desc">使用 LLM 从分片中抽取实体与关系</div>
        </div>
        <el-switch
          :model-value="draft.enableGraph"
          @update:model-value="(v: boolean) => set('enableGraph', v)"
        />
      </div>
      <div v-if="draft.enableGraph" class="field-row">
        <div class="field flex-1">
          <label class="field-label">LLM 提供商</label>
          <el-select
            :model-value="llmProviderId"
            @update:model-value="onLlmProviderChange"
            style="width: 100%"
            popper-class="config-select-popper"
          >
            <el-option v-for="p in llmProviders" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </div>
        <div class="field flex-1">
          <label class="field-label">抽取模型</label>
          <el-select
            :model-value="draft.entityModel"
            @update:model-value="(v: string) => set('entityModel', v)"
            style="width: 100%"
            popper-class="config-select-popper"
          >
            <el-option v-for="m in llmProviderModels" :key="m.id" :label="m.display_name || m.name" :value="m.name" />
          </el-select>
        </div>
      </div>
    </div>

    <!-- 检索与重排 -->
    <div class="section-card">
      <h3 class="section-title">
        <span class="section-icon icon-rose"><Target :size="16" /></span>检索与重排
      </h3>
      <div class="field-row">
        <div class="field flex-1">
          <label class="field-label">Top-K: {{ draft.topK }}</label>
          <el-slider
            :model-value="draft.topK"
            :min="1" :max="50" :step="1"
            @update:model-value="(v: number) => set('topK', v)"
          />
        </div>
        <div class="field flex-1">
          <label class="field-label">混合权重 &alpha;: {{ draft.hybridAlpha.toFixed(2) }} (向量&harr;BM25)</label>
          <el-slider
            :model-value="draft.hybridAlpha"
            :min="0" :max="1" :step="0.05"
            @update:model-value="(v: number) => set('hybridAlpha', v)"
          />
        </div>
      </div>
      <div v-if="draft.chunkStrategy === 'parent_child'" class="field-row">
        <div class="field flex-1">
          <label class="field-label">父块大小: {{ draft.parentChunkSize }} 字符</label>
          <el-slider
            :model-value="draft.parentChunkSize"
            :min="256" :max="4096" :step="128"
            @update:model-value="(v: number) => set('parentChunkSize', v)"
          />
          <div class="hint-text">
            父子块策略下，子块（分片大小）用于匹配、父块正文作为检索结果返回，
            让模型/用户拿到完整上下文。父块越大召回后看到的内容越多，但单条结果也越长。
          </div>
        </div>
        <div class="field flex-1">
          <label class="field-label">最小块长: {{ draft.minChunkSize }} 字符</label>
          <el-slider
            :model-value="draft.minChunkSize"
            :min="0" :max="256" :step="8"
            @update:model-value="(v: number) => set('minChunkSize', v)"
          />
          <div class="hint-text">
            短于该长度的切片会并入相邻切片——避免"只有标题"的碎片被当成一条检索结果
            （实测这类碎片曾排到首位）。0 表示不合并。
          </div>
        </div>
      </div>
      <div class="field-row">
        <div class="field flex-1">
          <label class="field-label">
            单文档结果上限: {{ draft.maxChunksPerDoc > 0 ? `${draft.maxChunksPerDoc} 条` : '不限制' }}
          </label>
          <el-slider
            :model-value="draft.maxChunksPerDoc"
            :min="0" :max="10" :step="1"
            @update:model-value="(v: number) => set('maxChunksPerDoc', v)"
          />
          <div class="hint-text">
            同一篇文档最多占用几个结果位；一篇文档霸榜会挤掉其他来源。
            候选只来自单篇文档时该限制自动失效。
          </div>
        </div>
        <div class="field flex-1">
          <label class="field-label">
            去冗余阈值: {{ draft.dedupSimilarity > 0 ? `相似度 ≥ ${draft.dedupSimilarity.toFixed(2)}` : '关闭' }}
          </label>
          <el-slider
            :model-value="draft.dedupSimilarity"
            :min="0" :max="1" :step="0.01"
            @update:model-value="(v: number) => set('dedupSimilarity', v)"
          />
          <div class="hint-text">
            与已选结果相似度超过该值的候选会被丢弃（同一段样板文字出现在多处时
            接近 1.0，而相邻切片的正常重叠通常远低于它）。丢掉的条数由后续候选补回。
          </div>
        </div>
      </div>
      <div class="field-row">
        <div class="field flex-1">
          <label class="field-label">
            最低相似度: {{ draft.minSimilarity.toFixed(2) }}
          </label>
          <el-slider
            :model-value="draft.minSimilarity"
            :min="0" :max="0.9" :step="0.01"
            @update:model-value="(v: number) => set('minSimilarity', v)"
          />
          <div class="hint-text">
            最高余弦相似度低于该值时，判定「知识库中没有相关内容」并返回空结果。
            默认 0.53 由黄金集校准（有答案的查询 ≥0.55、无答案的 ≤0.51）。
          </div>
        </div>
        <div class="field flex-1">
          <label class="field-label">
            相对截断: {{ draft.scoreThreshold > 0 ? `${draft.scoreThreshold.toFixed(2)}×榜首` : '关闭' }}
          </label>
          <el-slider
            :model-value="draft.scoreThreshold"
            :min="0" :max="0.9" :step="0.05"
            @update:model-value="(v: number) => set('scoreThreshold', v)"
          />
          <div class="hint-text">
            丢弃低于「最高分 × 该比例」的结果，用于压缩长尾。默认关闭——
            绝对门槛已经处理了"完全没有相关内容"。
          </div>
        </div>
      </div>
      <div class="toggle-row">
        <div class="toggle-info">
          <div class="toggle-label">启用 Reranker</div>
          <div class="toggle-desc">
            先召回 Top-K×4 候选，再由重排序模型精排（实测 MRR 0.86 → 0.93，延迟 +0.5s）
          </div>
        </div>
        <el-switch
          :model-value="draft.enableReranker"
          :disabled="rerankProviders.length === 0"
          @update:model-value="(v: boolean) => set('enableReranker', v)"
        />
      </div>
      <div v-if="rerankProviders.length === 0" class="hint-text">
        尚未配置重排序模型：请到「模型」页面添加 type=rerank 的模型后再启用。
      </div>
      <div class="toggle-row">
        <div class="toggle-info">
          <div class="toggle-label">查询改写</div>
          <div class="toggle-desc">
            把口语化提问与多轮追问改写成多条互补的检索式（指代消解 + 多查询扩展），
            按排名融合召回。多轮追问（"它怎么配"）几乎必须开启才能召回正确内容；
            代价是每次检索多一次 LLM 调用——使用本库配置的图谱抽取模型。
          </div>
        </div>
        <el-switch
          :model-value="draft.enableQueryRewrite"
          @update:model-value="(v: boolean) => set('enableQueryRewrite', v)"
        />
      </div>
      <div v-if="draft.enableQueryRewrite" class="toggle-row">
        <div class="toggle-info">
          <div class="toggle-label">HyDE 假设文档</div>
          <div class="toggle-desc">
            额外用一段"假设的答案原文"召回一路。语义类提问（"怎么保证一致性"）收益明显，
            会让延迟再涨一截。
          </div>
        </div>
        <el-switch
          :model-value="draft.enableHyde"
          @update:model-value="(v: boolean) => set('enableHyde', v)"
        />
      </div>
      <div v-if="draft.enableReranker && rerankProviders.length > 0" class="field-row">
        <div class="field flex-1">
          <label class="field-label">Reranker 提供商</label>
          <el-select
            :model-value="rerankProviderId"
            @update:model-value="onRerankProviderChange"
            style="width: 100%"
            popper-class="config-select-popper"
          >
            <el-option v-for="p in rerankProviders" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </div>
        <div class="field flex-1">
          <label class="field-label">Reranker 模型</label>
          <el-select
            :model-value="draft.rerankerModel"
            @update:model-value="onRerankModelChange"
            style="width: 100%"
            popper-class="config-select-popper"
          >
            <el-option
              v-for="m in rerankProviderModels"
              :key="m.id"
              :label="m.display_name || m.name"
              :value="m.name"
            />
          </el-select>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.index-config-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 只读态：整体禁用交互并降低视觉权重（set() 亦有兜底拦截） */
.index-config-form.is-readonly {
  pointer-events: none;
  opacity: 0.75;
}

/* Section card */
.section-card {
  padding: 16px;
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
  margin: 0;
}

.section-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

/* Field */
.field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field-row {
  display: flex;
  gap: 16px;
}

.flex-1 { flex: 1; }

.field-label {
  font-size: var(--font-size-xs);
  color: var(--foreground-secondary);
  line-height: 1.4;
}

/* Toggle */
.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  background: var(--surface-stat);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  margin-top: 4px;
}

.toggle-label {
  font-size: var(--font-size-sm);
  color: var(--foreground-primary);
}

.toggle-desc {
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
  margin-top: 2px;
}

.hint-text {
  font-size: var(--font-size-xs);
  color: var(--status-amber-text, var(--foreground-muted));
  line-height: 1.5;
}

/* Select option with description */
.select-option-with-desc {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.select-option-desc {
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

/* Colors */
.icon-cyan { color: var(--status-cyan-text); }
.icon-purple { color: var(--status-purple-text); }
.icon-amber { color: var(--status-amber-text); }
.icon-green { color: var(--status-ready-text); }
.icon-rose { color: var(--status-error-text); }
</style>

<!-- 全局样式覆盖: 索引配置表单内的 Element Plus 组件 -->
<style>
.index-config-form .el-select .el-input__wrapper {
  background: var(--color-bg-input) !important;
  border: 1px solid var(--border-medium) !important;
  border-radius: var(--radius-input) !important;
  box-shadow: none !important;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast) !important;
  padding-left: 12px !important;
  padding-right: 12px !important;
}

.index-config-form .el-select .el-input__wrapper:hover {
  border-color: rgba(59, 130, 246, 0.45) !important;
}

.index-config-form .el-select .el-input__wrapper.is-focus {
  border-color: var(--color-accent) !important;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1) !important;
}

.index-config-form .el-select .el-input__inner {
  color: var(--foreground-primary) !important;
  font-size: var(--font-size-sm) !important;
}

.index-config-form .el-select .el-input__inner::placeholder {
  color: var(--foreground-muted) !important;
}

/* Select 下拉面板 */
.config-select-popper {
  background: var(--color-modal-bg) !important;
  border: 1px solid var(--border-medium) !important;
  border-radius: var(--radius-input) !important;
  box-shadow: var(--shadow-card) !important;
  padding: 4px !important;
}

.config-select-popper .el-select-dropdown__item {
  color: var(--foreground-primary) !important;
  padding: 8px 12px !important;
  font-size: var(--font-size-sm) !important;
  border-radius: 6px !important;
  margin: 2px 0 !important;
  transition: background var(--transition-fast) !important;
}

.config-select-popper .el-select-dropdown__item.is-hovering,
.config-select-popper .el-select-dropdown__item:hover {
  background: rgba(59, 130, 246, 0.12) !important;
}

.config-select-popper .el-select-dropdown__item.is-selected {
  color: var(--status-indexing-text) !important;
  font-weight: var(--font-weight-medium) !important;
  background: rgba(59, 130, 246, 0.08) !important;
}

/* Slider 轨道 */
.index-config-form .el-slider__runway {
  background: var(--border-subtle) !important;
}

.index-config-form .el-slider__bar {
  background: linear-gradient(135deg, #3b82f6, #8b5cf6) !important;
}

.index-config-form .el-slider__button {
  border-color: #3b82f6 !important;
  background: #fff !important;
}

/* Switch */
.index-config-form .el-switch.is-checked .el-switch__core {
  background: #3b82f6 !important;
  border-color: #3b82f6 !important;
}
</style>
