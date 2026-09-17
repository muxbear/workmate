<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import SettingToggle from '../settings/SettingToggle.vue'
import {
  BUILTIN_MODEL_OPTIONS,
  createDraft,
  draftValueToOverride,
  KNOWLEDGE_FIELD_DEFS,
  type KnowledgeDraft
} from './knowledgeFields'
import {
  INDEX_FIELD_KEYS,
  KNOWLEDGE_INDEX_STEPS,
  KNOWLEDGE_UPLOAD_OPTIONS,
  pickIndexConfig,
  summarizeIndexConfig,
  type KnowledgeUploadMode,
  type KnowledgeUploadPayload
} from './uploadIndex'
import { useKnowledgeSettingsStore } from '../../store/knowledgeSettings'
import { useModelStore } from '../../store/models'
import { useSettingsStore } from '../../store/settings'
import type { KnowledgeOverrideKey, KnowledgeOverrides } from '../../../../preload/index.d'

/**
 * 上传文件弹窗
 *
 * 1）拖入/选择文件 → 待上传列表（可逐个删除）→ 单选处理方式：
 *    创建默认索引 / 自定义索引 / 只上传文件；
 * 2）「自定义索引」在点确定后进入配置向导，逐步配置切片、向量化、检索与图谱，
 *    可配置项与「知识库设置」的索引项完全一致（同一份字段表派生）；
 * 3）底部按钮按所选处理方式推进：默认索引与只上传文件直接提交，自定义索引走完向导后提交。
 *
 * 当前只做渲染层：File 对象与索引配置只回到页面内存，字节不落盘（主进程链路待实现）。
 */
const props = defineProps<{
  open: boolean
  /** 目标知识库（关闭动画期间可能为 null） */
  library: { id: string; name: string } | null
}>()

const emit = defineEmits<{
  close: []
  submit: [payload: KnowledgeUploadPayload]
}>()

const settingsStore = useSettingsStore()
const kbStore = useKnowledgeSettingsStore()
const modelStore = useModelStore()

/** 待上传条目（同名文件可能一起拖入，用自增 id 作 key） */
interface UploadQueueItem {
  id: number
  file: File
  name: string
  typeText: string
  sizeText: string
  tint: string
}

/** 弹窗阶段：files = 选文件与处理方式；index = 自定义索引向导 */
type UploadStage = 'files' | 'index'

const visible = ref(props.open)
const displayName = ref('')
const stage = ref<UploadStage>('files')
// 索引能力未开放：默认且仅支持「只上传文件」
const mode = ref<KnowledgeUploadMode>('none')
const queue = ref<UploadQueueItem[]>([])
const dragging = ref(false)
const error = ref('')
const stepIndex = ref(0)
const fileInputRef = ref<HTMLInputElement | null>(null)
/** 向导草稿：数值项以字符串承接（与设置页一致，保存时统一解析校验） */
const draft = reactive<KnowledgeDraft>(createDraft({}))

let queueSeq = 0
let dragDepth = 0
let prepareToken = 0

// ── 待上传文件队列 ──
/** 扩展名 → 图标底色（与文件列表同一套色板） */
const EXT_TINTS: Record<string, string> = {
  pdf: '#ef4444',
  doc: '#3b82f6',
  docx: '#3b82f6',
  xls: '#16a34a',
  xlsx: '#16a34a',
  csv: '#16a34a',
  ppt: '#e8793d',
  pptx: '#e8793d',
  md: '#168b7a',
  txt: '#168b7a'
}

function fileExt(name: string): string {
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index + 1).toLowerCase() : ''
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${bytes} B`
}

/** 同一文件重复拖入时只保留一份（同名 + 同大小 + 同修改时间） */
function queueKey(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`
}

function addFiles(list: FileList | File[] | null): void {
  const files = list ? Array.from(list) : []
  if (!files.length) return
  const known = new Set(queue.value.map((item) => queueKey(item.file)))
  const added: UploadQueueItem[] = []
  for (const file of files) {
    const key = queueKey(file)
    if (known.has(key)) continue
    known.add(key)
    const ext = fileExt(file.name)
    added.push({
      id: ++queueSeq,
      file,
      name: file.name,
      typeText: ext ? ext.toUpperCase() : '文件',
      sizeText: formatSize(file.size),
      tint: EXT_TINTS[ext] ?? '#64748b'
    })
  }
  if (!added.length) return
  queue.value = [...queue.value, ...added]
  error.value = ''
}

