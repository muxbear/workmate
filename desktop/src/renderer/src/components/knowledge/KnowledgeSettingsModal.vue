<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import KnowledgeConfigForm from './KnowledgeConfigForm.vue'
import {
  createDraft,
  draftValueToOverride,
  KNOWLEDGE_FIELD_LIST,
  KNOWLEDGE_OVERRIDE_KEYS,
  type KnowledgeDraft,
  type KnowledgeDraftValue
} from './knowledgeFields'
import { useSettingsStore } from '../../store/settings'
import { useKnowledgeSettingsStore } from '../../store/knowledgeSettings'
import type { KnowledgeOverrideKey, KnowledgeOverrides } from '../../../../preload/index.d'

/**
 * 按知识库设置弹窗
 *
 * 字段与「知识库设置」页完全一致（共用 KnowledgeConfigForm），差别在于每项默认「跟随全局」：
 * 只有打开该项的自定义开关后才写入该知识库的覆盖值，未覆盖项随全局设置变化自动跟随。
 */
const props = defineProps<{
  open: boolean
  /** 目标知识库（关闭动画期间可能为 null） */
  library: { id: string; name: string } | null
}>()

const emit = defineEmits<{
  close: []
  saved: [name: string]
}>()

const settingsStore = useSettingsStore()
const kbStore = useKnowledgeSettingsStore()

/** 窗口可见性：由父组件 open prop 驱动，保证关闭时有退出动画 */
const visible = ref(props.open)
/** 标题：打开时固定，避免关闭动画期间名字消失 */
const displayName = ref('')

/** 覆盖值草稿（只对「自定义」的项有意义） */
const draft = reactive<KnowledgeDraft>(createDraft({}))
/** 逐项是否自定义（false = 跟随全局） */
const custom = reactive({} as Record<KnowledgeOverrideKey, boolean>)
for (const key of KNOWLEDGE_OVERRIDE_KEYS) custom[key] = false

const globalDraft = computed(() => createDraft(settingsStore.knowledgeGlobalValues))

/** 表单显示值：自定义项取覆盖值，跟随项取全局当前值（全局一变即刻反映） */
const displayDraft = computed<KnowledgeDraft>(() => {
  const out = {} as KnowledgeDraft
  for (const field of KNOWLEDGE_FIELD_LIST) {
    out[field.key] = custom[field.key] ? draft[field.key] : globalDraft.value[field.key]
  }
  return out
})

const saving = ref(false)
const error = ref('')

/** 打开时准备草稿；用令牌丢弃过期的异步结果（连续切换知识库/快速关闭） */
let prepareToken = 0

async function prepare(kbId: string): Promise<void> {
  const token = ++prepareToken
  error.value = ''
  saving.value = false
  if (!settingsStore.loaded) await settingsStore.load()
  await kbStore.ensureLoaded(kbId)
  if (token !== prepareToken) return
  const overrides = kbStore.overridesFor(kbId)
  Object.assign(draft, createDraft({ ...kbStore.globalValues, ...overrides }))
  for (const key of KNOWLEDGE_OVERRIDE_KEYS) {
    custom[key] = Object.prototype.hasOwnProperty.call(overrides, key)
  }
}

watch(
  () => [props.open, props.library?.id] as const,
  ([open, kbId]) => {
    visible.value = open
    if (open && kbId) {
      displayName.value = props.library?.name ?? ''
      void prepare(kbId)
    }
  },
  { immediate: true }
)

/** 表单改动：写入草稿（只有非跟随项会被编辑，跟随项控件是禁用的） */
function onFieldChange(key: KnowledgeOverrideKey, value: KnowledgeDraftValue): void {
  draft[key] = value
}

/** 切换「跟随全局 / 自定义」：转为自定义时以当前显示值作为起点 */
function onCustomChange(key: KnowledgeOverrideKey, isCustom: boolean): void {
  if (!isCustom) {
    custom[key] = false
    return
  }
  draft[key] = displayDraft.value[key]
  custom[key] = true
}

/** 全部恢复跟随全局（本地生效，仍需点保存才落盘） */
function resetToGlobal(): void {
  for (const key of KNOWLEDGE_OVERRIDE_KEYS) custom[key] = false
}

/** 组装覆盖项：跳过跟随全局的项（稀疏序列化，省略即跟随） */
function buildOverrides(): KnowledgeOverrides | null {
  const out: KnowledgeOverrides = {}
  for (const field of KNOWLEDGE_FIELD_LIST) {
    if (!custom[field.key]) continue
    const result = draftValueToOverride(field, draft[field.key])
    if ('error' in result) {
      error.value = result.error
      return null
    }
    out[field.key] = result.value
  }
  return out
}

async function onSave(): Promise<void> {
  const target = props.library
  if (!target) return
  error.value = ''
  const overrides = buildOverrides()
  if (!overrides) return
  saving.value = true
  const ok = await kbStore.saveOverrides(target.id, overrides)
  saving.value = false
  if (!ok) {
    error.value = kbStore.lastError || '保存失败'
    return
  }
  emit('saved', target.name)
  emit('close')
}

function closeModal(): void {
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && visible.value) closeModal()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Transition name="ks-modal">
    <div v-if="visible" class="ks-mask" @click.self="closeModal">
      <div
        class="ks-card"
        role="dialog"
        aria-modal="true"
        :aria-label="`「${displayName}」知识库设置`"
      >
        <header class="ks-header">
          <div>
            <h2 class="ks-title">知识库设置</h2>
            <p class="ks-subtitle">「{{ displayName }}」——未开启自定义的项跟随全局「知识库设置」</p>
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
          <KnowledgeConfigForm
            :draft="displayDraft"
            :custom="custom"
            @change="onFieldChange"
            @update:custom="onCustomChange"
          />
        </div>

        <footer class="ks-footer">
          <div class="ks-footer-left">
            <button class="ks-btn" type="button" :disabled="saving" @click="resetToGlobal">
              全部恢复跟随全局
            </button>
            <span v-if="error" class="ks-error">{{ error }}</span>
          </div>
          <div class="ks-footer-right">
            <button class="ks-btn" type="button" :disabled="saving" @click="closeModal">
              取消
            </button>
            <button class="ks-btn ks-btn--primary" type="button" :disabled="saving" @click="onSave">
              保存设置
            </button>
          </div>
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
  width: min(960px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
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
  gap: 20px;
  padding: 20px 24px;
  border-bottom: 1px solid var(--kw-color-border-brand);
}

.ks-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.ks-subtitle {
  margin-top: 4px;
  font-size: 12px;
  color: var(--kw-color-text-faint);
}

.ks-close {
  flex-shrink: 0;
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
  padding: 20px 24px;
}

.ks-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 24px;
  border-top: 1px solid var(--kw-color-border-brand);
}

.ks-footer-left,
.ks-footer-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ks-error {
  font-size: 12px;
  color: #cf625b;
}

.ks-btn {
  padding: 8px 16px;
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

.ks-btn:hover:not(:disabled) {
  background: var(--kw-color-bg-soft);
  color: var(--kw-color-text);
}

.ks-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.ks-btn--primary {
  border-color: transparent;
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
}

.ks-btn--primary:hover:not(:disabled) {
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
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
  transform: scale(0.98) translateY(8px);
}
</style>
