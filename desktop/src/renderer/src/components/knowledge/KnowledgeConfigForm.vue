<script setup lang="ts">
import { computed, onMounted, reactive, type WritableComputedRef } from 'vue'
import SettingToggle from '../settings/SettingToggle.vue'
import KnowledgeFollowToggle from './KnowledgeFollowToggle.vue'
import { useModelStore } from '../../store/models'
import {
  BUILTIN_MODEL_OPTIONS,
  KNOWLEDGE_FIELD_DEFS,
  KNOWLEDGE_FIELD_LIST,
  type KnowledgeDraft,
  type KnowledgeDraftValue
} from './knowledgeFields'
import type { KnowledgeOverrideKey } from '../../../../preload/index.d'

/**
 * 知识库配置表单（5 张卡片）
 *
 * 同一份实现服务两个界面：
 * - 「知识库设置」页（全局）：不传 custom，纯表单，提交给全局设置
 * - 每个知识库的设置弹窗（按库覆盖）：传 custom，逐项出现「跟随全局 / 自定义」开关；
 *   跟随项的控件禁用并展示全局值
 *
 * draft 承载**显示值**（由父级算好：跟随项 = 全局值，自定义项 = 覆盖值），子组件不改它，
 * 一律通过 change 事件把新值交回父级决定写到哪里。
 */
const props = defineProps<{
  draft: KnowledgeDraft
  /** 非 null = 按库模式（true 表示该知识库自定义了该项） */
  custom?: Record<KnowledgeOverrideKey, boolean> | null
  /** 本地存储目录（仅全局设置传入；不传则不渲染该卡片） */
  directory?: string | null
}>()

const emit = defineEmits<{
  change: [key: KnowledgeOverrideKey, value: KnowledgeDraftValue]
  'update:custom': [key: KnowledgeOverrideKey, value: boolean]
  'update:directory': [value: string]
  'select-directory': []
}>()

const modelStore = useModelStore()

onMounted(() => {
  void modelStore.load()
})

/** 自定义模型名（models.json；排除已内置的选项） */
const customModelNames = computed(() => {
  const names = modelStore.models
    .map((item) => item.name)
    .filter((name) => name && !BUILTIN_MODEL_OPTIONS.includes(name))
  return [...new Set(names)]
})

/** 逐字段可写代理：读 → 父级显示值，写 → 冒泡 change */
const fieldModels = {} as Record<KnowledgeOverrideKey, WritableComputedRef<KnowledgeDraftValue>>
for (const field of KNOWLEDGE_FIELD_LIST) {
  fieldModels[field.key] = computed({
    get: () => props.draft[field.key],
    set: (value: KnowledgeDraftValue) => emit('change', field.key, value)
  })
}

/**
 * 必须用 reactive 包裹后再交给模板：模板里读的是 `$setup.models.<key>`，
 * 普通对象不会解包 ref —— computed 对象会被原样交给 v-model（输入框显示 [object Object]，
 * 写回也不会触发 setter）。reactive 的 ref 解包正好给出需要的读写语义。
 */
const models = reactive(fieldModels)

/** 目录输入框（目录不参与按库覆盖，单独用 v-model:directory 与父级同步） */
const directoryModel = computed({
  get: () => props.directory ?? '',
  set: (value: string) => emit('update:directory', value)
})

/** 是否处于「跟随全局」态（仅按库模式有意义） */
function isFollowing(key: KnowledgeOverrideKey): boolean {
  return props.custom != null && !props.custom[key]
}

function onFollowChange(key: KnowledgeOverrideKey, following: boolean): void {
  emit('update:custom', key, !following)
}

/** 布尔项显示值（SettingToggle 需要严格的 boolean） */
function booleanValue(key: KnowledgeOverrideKey): boolean {
  return props.draft[key] === true
}

function onBooleanChange(key: KnowledgeOverrideKey, value: boolean): void {
  emit('change', key, value)
}
</script>