function removeItem(id: number): void {
  queue.value = queue.value.filter((item) => item.id !== id)
}

function clearQueue(): void {
  queue.value = []
}

function openPicker(): void {
  fileInputRef.value?.click()
}

function onPickerChange(event: Event): void {
  const input = event.target as HTMLInputElement
  addFiles(input.files)
  input.value = '' // 复位，同一文件可以再次选择
}

// ── 拖拽投放 ──
/** 只响应文件拖拽（文本拖拽保留默认行为） */
function isFileDrag(event: DragEvent): boolean {
  return !!event.dataTransfer?.types.includes('Files')
}

/** dragenter/dragleave 会在子节点间冒泡，用深度计数防高亮闪烁 */
function onDragEnter(event: DragEvent): void {
  event.preventDefault()
  if (!isFileDrag(event)) return
  dragDepth += 1
  dragging.value = true
}

/** 持续派发时也要阻止默认，否则 drop 不被允许 */
function onDragOver(event: DragEvent): void {
  event.preventDefault()
}

function onDragLeave(event: DragEvent): void {
  if (!isFileDrag(event)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragging.value = false
}

function onDrop(event: DragEvent): void {
  event.preventDefault()
  dragDepth = 0
  dragging.value = false
  addFiles(event.dataTransfer?.files ?? null)
}

// ── 默认索引配置来源 ──
/** 该知识库自己的覆盖项（稀疏；空对象 = 全部跟随全局） */
const overrides = computed(() => (props.library ? kbStore.overridesFor(props.library.id) : {}))

/** 该库是否已有索引配置数据（任一索引项被覆盖即视为「有」） */
const hasOwnIndexConfig = computed(() =>
  INDEX_FIELD_KEYS.some((key) => Object.prototype.hasOwnProperty.call(overrides.value, key))
)

/** 生效索引配置 = 全局值 ← 逐项覆盖；该库没有索引配置时就是全局索引配置 */
const effectiveIndexConfig = computed(() =>
  pickIndexConfig(props.library ? kbStore.effectiveFor(props.library.id) : kbStore.globalValues)
)

/** 「创建默认索引」将使用的配置来源 */
const defaultSourceLabel = computed(() =>
  hasOwnIndexConfig.value ? `「${displayName.value}」的索引配置` : '全局索引配置'
)

const defaultSummary = computed(() => summarizeIndexConfig(effectiveIndexConfig.value))

const totalSizeText = computed(() =>
  formatSize(queue.value.reduce((sum, item) => sum + item.file.size, 0))
)

// ── 自定义索引向导 ──
const steps = KNOWLEDGE_INDEX_STEPS
const currentStep = computed(() => steps[stepIndex.value] ?? steps[0])
const currentStepFields = computed(() =>
  currentStep.value.keys.map((key) => KNOWLEDGE_FIELD_DEFS[key])
)
const isLastStep = computed(() => stepIndex.value >= steps.length - 1)

/** models.json 里的自定义模型名（与「知识库设置」一样可作为候选项） */
const customModelNames = computed(() => {
  const names = modelStore.models
    .map((item) => item.name)
    .filter((name) => name && !BUILTIN_MODEL_OPTIONS.includes(name))
  return [...new Set(names)]
})

/** 布尔项显示值（SettingToggle 需要严格的 boolean） */
function booleanValue(key: KnowledgeOverrideKey): boolean {
  return draft[key] === true
}

function onNumberInput(key: KnowledgeOverrideKey, event: Event): void {
  draft[key] = (event.target as HTMLInputElement).value
}

function onSelectChange(key: KnowledgeOverrideKey, event: Event): void {
  draft[key] = (event.target as HTMLSelectElement).value
}

function onBooleanChange(key: KnowledgeOverrideKey, value: boolean): void {
  draft[key] = value
}

/**
 * 逐项把草稿转成可提交值（沿用设置页的校验函数，区间/枚举边界完全一致）；
 * 任一非法项返回 null 并给出对应文案。
 */
function buildConfig(keys: readonly KnowledgeOverrideKey[]): KnowledgeOverrides | null {
  const out: KnowledgeOverrides = {}
  for (const key of keys) {
    const result = draftValueToOverride(KNOWLEDGE_FIELD_DEFS[key], draft[key])
    if ('error' in result) {
      error.value = result.error
      return null
    }
    out[key] = result.value
  }
  return out
}

// ── 打开 / 关闭 ──
const canSubmit = computed(() => queue.value.length > 0)

/** 打开时准备数据：全局 17 项 + 该知识库覆盖项；向导草稿以生效配置为起点 */
async function prepare(kbId: string): Promise<void> {
  const token = ++prepareToken
  if (!settingsStore.loaded) await settingsStore.load()
  await kbStore.ensureLoaded(kbId)
  if (token !== prepareToken) return
  Object.assign(draft, createDraft(kbStore.effectiveFor(kbId)))
}

watch(
  () => [props.open, props.library?.id] as const,
  ([open, kbId]) => {
    visible.value = open
    if (!open) return
    displayName.value = props.library?.name ?? ''
    stage.value = 'files'
    mode.value = 'none'
    queue.value = []
    error.value = ''
    stepIndex.value = 0
    dragDepth = 0
    dragging.value = false
    if (kbId) void prepare(kbId)
  },
  { immediate: true }
)

function closeModal(): void {
  emit('close')
}

/** 确定：默认索引与只上传文件直接提交；自定义索引先进入向导 */
function onConfirm(): void {
  if (!canSubmit.value) return
  error.value = ''
  if (mode.value === 'custom') {
    stage.value = 'index'
    stepIndex.value = 0
    return
  }
  const files = queue.value.map((item) => item.file)
  if (mode.value === 'none') {
    emit('submit', { files, mode: 'none', config: {}, sourceLabel: '' })
    emit('close')
    return
  }
  emit('submit', {
    files,
    mode: 'default',
    config: effectiveIndexConfig.value as KnowledgeOverrides,
    sourceLabel: defaultSourceLabel.value
  })
  emit('close')
}

/** 向导：下一步（只校验当前步） */
function nextStep(): void {
  error.value = ''
  if (!buildConfig(currentStep.value.keys)) return
  if (isLastStep.value) return
  stepIndex.value = Math.min(steps.length - 1, stepIndex.value + 1)
}

/** 向导：上一步（第一步时回到文件列表） */
function prevStep(): void {
  error.value = ''
  if (stepIndex.value === 0) {
    stage.value = 'files'
    return
  }
  stepIndex.value -= 1
}

/** 向导：完成（校验全部索引项后提交） */
function finish(): void {
  error.value = ''
  const config = buildConfig(INDEX_FIELD_KEYS)
  if (!config) return
  emit('submit', {
    files: queue.value.map((item) => item.file),
    mode: 'custom',
    config,
    sourceLabel: '自定义索引配置'
  })
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && visible.value) closeModal()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  void modelStore.load()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Transition name="ku-modal">
    <div v-if="visible" class="ku-mask" @click.self="closeModal">
      <div class="ku-card" role="dialog" aria-modal="true" aria-label="上传文件">
        <header class="ku-header">
          <div class="ku-header-text">
            <h2 class="ku-title">{{ stage === 'files' ? '上传文件' : '自定义索引' }}</h2>
            <p class="ku-subtitle">
              {{
                stage === 'files'
                  ? `上传到「${displayName}」`
                  : `为 ${queue.length} 个文件逐步配置本次索引`
              }}
            </p>
          </div>
          <button class="ku-close" type="button" aria-label="关闭" @click="closeModal">
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

        <div class="ku-body">
          <template v-if="stage === 'files'">
            <!-- 可拖入的上传区域 -->
            <div
              class="ku-dropzone"
              :class="{ 'ku-dropzone--active': dragging }"
              role="button"
              tabindex="0"
              @click="openPicker"
              @keydown.enter.prevent="openPicker"
              @keydown.space.prevent="openPicker"
              @dragenter="onDragEnter"
              @dragover="onDragOver"
              @dragleave="onDragLeave"
              @drop="onDrop"
            >
              <input
                ref="fileInputRef"
                type="file"
                multiple
                class="ku-file-input"
                @click.stop
                @change="onPickerChange"
              />
              <span class="ku-drop-icon">
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" x2="12" y1="3" y2="15" />
                </svg>
              </span>
              <p class="ku-drop-title">
                拖拽文件到此处，或<span class="ku-drop-link">点击选择文件</span>
              </p>
              <p class="ku-drop-hint">
                支持 PDF、Word、Excel、PPT、Markdown、TXT 等格式，可一次选择多个文件
              </p>
            </div>

            <!-- 待上传文件列表 -->
            <section class="ku-section">
              <div class="ku-section-head">
                <span class="ku-section-title">
                  待上传文件
                  <span class="ku-count">{{ queue.length }}</span>
                </span>
                <div class="ku-section-actions">
                  <span v-if="queue.length" class="ku-total">{{ totalSizeText }}</span>
                  <button v-if="queue.length" class="ku-link" type="button" @click="clearQueue">
                    清空
                  </button>
                </div>
              </div>

              <ul v-if="queue.length" class="ku-queue">
                <li v-for="item in queue" :key="item.id" class="ku-queue-item">
                  <span
                    class="ku-item-icon"
                    :style="{ color: item.tint, background: item.tint + '14' }"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                      <path d="M10 9H8" />
                      <path d="M16 13H8" />
                      <path d="M16 17H8" />
                    </svg>
                  </span>
                  <span class="ku-item-name">{{ item.name }}</span>
                  <span class="ku-item-meta">{{ item.typeText }} · {{ item.sizeText }}</span>
                  <button
                    class="ku-item-del"
                    type="button"
                    :title="`移除 ${item.name}`"
                    :aria-label="`移除 ${item.name}`"
                    @click="removeItem(item.id)"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M3 6h18" />
                      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                      <line x1="10" x2="10" y1="11" y2="17" />
                      <line x1="14" x2="14" y1="11" y2="17" />
                    </svg>
                  </button>
                </li>
              </ul>
              <p v-else class="ku-empty">还没有待上传文件，拖入或选择文件后会显示在这里。</p>
            </section>

            <!-- 上传后处理：三选一（索引未开放时仅「只上传文件」可选） -->
            <section class="ku-section">
              <p class="ku-section-title">上传后处理</p>
              <p class="ku-index-notice">
                索引功能开发中：本次仅支持「只上传文件」，创建索引与自定义索引将在后续版本开放。
              </p>
              <div class="ku-options">
                <label
                  v-for="option in KNOWLEDGE_UPLOAD_OPTIONS"
                  :key="option.value"
                  class="ku-option"
                  :class="{
                    'ku-option--active': mode === option.value,
                    'ku-option--disabled': option.value !== 'none'
                  }"
                >
                  <input
                    class="ku-radio-input"
                    type="radio"
                    name="ku-upload-mode"
                    :value="option.value"
                    :checked="mode === option.value"
                    :disabled="option.value !== 'none'"
                    @change="mode = option.value"
                  />
                  <span class="ku-radio" aria-hidden="true"></span>
                  <span class="ku-option-text">
                    <span class="ku-option-label">{{ option.label }}</span>
                    <span class="ku-option-desc">{{ option.description }}</span>
                    <span v-if="option.value === 'default'" class="ku-option-note">
                      本次将使用：{{ defaultSourceLabel }}
                    </span>
                    <span v-else-if="option.value === 'custom'" class="ku-option-note">
                      {{ steps.length }} 步引导配置
                    </span>
                  </span>
                </label>
              </div>
            </section>

            <!-- 创建默认索引：预览将使用的索引配置 -->
            <section v-if="mode === 'default'" class="ku-summary">
              <div class="ku-summary-head">
                <span class="ku-summary-title">将使用的索引配置</span>
                <span class="ku-summary-hint">
                  {{
                    hasOwnIndexConfig
                      ? '来自该知识库的索引配置'
                      : '该知识库暂无索引配置，使用全局索引配置'
                  }}
                </span>
              </div>
              <div class="ku-summary-grid">
                <div v-for="row in defaultSummary" :key="row.key" class="ku-summary-item">
                  <span class="ku-summary-label">{{ row.label }}</span>
                  <span class="ku-summary-value">{{ row.text }}</span>
                </div>
              </div>
            </section>
          </template>

          <!-- 自定义索引向导 -->
          <template v-else>
            <ol class="ku-steps">
              <li
                v-for="(step, index) in steps"
                :key="step.title"
                class="ku-step"
                :class="{
                  'ku-step--active': index === stepIndex,
                  'ku-step--done': stepIndex > index
                }"
              >
                <span class="ku-step-index">{{ index + 1 }}</span>
                <span class="ku-step-title">{{ step.title }}</span>
              </li>
            </ol>

            <section class="ku-step-card">
              <h3 class="ku-step-heading">{{ currentStep.title }}</h3>
              <p class="ku-step-desc">{{ currentStep.description }}</p>

              <div class="ku-grid">
                <template v-for="field in currentStepFields" :key="field.key">
                  <div v-if="field.kind === 'boolean'" class="ku-switch-row">
                    <span class="ku-switch-label">{{ field.label }}</span>
                    <SettingToggle
                      :model-value="booleanValue(field.key)"
                      @update:model-value="onBooleanChange(field.key, $event)"
                    />
                  </div>
                  <label v-else class="ku-field">
                    <span class="ku-label">{{ field.label }}</span>
                    <span v-if="field.kind === 'select'" class="ku-select-wrap">
                      <select
                        class="ku-input ku-select"
                        :value="String(draft[field.key])"
                        @change="onSelectChange(field.key, $event)"
                      >
                        <option
                          v-for="opt in field.options ?? []"
                          :key="String(opt.value)"
                          :value="opt.value"
                        >
                          {{ opt.label }}
                        </option>
                        <option
                          v-for="name in field.withCustomModels ? customModelNames : []"
                          :key="name"
                          :value="name"
                        >
                          {{ name }}
                        </option>
                      </select>
                      <svg
                        class="ku-select-chevron"
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
                    </span>
                    <span v-else class="ku-unit-box">
                      <input
                        class="ku-input"
                        :class="{ 'ku-input--bare': !!field.unit }"
                        :value="String(draft[field.key])"
                        @input="onNumberInput(field.key, $event)"
                      />
                      <span v-if="field.unit" class="ku-unit">{{ field.unit }}</span>
                    </span>
                    <span v-if="field.kind === 'number' && field.min != null" class="ku-field-hint">
                      取值范围 {{ field.min }} ~ {{ field.max }}
                    </span>
                  </label>
                </template>
              </div>
            </section>

            <p v-if="error" class="ku-error">{{ error }}</p>
            <p v-else class="ku-tip">索引配置只作用于本次上传的文件，完成后写入文件的配置快照。</p>
          </template>
        </div>

        <footer class="ku-footer">
          <div class="ku-footer-left">
            <button v-if="stage === 'files'" class="ku-btn" type="button" @click="closeModal">
              取消
            </button>
            <button v-else class="ku-btn" type="button" @click="prevStep">
              {{ stepIndex === 0 ? '返回文件列表' : '上一步' }}
            </button>
          </div>
          <div class="ku-footer-right">
            <span class="ku-footer-hint">
              {{
                stage === 'files'
                  ? `共 ${queue.length} 个文件`
                  : `第 ${stepIndex + 1} / ${steps.length} 步`
              }}
            </span>
            <button
              v-if="stage === 'files'"
              class="ku-btn ku-btn--primary"
              type="button"
              :disabled="!canSubmit"
              @click="onConfirm"
            >
              确定
            </button>
            <button
              v-else-if="!isLastStep"
              class="ku-btn ku-btn--primary"
              type="button"
              @click="nextStep"
            >
              下一步
            </button>
            <button v-else class="ku-btn ku-btn--primary" type="button" @click="finish">
              完成并上传
            </button>
          </div>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.ku-mask {
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

.ku-card {
  display: flex;
  width: min(720px, calc(100vw - 48px));
  max-height: calc(100vh - 96px);
  flex-direction: column;
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid var(--kw-color-border-brand);
  background: var(--kw-color-surface);
  box-shadow: var(--kw-shadow-card);
}

.ku-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 24px;
  border-bottom: 1px solid var(--kw-color-border-brand);
}

