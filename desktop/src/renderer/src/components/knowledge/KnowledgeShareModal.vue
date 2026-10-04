<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ModalShell from '../ModalShell.vue'
import { useKnowledgeStore } from '../../store/knowledge'

/**
 * 创建共享弹窗（知识库 / 文件夹 / 文件共用）
 *
 * 链接由主进程生成并落库（knowledge:create-share），渲染层只展示与复制；
 * 本地模式链接形如 ke-work://share/<token>，云端模式由后端返回真实地址。
 */
type ShareKind = 'library' | 'folder' | 'file'

const kbStore = useKnowledgeStore()

const props = defineProps<{
  open: boolean
  /** 共享对象名称 */
  targetName: string
  /** 共享对象类型（决定文案） */
  targetKind?: ShareKind
  /** 共享对象 ID（知识库 ID 或库内相对路径），由主进程生成真实共享链接 */
  targetId?: string
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
const creating = ref(false)
const error = ref('')

const kindLabel = computed(() => KIND_LABEL[props.targetKind ?? 'file'])

watch(
  () => [props.open, props.targetName, props.targetId] as const,
  ([open]) => {
    visible.value = open
    if (open) {
      copied.value = false
      link.value = ''
      error.value = ''
      void createLink()
    }
  },
  { immediate: true }
)

/** 真实共享：主进程生成 token 并落库（本地模式为 ke-work://share/<token>） */
async function createLink(): Promise<void> {
  if (!props.targetId) {
    error.value = '缺少共享对象，无法创建链接'
    return
  }
  creating.value = true
  const share = await kbStore.createShare({
    targetKind: props.targetKind ?? 'file',
    targetId: props.targetId,
    targetName: props.targetName
  })
  creating.value = false
  if (!share) {
    error.value = kbStore.lastError || '创建共享失败'
    return
  }
  link.value = share.url
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

</script>

<template>
  <ModalShell :visible="visible" width="min(460px, calc(100vw - 48px))" aria-label="创建共享" @close="closeModal">
    <template #header>
      <div>
        <h2 class="ksh-title">创建共享</h2>
        <p class="ksh-subtitle">{{ kindLabel }}「{{ targetName }}」</p>
      </div>
    </template>

    <div class="ksh-body">
      <p class="ksh-hint">
        拿到链接的成员可以查看并下载该{{ kindLabel }}中的内容，随时都能在共享列表里取消。
      </p>
      <p v-if="error" class="ksh-error">{{ error }}</p>
      <label class="ksh-field">
        <span class="ksh-label">共享链接</span>
        <div class="ksh-link-row">
          <input
            v-model="link"
            class="ksh-input"
            readonly
            :placeholder="creating ? '生成中…' : '链接生成失败'"
          />
          <button class="ksh-copy" type="button" @click="copyLink">
            {{ copied ? '已复制' : '复制' }}
          </button>
        </div>
      </label>
    </div>

    <template #footer>
      <button class="ksh-btn" type="button" @click="closeModal">取消</button>
      <button
        class="ksh-btn ksh-btn--primary"
        type="button"
        :disabled="creating || !link"
        @click="onConfirm"
      >
        创建共享
      </button>
    </template>
  </ModalShell>
</template>

<style scoped>
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

.ksh-error {
  margin: 0;
  font-size: 12px;
  color: #cf625b;
}

.ksh-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
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

</style>