<template>
  <div class="kb-form">
    <!-- 本地存储（仅全局设置：索引库位置按机器维度，不按知识库区分） -->
    <section v-if="props.directory != null" class="kb-card kb-card--soft">
      <div class="kb-card-head">
        <span class="kb-card-icon">
          <svg
            width="21"
            height="21"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line x1="22" x2="2" y1="12" y2="12" />
            <path
              d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"
            />
            <line x1="6" x2="6.01" y1="16" y2="16" />
            <line x1="10" x2="10.01" y1="16" y2="16" />
          </svg>
        </span>
        <div>
          <h2 class="kb-title">本地存储</h2>
          <p class="kb-desc">本地知识库原始文件、解析缓存与向量索引的存放位置。</p>
        </div>
      </div>
      <div class="kb-dir-row">
        <input v-model="directoryModel" class="kb-input kb-dir-input" />
        <button class="kb-btn" @click="emit('select-directory')">
          <svg
            class="kb-btn-icon"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"
            />
          </svg>
          选择目录
        </button>
      </div>
      <p class="kb-hint">建议使用本地 SSD 目录，并预留至少 5 GB 可用空间。</p>
    </section>

    <!-- 文件上传 -->
    <section class="kb-card">
      <h2 class="kb-title">文件上传</h2>
      <p class="kb-desc">限制单次导入的资源消耗，避免超大文件阻塞解析队列。</p>
      <div class="kb-grid kb-grid--3">
        <label class="kb-field">
          <span class="kb-label" :class="{ 'kb-label--row': props.custom != null }">
            <span>单文件最大大小</span>
            <KnowledgeFollowToggle
              v-if="props.custom != null"
              :following="isFollowing('maxUploadSize')"
              @update:following="onFollowChange('maxUploadSize', $event)"
            />
          </span>
          <div class="kb-unit-box">
            <input
              v-model="models.maxUploadSize"
              class="kb-input kb-input--bare"
              :disabled="isFollowing('maxUploadSize')"
            />
            <span class="kb-unit">MB</span>
          </div>
        </label>
        <label class="kb-field">
          <span class="kb-label" :class="{ 'kb-label--row': props.custom != null }">
            <span>上传超时</span>
            <KnowledgeFollowToggle
              v-if="props.custom != null"
              :following="isFollowing('uploadTimeout')"
              @update:following="onFollowChange('uploadTimeout', $event)"
            />
          </span>
          <div class="kb-unit-box">
            <input
              v-model="models.uploadTimeout"
              class="kb-input kb-input--bare"
              :disabled="isFollowing('uploadTimeout')"
            />
            <span class="kb-unit">分钟</span>
          </div>
        </label>
        <label class="kb-field">
          <span class="kb-label" :class="{ 'kb-label--row': props.custom != null }">
            <span>单批次文件数</span>
            <KnowledgeFollowToggle
              v-if="props.custom != null"
              :following="isFollowing('maxFilesPerBatch')"
              @update:following="onFollowChange('maxFilesPerBatch', $event)"
            />
          </span>
          <div class="kb-unit-box">
            <input
              v-model="models.maxFilesPerBatch"
              class="kb-input kb-input--bare"
              :disabled="isFollowing('maxFilesPerBatch')"
            />
            <span class="kb-unit">个</span>
          </div>
        </label>
      </div>
    </section>

    <!-- RAG 索引 -->
    <section class="kb-card">
      <div class="kb-card-head">
        <span class="kb-card-icon">
          <svg
            width="21"
            height="21"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"
            />
            <path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" />
            <path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" />
          </svg>
        </span>
        <div>
          <h2 class="kb-title">RAG 索引</h2>
          <p class="kb-desc">控制文档切片与向量化策略。较小切片更精确，较大切片保留更多上下文。</p>
        </div>
      </div>
      <div class="kb-grid kb-grid--2">
        <label class="kb-field">
          <span class="kb-label" :class="{ 'kb-label--row': props.custom != null }">
            <span>默认切片算法</span>
            <KnowledgeFollowToggle
              v-if="props.custom != null"
              :following="isFollowing('chunkStrategy')"
              @update:following="onFollowChange('chunkStrategy', $event)"
            />
          </span>
          <div class="kb-select-wrap">
            <select
              v-model="models.chunkStrategy"
              class="kb-input kb-select"
              :disabled="isFollowing('chunkStrategy')"
            >
              <option
                v-for="opt in KNOWLEDGE_FIELD_DEFS.chunkStrategy.options"
                :key="String(opt.value)"
                :value="opt.value"
              >
                {{ opt.label }}
              </option>
            </select>
            <svg
              class="kb-select-chevron"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
        </label>
        <label class="kb-field">
          <span class="kb-label" :class="{ 'kb-label--row': props.custom != null }">
            <span>向量化模型</span>
            <KnowledgeFollowToggle
              v-if="props.custom != null"
              :following="isFollowing('embeddingModel')"
              @update:following="onFollowChange('embeddingModel', $event)"
            />
          </span>
          <div class="kb-select-wrap">
            <select
              v-model="models.embeddingModel"
              class="kb-input kb-select"
              :disabled="isFollowing('embeddingModel')"
            >
              <option
                v-for="opt in KNOWLEDGE_FIELD_DEFS.embeddingModel.options"
                :key="String(opt.value)"
                :value="opt.value"
              >
                {{ opt.label }}
              </option>
              <option v-for="name in customModelNames" :key="name" :value="name">
                {{ name }}
              </option>
            </select>
            <svg
              class="kb-select-chevron"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
        </label>
        <label class="kb-field">
          <span class="kb-label" :class="{ 'kb-label--row': props.custom != null }">
            <span>切片大小</span>
            <KnowledgeFollowToggle
              v-if="props.custom != null"
              :following="isFollowing('chunkSize')"
              @update:following="onFollowChange('chunkSize', $event)"
            />
          </span>
          <div class="kb-unit-box">
            <input
              v-model="models.chunkSize"
              class="kb-input kb-input--bare"
              :disabled="isFollowing('chunkSize')"
            />
            <span class="kb-unit">tokens</span>
          </div>
        </label>
        <label class="kb-field">
          <span class="kb-label" :class="{ 'kb-label--row': props.custom != null }">
            <span>重叠大小</span>
            <KnowledgeFollowToggle
              v-if="props.custom != null"
              :following="isFollowing('chunkOverlap')"
              @update:following="onFollowChange('chunkOverlap', $event)"
            />
          </span>
          <div class="kb-unit-box">
            <input
              v-model="models.chunkOverlap"
              class="kb-input kb-input--bare"
              :disabled="isFollowing('chunkOverlap')"
            />
            <span class="kb-unit">tokens</span>
          </div>
        </label>
        <label class="kb-field">
          <span class="kb-label" :class="{ 'kb-label--row': props.custom != null }">
            <span>向量维度</span>
            <KnowledgeFollowToggle
              v-if="props.custom != null"
              :following="isFollowing('vectorDimensions')"
              @update:following="onFollowChange('vectorDimensions', $event)"
            />
          </span>
          <div class="kb-select-wrap">
            <select
              v-model="models.vectorDimensions"
              class="kb-input kb-select"
              :disabled="isFollowing('vectorDimensions')"
            >
              <option
                v-for="opt in KNOWLEDGE_FIELD_DEFS.vectorDimensions.options"
                :key="String(opt.value)"
                :value="opt.value"
              >
                {{ opt.label }}
              </option>
            </select>
            <svg
              class="kb-select-chevron"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
        </label>
      </div>
    </section>

    <!-- 混合检索与重排 -->
    <section class="kb-card">
      <div class="kb-card-head kb-card-head--between">
        <div>
          <h2 class="kb-title">混合检索与重排</h2>
          <p class="kb-desc">结合向量语义与 BM25 关键词检索，再由重排模型优化最终上下文。</p>
        </div>
        <div class="kb-toggle-group">
          <KnowledgeFollowToggle
            v-if="props.custom != null"
            :following="isFollowing('sparseRetrieval')"
            @update:following="onFollowChange('sparseRetrieval', $event)"
          />
          <SettingToggle
            :model-value="booleanValue('sparseRetrieval')"
            :disabled="isFollowing('sparseRetrieval')"
            @update:model-value="onBooleanChange('sparseRetrieval', $event)"
          />
        </div>
      </div>
      <div class="kb-grid kb-grid--3">
        <label class="kb-field">
          <span class="kb-label" :class="{ 'kb-label--row': props.custom != null }">
            <span>BM25 k1</span>
            <KnowledgeFollowToggle
              v-if="props.custom != null"
              :following="isFollowing('bm25K1')"
              @update:following="onFollowChange('bm25K1', $event)"
            />
          </span>
          <input
            v-model="models.bm25K1"
            class="kb-input"
            :disabled="isFollowing('bm25K1') || !booleanValue('sparseRetrieval')"
          />
        </label>
        <label class="kb-field">
          <span class="kb-label" :class="{ 'kb-label--row': props.custom != null }">
            <span>BM25 b</span>
            <KnowledgeFollowToggle
              v-if="props.custom != null"
              :following="isFollowing('bm25B')"
              @update:following="onFollowChange('bm25B', $event)"
            />
          </span>
          <input
            v-model="models.bm25B"
            class="kb-input"
            :disabled="isFollowing('bm25B') || !booleanValue('sparseRetrieval')"
          />
        </label>
        <label class="kb-field">
          <span class="kb-label" :class="{ 'kb-label--row': props.custom != null }">
            <span>向量检索权重</span>
            <KnowledgeFollowToggle
              v-if="props.custom != null"
              :following="isFollowing('hybridWeight')"
              @update:following="onFollowChange('hybridWeight', $event)"
            />
          </span>
          <input
            v-model="models.hybridWeight"
            class="kb-input"
            :disabled="isFollowing('hybridWeight')"
          />
        </label>
      </div>
      <div class="kb-rerank-row">
        <SettingToggle
          :model-value="booleanValue('rerankEnabled')"
          :disabled="isFollowing('rerankEnabled')"
          @update:model-value="onBooleanChange('rerankEnabled', $event)"
        />
        <span class="kb-rerank-label">启用重排</span>
        <KnowledgeFollowToggle
          v-if="props.custom != null"
          :following="isFollowing('rerankEnabled')"
          @update:following="onFollowChange('rerankEnabled', $event)"
        />
        <div class="kb-select-wrap">
          <select
            v-model="models.rerankModel"
            class="kb-input kb-select kb-select--sm"
            :disabled="isFollowing('rerankModel') || !booleanValue('rerankEnabled')"
          >
            <option
              v-for="opt in KNOWLEDGE_FIELD_DEFS.rerankModel.options"
              :key="String(opt.value)"
              :value="opt.value"
            >
              {{ opt.label }}
            </option>
            <option v-for="name in customModelNames" :key="name" :value="name">
              {{ name }}
            </option>
          </select>
          <svg
            class="kb-select-chevron"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>
        <KnowledgeFollowToggle
          v-if="props.custom != null"
          :following="isFollowing('rerankModel')"
          @update:following="onFollowChange('rerankModel', $event)"
        />
        <span class="kb-inline-label">召回 Top</span>
        <input
          v-model="models.topK"
          class="kb-input kb-input--topk"
          :disabled="isFollowing('topK') || !booleanValue('rerankEnabled')"
        />
        <KnowledgeFollowToggle
          v-if="props.custom != null"
          :following="isFollowing('topK')"
          @update:following="onFollowChange('topK', $event)"
        />
      </div>
    </section>

    <!-- 知识图谱抽取 -->
    <section class="kb-card">
      <div class="kb-card-head kb-card-head--between">
        <div>
          <h2 class="kb-title">知识图谱抽取</h2>
          <p class="kb-desc">从文档中抽取实体、关系与属性，用于多跳关联问答。</p>
        </div>
        <div class="kb-toggle-group">
          <KnowledgeFollowToggle
            v-if="props.custom != null"
            :following="isFollowing('graphEnabled')"
            @update:following="onFollowChange('graphEnabled', $event)"
          />
          <SettingToggle
            :model-value="booleanValue('graphEnabled')"
            :disabled="isFollowing('graphEnabled')"
            @update:model-value="onBooleanChange('graphEnabled', $event)"
          />
        </div>
      </div>
      <div class="kb-graph-field">
        <label class="kb-field">
          <span class="kb-label" :class="{ 'kb-label--row': props.custom != null }">
            <span>抽取模型</span>
            <KnowledgeFollowToggle
              v-if="props.custom != null"
              :following="isFollowing('graphModel')"
              @update:following="onFollowChange('graphModel', $event)"
            />
          </span>
          <div class="kb-select-wrap">
            <select
              v-model="models.graphModel"
              class="kb-input kb-select"
              :disabled="isFollowing('graphModel') || !booleanValue('graphEnabled')"
            >
              <option
                v-for="opt in KNOWLEDGE_FIELD_DEFS.graphModel.options"
                :key="String(opt.value)"
                :value="opt.value"
              >
                {{ opt.label }}
              </option>
              <option v-for="name in customModelNames" :key="name" :value="name">
                {{ name }}
              </option>
            </select>
            <svg
              class="kb-select-chevron"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
        </label>
        <p class="kb-hint kb-hint--tight">仅在启用后，对新导入文件执行实体关系抽取。</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* ═══════════════════ 卡片 ═══════════════════ */