.ku-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.ku-subtitle {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--kw-color-text-muted);
}

.ku-close {
  padding: 4px;
  border: none;
  background: transparent;
  color: var(--kw-color-text-faint);
  cursor: pointer;
}
.ku-close:hover {
  color: var(--kw-color-text);
}

.ku-body {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
  padding: 20px 24px;
}

/* ── 可拖入区域 ── */
.ku-dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 26px 20px;
  border-radius: 14px;
  border: 1.5px dashed var(--kw-color-border);
  background: var(--kw-color-bg-soft);
  cursor: pointer;
  text-align: center;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease;
}
.ku-dropzone:hover {
  border-color: var(--kw-color-brand);
}
.ku-dropzone--active {
  border-color: var(--kw-color-brand);
  background: var(--kw-color-brand-soft);
}
.ku-drop-icon {
  display: flex;
  width: 40px;
  height: 40px;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand);
}
.ku-drop-title {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--kw-color-text-secondary);
}
.ku-drop-link {
  color: var(--kw-color-brand);
  font-weight: 500;
}
.ku-drop-hint {
  margin: 0;
  font-size: 12px;
  color: var(--kw-color-text-placeholder);
}
.ku-file-input {
  display: none;
}

/* ── 区块与待上传列表 ── */
.ku-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ku-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ku-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--kw-color-text-secondary);
}
.ku-count {
  min-width: 18px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand-strong);
  font-size: 11px;
  text-align: center;
}
.ku-section-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ku-total {
  font-size: 12px;
  color: var(--kw-color-text-placeholder);
}
.ku-link {
  padding: 0;
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: 12px;
  color: var(--kw-color-brand);
  cursor: pointer;
}
.ku-link:hover {
  text-decoration: underline;
}

