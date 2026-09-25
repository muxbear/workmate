<script setup lang="ts">
import { ref, watch, computed, reactive } from 'vue'
import { ClipboardPaste } from 'lucide-vue-next'
import type { IndexConfig } from '@/types/knowledgeBase'
import KbIndexConfigForm from './KbIndexConfigForm.vue'

const props = defineProps<{
  visible: boolean
  defaultConfig: IndexConfig
}>()

const emit = defineEmits<{
  close: []
  submit: [name: string, content: string, config?: IndexConfig]
}>()

//: 与后端 `KB_MAX_PASTE_KB`（core/config.py，默认 1MB）保持一致；后端才是权威，
//: 这里只是为了"超限时就把提交按钮禁掉"，别让用户白填一遍再被拒
const MAX_PASTE_KB = 1024

const dialogVisible = ref(false)
const name = ref('')
const content = ref('')
const indexMode = ref<'kb' | 'custom'>('kb')
// eslint-disable-next-line prefer-const -- v-model 需要可重新赋值（与 KbUploadDialog 同）
let customConfig = reactive<IndexConfig>({ ...props.defaultConfig })

/** 按 UTF-8 字节计——后端判的就是字节，不是字符数 */
const byteLength = computed(() => new TextEncoder().encode(content.value).length)
const overLimit = computed(() => byteLength.value > MAX_PASTE_KB * 1024)
const canSubmit = computed(() => content.value.trim().length > 0 && !overLimit.value)
const dialogWidth = computed(() => (indexMode.value === 'custom' ? '760px' : '560px'))

const byteLabel = computed(() => {
  const kb = byteLength.value / 1024
  return kb < 1 ? `${byteLength.value} B` : `${kb.toFixed(1)} KB / ${MAX_PASTE_KB} KB`
})

watch(() => props.visible, (v) => {
  dialogVisible.value = v
  if (v) reset()
})

watch(indexMode, (mode) => {
  if (mode === 'custom') Object.assign(customConfig, props.defaultConfig)
})

function reset() {
  name.value = ''
  content.value = ''
  indexMode.value = 'kb'
  Object.assign(customConfig, props.defaultConfig)
}

function handleClose() {
  dialogVisible.value = false
  emit('close')
}

function handleSubmit() {
  if (!canSubmit.value) return
  emit(
    'submit',
    name.value.trim(),
    content.value,
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
    class="paste-doc-dialog"
    destroy-on-close
  >
    <template #header>
      <div class="dialog-header">
        <h2 class="dialog-title">粘贴文本</h2>
        <p class="dialog-desc">内容会存成一篇 Markdown 文档，并走与上传相同的索引流程</p>
      </div>
    </template>

    <div class="dialog-body">
      <div class="field">
        <label class="field-label">文档名称<span class="field-hint">（留空自动按时间命名）</span></label>
        <input
          v-model="name"
          type="text"
          class="field-input"
          maxlength="200"
          placeholder="例如：会议纪要"
        />
      </div>

      <div class="field">
        <label class="field-label">内容</label>
        <textarea
          v-model="content"
          class="field-textarea"
          rows="12"
          placeholder="把要入库的文本粘到这里…"
        />
        <div class="field-meter" :class="{ 'is-over': overLimit }">
          <span>{{ byteLabel }}</span>
          <span v-if="overLimit">超出上限，请拆分后再提交</span>
        </div>
      </div>

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
            <ClipboardPaste :size="16" />创建文档
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
  gap: 16px;
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

.field-hint {
  color: var(--foreground-tertiary, var(--foreground-secondary));
}

.field-input,
.field-textarea {
  width: 100%;
  border: 1px solid var(--border-color, #dcdfe6);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: var(--font-size-sm);
  color: var(--foreground-primary);
  background: var(--background-primary, #fff);
  font-family: inherit;
  resize: vertical;
}

.field-textarea {
  line-height: 1.6;
}

.field-meter {
  display: flex;
  justify-content: space-between;
  font-size: var(--font-size-xs, 12px);
  color: var(--foreground-secondary);
}

.field-meter.is-over {
  color: var(--el-color-danger, #f56c6c);
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