.kb-card {
  border-radius: 16px;
  padding: 20px;
  background: var(--kw-color-surface);
  border: 1px solid var(--kw-color-border);
}

.kb-card--soft {
  background: var(--kw-color-bg-soft);
}

.kb-card-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.kb-card-head--between {
  justify-content: space-between;
  gap: 20px;
}

.kb-card-icon {
  display: inline-flex;
  margin-top: 2px;
  flex-shrink: 0;
  color: var(--kw-color-brand);
}

.kb-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.kb-desc {
  margin-top: 4px;
  font-size: 14px;
  color: var(--kw-color-text-muted);
}

/* 卡片头开关 + 其「跟随全局」开关（按库模式） */
.kb-toggle-group {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

/* ═══════════════════ 目录行 ═══════════════════ */
.kb-dir-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 20px;
}

.kb-dir-input {
  flex: 1;
  min-width: 0;
}

.kb-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  height: 40px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--kw-color-border);
  background: var(--kw-color-surface);
  color: var(--kw-color-text-secondary);
  font-size: 14px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.kb-btn:hover {
  background: var(--kw-color-bg-soft);
  color: var(--kw-color-text);
}

.kb-btn-icon {
  flex-shrink: 0;
}

.kb-hint {
  margin-top: 12px;
  font-size: 12px;
  color: var(--kw-color-text-faint);
}