.ku-queue {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 232px;
  overflow-y: auto;
  border-radius: 12px;
  border: 1px solid var(--kw-color-border);
  background: var(--kw-color-surface-soft);
}
.ku-queue-item {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto 24px;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--kw-color-border-soft);
}
.ku-queue-item:last-child {
  border-bottom: none;
}
.ku-item-icon {
  display: flex;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
}
.ku-item-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--kw-color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ku-item-meta {
  font-size: 11px;
  color: var(--kw-color-text-placeholder);
  white-space: nowrap;
}
.ku-item-del {
  display: flex;
  padding: 4px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--kw-color-text-faint);
  cursor: pointer;
}
.ku-item-del:hover {
  background: var(--kw-color-danger-soft);
  color: var(--kw-color-danger-strong);
}
.ku-empty {
  margin: 0;
  padding: 16px;
  border-radius: 12px;
  border: 1px dashed var(--kw-color-border);
  font-size: 12px;
  color: var(--kw-color-text-placeholder);
  text-align: center;
}

/* ── 上传后处理三选一 ── */
.ku-options {
  display: flex;
  gap: 8px;
}
.ku-option {
  position: relative;
  display: flex;
  flex: 1 1 0;
  min-width: 0;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--kw-color-border);
  background: var(--kw-color-surface);
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease;
}
.ku-option:hover {
  border-color: var(--kw-color-border-strong);
}
.ku-option--disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.ku-index-notice {
  margin: 6px 0 10px;
  font-size: 12px;
  line-height: 18px;
  color: var(--kw-color-text-muted);
}

