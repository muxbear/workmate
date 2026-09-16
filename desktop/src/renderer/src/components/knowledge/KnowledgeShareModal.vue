<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * 创建共享弹窗（知识库 / 文件夹 / 文件共用）
 *
 * 仅前端演示：共享链接在本地随机生成，不落盘、不上传；
 * 等共享链路落地后，把 buildLink 换成主进程返回的地址即可。
 */
type ShareKind = 'library' | 'folder' | 'file'

const props = defineProps<{
  open: boolean
  /** 共享对象名称 */
  targetName: string
  /** 共享对象类型（决定文案） */
  targetKind?: ShareKind
}>()

const emit = defineEmits<{
  close: []
  created: [name: string]
}>()

const KIND_LABEL: Record<ShareKind, string> = {
  library: '知识库',
  folder: '文件夹',
  file: '文件'
}

/** 窗口可见性：由父组件 open prop 驱动，保证关闭时有退出动画 */
const visible = ref(props.open)
const link = ref('')
const copied = ref(false)

const kindLabel = computed(() => KIND_LABEL[props.targetKind ?? 'file'])

watch(
  () => [props.open, props.targetName] as const,
  ([open, target]) => {
    visible.value = open
    if (open) {
      link.value = buildLink(target)
      copied.value = false
    }
  },
  { immediate: true }
)

/** mock 共享链接：每次打开随机码不同 */
function buildLink(name: string): string {
  const seed = Math.random().toString(36).slice(2, 10)
  return `ke-work://share/${seed}?name=${encodeURIComponent(name)}`
}

async function copyLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(link.value)
    copied.value = true
  } catch {
    copied.value = false
  }
}

function onConfirm(): void {
  emit('created', props.targetName)
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
  <Transition name="ksh-modal">
    <div v-if="visible" class="ksh-mask" @click.self="closeModal">
      <div class="ksh-card" role="dialog" aria-modal="true" aria-label="创建共享">
        <header class="ksh-header">
          <div>
            <h2 class="ksh-title">创建共享</h2>
            <p class="ksh-subtitle">{{ kindLabel }}「{{ targetName }}」</p>
          </div>
          <button class="ksh-close" type="button" aria-label="关闭" @click="closeModal">
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

        <div class="ksh-body">
          <p class="ksh-hint">
            拿到链接的成员可以查看并下载该{{ kindLabel }}中的内容，随时都能在共享列表里取消。
          </p>
          <label class="ksh-field">
            <span class="ksh-label">共享链接</span>
            <div class="ksh-link-row">
              <input v-model="link" class="ksh-input" readonly />
              <button class="ksh-copy" type="button" @click="copyLink">
                {{ copied ? '已复制' : '复制' }}
              </button>
            </div>
          </label>
        </div>

        <footer class="ksh-footer">
          <button class="ksh-btn" type="button" @click="closeModal">取消</button>
          <button class="ksh-btn ksh-btn--primary" type="button" @click="onConfirm">
            创建共享
          </button>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.ksh-mask {
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

.ksh-card {
  width: min(460px, calc(100vw - 48px));
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid var(--kw-color-border-brand);
  background: var(--kw-color-surface);
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.2);
}

.ksh-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--kw-color-border-brand);
}

.ksh-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.ksh-subtitle {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--kw-color-text-muted);
}

.ksh-close {
  padding: 4px;
  border: none;
  background: transparent;
  color: var(--kw-color-text-faint);
  cursor: pointer;
}

.ksh-close:hover {
  color: var(--kw-color-text);
}

.ksh-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px 24px;
}

.ksh-hint {
  margin: 0;
  font-size: 12px;
  line-height: 20px;
  color: var(--kw-color-text-muted);
}

.ksh-label {
  display: block;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--kw-color-text-secondary);
}

.ksh-link-row {
  display: flex;
  gap: 8px;
}

.ksh-input {
  min-width: 0;
  flex: 1;
  height: 40px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--kw-color-border);
  background: var(--kw-color-bg-soft);
  font-size: 12px;
  font-family: inherit;
  color: var(--kw-color-text);
  outline: none;
}

.ksh-copy {
  flex-shrink: 0;
  padding: 0 14px;
  border-radius: 8px;
  border: 1px solid var(--kw-color-border);
  background: var(--kw-color-surface);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  color: var(--kw-color-text-secondary);
  cursor: pointer;
}

.ksh-copy:hover {
  border-color: var(--kw-color-brand);
  color: var(--kw-color-brand);
}

.ksh-footer {
  display: flex;
  gap: 8px;
  padding: 0 24px 20px;
}

.ksh-btn {
  flex: 1;
  padding: 10px;
  border-radius: 12px;
  border: 1px solid var(--kw-color-border);
  background: var(--kw-color-surface);
  color: var(--kw-color-text-secondary);
  font-size: 14px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
}

.ksh-btn:hover {
  background: var(--kw-color-bg-soft);
  color: var(--kw-color-text);
}

.ksh-btn--primary {
  border-color: transparent;
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
}

.ksh-btn--primary:hover {
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
  opacity: 0.92;
}

.ksh-modal-enter-active,
.ksh-modal-leave-active {
  transition: opacity 0.2s;
}

.ksh-modal-enter-active .ksh-card,
.ksh-modal-leave-active .ksh-card {
  transition: transform 0.2s;
}

.ksh-modal-enter-from,
.ksh-modal-leave-to {
  opacity: 0;
}

.ksh-modal-enter-from .ksh-card,
.ksh-modal-leave-to .ksh-card {
  transform: scale(0.92);
}
</style>