.kb-hint--tight {
  margin-top: 8px;
}

/* ═══════════════════ 字段网格 ═══════════════════ */
.kb-form {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.kb-grid {
  display: grid;
  gap: 16px;
  margin-top: 20px;
}

.kb-grid--3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.kb-grid--2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.kb-field {
  display: block;
  min-width: 0;
}

.kb-label {
  display: block;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--kw-color-text-secondary);
}

/* 按库模式：标签与「跟随全局」开关同行，此时标签自身不再占行 */
.kb-label--row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

/* ═══════════════════ 输入框 ═══════════════════ */
.kb-input {
  display: block;
  width: 100%;
  height: 40px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--kw-color-border);
  background: var(--kw-color-bg-soft);
  font-size: 14px;
  font-family: inherit;
  color: var(--kw-color-text);
  outline: none;
}

.kb-input:focus {
  border-color: var(--kw-color-brand);
  box-shadow: 0 0 0 3px var(--kw-color-brand-soft);
}

.kb-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.kb-dir-input {
  background: var(--kw-color-surface);
}

/* 带单位后缀：外框承接边框，内部 input 去边框 */
.kb-unit-box {
  display: flex;
  align-items: center;
  overflow: hidden;
  height: 40px;
  border-radius: 8px;
  border: 1px solid var(--kw-color-border);
  background: var(--kw-color-bg-soft);
}