.ku-option--active {
  border-color: var(--kw-color-brand);
  background: var(--kw-color-brand-subtle);
}
.ku-radio-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}
.ku-radio {
  position: relative;
  margin-top: 2px;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  border-radius: 50%;
  border: 1.5px solid var(--kw-color-border-strong);
  background: var(--kw-color-surface);
}
.ku-option--active .ku-radio {
  border-color: var(--kw-color-brand);
}
.ku-option--active .ku-radio::after {
  content: '';
  position: absolute;
  inset: 3px;
  border-radius: 50%;
  background: var(--kw-color-brand);
}
.ku-radio-input:focus-visible + .ku-radio {
  box-shadow: 0 0 0 3px var(--kw-color-brand-soft);
}
.ku-option-text {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}
.ku-option-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--kw-color-text);
}
.ku-option-desc {
  font-size: 12px;
  color: var(--kw-color-text-muted);
  line-height: 1.5;
}
.ku-option-note {
  font-size: 11px;
  color: var(--kw-color-brand-strong);
}

/* ── 默认索引配置预览 ── */
.ku-summary {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--kw-color-border-brand);
  background: var(--kw-color-bg-tint);
}
.ku-summary-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.ku-summary-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--kw-color-text-secondary);
}
.ku-summary-hint {
  font-size: 11px;
  color: var(--kw-color-text-muted);
}
.ku-summary-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 16px;
}
.ku-summary-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}
.ku-summary-label {
  color: var(--kw-color-text-muted);
  white-space: nowrap;
}
.ku-summary-value {
  font-weight: 500;
  color: var(--kw-color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 自定义索引向导 ── */
.ku-steps {
  display: flex;
  margin: 0;
  padding: 0;
  list-style: none;
  gap: 6px;
}
.ku-step {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 6px;
  padding: 7px 8px;
  border-radius: 10px;
  background: var(--kw-color-bg-soft);
  font-size: 12px;
  color: var(--kw-color-text-muted);
}
.ku-step-index {
  display: flex;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--kw-color-surface);
  font-size: 11px;
}
.ku-step-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ku-step--active {
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand-strong);
  font-weight: 500;
}
.ku-step--done {
  color: var(--kw-color-brand-strong);
}
.ku-step--done .ku-step-index {
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
}

