<script setup lang="ts">
import { ref, watch, computed, reactive } from 'vue'
import { Globe } from 'lucide-vue-next'
import type { IndexConfig } from '@/types/knowledgeBase'
import KbIndexConfigForm from './KbIndexConfigForm.vue'

const props = defineProps<{
  visible: boolean
  defaultConfig: IndexConfig
  /** 导入失败时的可读原因（由父组件传入，失败后对话框保持打开、地址不清空） */
  error?: string | null
}>()

const emit = defineEmits<{
  close: []
  submit: [url: string, config?: IndexConfig]
}>()

const dialogVisible = ref(false)
const url = ref('')
const indexMode = ref<'kb' | 'custom'>('kb')
const submitting = ref(false)
let customConfig = reactive<IndexConfig>({ ...props.defaultConfig })

const canSubmit = computed(() => /^https?:\/\/\S+$/i.test(url.value.trim()) && !submitting.value)
const dialogWidth = computed(() => (indexMode.value === 'custom' ? '760px' : '560px'))

watch(() => props.visible, (v) => {
  dialogVisible.value = v
  if (v) {
    submitting.value = false
    indexMode.value = 'kb'
    Object.assign(customConfig, props.defaultConfig)
  }
})

watch(indexMode, (mode) => {
  if (mode === 'custom') Object.assign(customConfig, props.defaultConfig)
})

function handleClose() {
  dialogVisible.value = false
  emit('close')
}

function handleSubmit() {
  if (!canSubmit.value) return
  submitting.value = true
  emit(
    'submit',
    url.value.trim(),
    indexMode.value === 'custom' ? { ...customConfig } : undefined,
  )
}
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    :width="dialogWidth"
    :close-on-click-modal="false"
    @close="handleClose"
    class="url-import-dialog"
    destroy-on-close
  >
    <template #header>
      <div class="dialog-header">
        <h2 class="dialog-title">导入网页</h2>
        <p class="dialog-desc">
          抓取页面正文并建成一篇文档。只能导入<strong>白名单内</strong>的域名，
          内网地址一律拒绝。
        </p>
      </div>
    </template>

    <div class="dialog-body">
      <div class="field">
        <label class="field-label">网页地址</label>
        <input
          v-model="url"
          type="url"
          class="field-input"
          placeholder="https://example.com/docs/page.html"
          @keyup.enter="handleSubmit"
        />
      </div>

      <!-- 失败原因就地显示：地址保留，用户改完可以直接重试 -->
      <div v-if="error" class="field-error">{{ error }}</div>

      <div v-if="indexMode === 'custom'" class="custom-config-section">
        <div class="config-section-title">自定义索引配置</div>
        <KbIndexConfigForm v-model="customConfig" />
      </div>
    </div>

    <template #footer>
      <div class="dialog-footer">
        <el-radio-group v-model="indexMode" size="small" class="index-mode-radio">
          <el-radio value="kb">使用知识库索引</el-radio>
          <el-radio value="custom">自定义索引</el-radio>
        </el-radio-group>
        <div class="footer-buttons">
          <button class="btn-cancel" @click="handleClose">取消</button>
          <button class="btn-upload" :disabled="!canSubmit" @click="handleSubmit">
            <Globe :size="16" />{{ submitting ? '导入中…' : '导入' }}
          </button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.dialog-header {
  padding: 0;
}

.dialog-title {
  font-size: 17px;
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
  margin: 0;
}

.dialog-desc {
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
  margin: 6px 0 0;
}

.dialog-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
}

.field-input {
  width: 100%;
  border: 1px solid var(--border-color, #dcdfe6);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: var(--font-size-sm);
  color: var(--foreground-primary);
  background: var(--background-primary, #fff);
  font-family: inherit;
}

.field-error {
  font-size: var(--font-size-sm);
  color: var(--el-color-danger, #f56c6c);
  background: var(--el-color-danger-light-9, #fef0f0);
  border-radius: 6px;
  padding: 8px 10px;
  line-height: 1.5;
}

.dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.footer-buttons {
  display: flex;
  gap: 8px;
}

.btn-cancel,
.btn-upload {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: 6px;
  font-size: var(--font-size-sm);
  cursor: pointer;
  border: 1px solid transparent;
}

.btn-cancel {
  background: transparent;
  border-color: var(--border-color, #dcdfe6);
  color: var(--foreground-secondary);
}

.btn-upload {
  background: var(--el-color-primary, #409eff);
  color: #fff;
}

.btn-upload:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.custom-config-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.config-section-title {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--foreground-primary);
}
</style>