.kb-unit-box .kb-input--bare {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: none;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.kb-unit-box:focus-within {
  border-color: var(--kw-color-brand);
  box-shadow: 0 0 0 3px var(--kw-color-brand-soft);
}

.kb-unit {
  flex-shrink: 0;
  align-self: stretch;
  display: inline-flex;
  align-items: center;
  padding: 0 12px;
  border-left: 1px solid var(--kw-color-border);
  font-size: 12px;
  color: var(--kw-color-text-muted);
  white-space: nowrap;
}

/* ═══════════════════ 下拉框 ═══════════════════ */
.kb-select-wrap {
  position: relative;
}

.kb-select {
  appearance: none;
  -webkit-appearance: none;
  padding-right: 34px;
  cursor: pointer;
}

.kb-select-chevron {
  position: absolute;
  right: 11px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--kw-color-text-muted);
  pointer-events: none;
}

.kb-select--sm {
  width: auto;
  min-width: 210px;
  height: 36px;
  padding: 0 34px 0 12px;
  font-size: 13px;
}

.kb-select--sm + .kb-select-chevron {
  right: 10px;
}

/* ═══════════════════ 重排行 ═══════════════════ */
.kb-rerank-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid var(--kw-color-border-soft);
}

.kb-rerank-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--kw-color-text-secondary);
}

.kb-inline-label {
  font-size: 13px;
  color: var(--kw-color-text-muted);
}

.kb-input--topk {
  width: 56px;
  flex-shrink: 0;
  height: 36px;
  padding: 0 8px;
  text-align: center;
  font-size: 13px;
}

.kb-graph-field {
  max-width: 420px;
  margin-top: 20px;
}

/* 窄窗口降级：并排字段折行 */
@media (max-width: 900px) {
  .kb-grid--3,
  .kb-grid--2 {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