.ku-step-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border-radius: 14px;
  border: 1px solid var(--kw-color-border);
  background: var(--kw-color-surface);
}
.ku-step-heading {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--kw-color-text);
}
.ku-step-desc {
  margin: -6px 0 0;
  font-size: 12px;
  color: var(--kw-color-text-muted);
  line-height: 1.6;
}
.ku-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.ku-field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
}
.ku-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--kw-color-text-secondary);
}
.ku-input {
  width: 100%;
  height: 36px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--kw-color-border);
  background: var(--kw-color-input-bg);
  font-family: inherit;
  font-size: 13px;
  color: var(--kw-color-text);
  outline: none;
}
.ku-input:focus {
  border-color: var(--kw-color-brand);
  box-shadow: 0 0 0 3px var(--kw-color-brand-soft);
}
.ku-input--bare {
  padding: 0 4px;
  border: none;
  background: transparent;
}
.ku-input--bare:focus {
  box-shadow: none;
}
.ku-select-wrap,
.ku-unit-box {
  position: relative;
  display: flex;
  align-items: center;
  border-radius: 8px;
  border: 1px solid var(--kw-color-border);
  background: var(--kw-color-input-bg);
}
.ku-select-wrap:focus-within,
.ku-unit-box:focus-within {
  border-color: var(--kw-color-brand);
  box-shadow: 0 0 0 3px var(--kw-color-brand-soft);
}
.ku-select-wrap .ku-input,
.ku-unit-box .ku-input {
  border: none;
  background: transparent;
}
.ku-select {
  appearance: none;
  padding-right: 28px;
  cursor: pointer;
}
.ku-select-chevron {
  position: absolute;
  right: 9px;
  color: var(--kw-color-text-faint);
  pointer-events: none;
}
.ku-unit {
  padding-right: 10px;
  font-size: 12px;
  color: var(--kw-color-text-muted);
  white-space: nowrap;
}
.ku-field-hint {
  font-size: 11px;
  color: var(--kw-color-text-placeholder);
}
.ku-switch-row {
  display: flex;
  grid-column: 1 / -1;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--kw-color-bg-soft);
}
.ku-switch-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--kw-color-text-secondary);
}
.ku-error {
  margin: 0;
  font-size: 12px;
  color: var(--kw-color-danger-strong);
}
.ku-tip {
  margin: 0;
  font-size: 12px;
  color: var(--kw-color-text-placeholder);
}

/* ── 底部操作 ── */
.ku-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 16px 24px;
  border-top: 1px solid var(--kw-color-border-brand);
}
.ku-footer-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ku-footer-hint {
  font-size: 12px;
  color: var(--kw-color-text-placeholder);
}
.ku-btn {
  padding: 9px 18px;
  border-radius: 12px;
  border: 1px solid var(--kw-color-border);
  background: var(--kw-color-surface);
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  color: var(--kw-color-text-secondary);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}
.ku-btn:hover {
  background: var(--kw-color-bg-soft);
  color: var(--kw-color-text);
}
.ku-btn--primary {
  border-color: transparent;
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
}
.ku-btn--primary:hover {
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
  opacity: 0.92;
}
.ku-btn--primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ku-modal-enter-active,
.ku-modal-leave-active {
  transition: opacity 0.2s;
}
.ku-modal-enter-active .ku-card,
.ku-modal-leave-active .ku-card {
  transition: transform 0.2s;
}
.ku-modal-enter-from,
.ku-modal-leave-to {
  opacity: 0;
}
.ku-modal-enter-from .ku-card,
.ku-modal-leave-to .ku-card {
  transform: scale(0.94);
}

/* 窄窗口下三选一恢复竖排，避免三列文案被挤压 */
@media (max-width: 659px) {
  .ku-options {
    flex-direction: column;
  }
}
</style>
