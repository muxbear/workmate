<script setup lang="ts">
/**
 * 编辑知识库：名称 / 描述 / 标签 / 分组。
 *
 * 卡片菜单里原先散着「重命名」与「归入分组」两项——改完名字往往还想顺手换个分组，
 * 而归组此前是"点一下就提交"的单选列表，两个都不是完整的"编辑这个库"。这里并成
 * 一个表单：**名称与分组会分别落到两个接口**（PATCH 改字段、PUT 改归属），只要
 * 没改动就不发那次请求。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBase'
import { readApiError } from '@/services/knowledgeBaseApi'
import type { KB } from '@/types/knowledgeBase'

const props = defineProps<{
  visible: boolean
  kb: KB | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'saved'): void
}>()

const store = useKnowledgeBaseStore()
const { t } = useI18n()

const name = ref('')
const description = ref('')
const tagsInput = ref('')
const groupId = ref<string | null>(null)
const saving = ref(false)

// 每次打开都按当前值回填：弹窗是"改这个库"，上一次的输入不该留到下一次。
// immediate：调用方若把弹窗挂成 v-if="open"（挂载时就是打开态），也要回填得上
watch(() => props.visible, (v) => {
  if (!v || !props.kb) return
  name.value = props.kb.name
  description.value = props.kb.description
  tagsInput.value = props.kb.tags.join(', ')
  groupId.value = props.kb.groupId ?? null
}, { immediate: true })

const groupChanged = computed(() => groupId.value !== (props.kb?.groupId ?? null))

async function handleSave() {
  const kb = props.kb
  if (!kb) return
  const trimmed = name.value.trim()
  if (!trimmed) {
    ElMessage.warning(t('knowledge.card.nameRequired'))
    return
  }
  saving.value = true
  try {
    await store.updateKb(kb.id, {
      name: trimmed,
      description: description.value.trim(),
      tags: tagsInput.value
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    })
    if (groupChanged.value) await store.assignGroup(kb.id, groupId.value)
    ElMessage.success(t('knowledge.card.editedToast'))
    emit('saved')
    emit('close')
  } catch (err: unknown) {
    ElMessage.error(readApiError(err))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    :title="t('knowledge.card.editTitle')"
    width="480px"
    append-to-body
    @update:model-value="(v: boolean) => !v && emit('close')"
  >
    <div class="edit-body">
      <div class="field">
        <label class="field-label">{{ t('knowledge.card.fieldName') }}</label>
        <input v-model="name" type="text" class="field-input" maxlength="128" />
      </div>

      <div class="field">
        <label class="field-label">{{ t('knowledge.card.fieldDesc') }}</label>
        <textarea v-model="description" class="field-textarea" rows="2" maxlength="200" />
      </div>

      <div class="field">
        <label class="field-label">{{ t('knowledge.card.fieldTags') }}</label>
        <input
          v-model="tagsInput"
          type="text"
          class="field-input"
          :placeholder="t('knowledge.card.tagsPlaceholder')"
          maxlength="100"
        />
      </div>

      <div class="field">
        <label class="field-label">{{ t('knowledge.card.fieldGroup') }}</label>
        <div class="group-picker">
          <button
            type="button"
            class="group-pick-item"
            :class="{ 'is-current': groupId === null }"
            @click="groupId = null"
          >
            {{ t('knowledge.card.noGroup') }}
            <span v-if="groupId === null" class="group-pick-current">{{ t('knowledge.card.current') }}</span>
          </button>
          <button
            v-for="g in store.kbGroups"
            :key="g.id"
            type="button"
            class="group-pick-item"
            :class="{ 'is-current': groupId === g.id }"
            @click="groupId = g.id"
          >
            {{ g.name }}
            <span v-if="groupId === g.id" class="group-pick-current">{{ t('knowledge.card.current') }}</span>
          </button>
          <div v-if="store.kbGroups.length === 0" class="group-pick-empty">
            {{ t('knowledge.card.noGroupsYet') }}
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="dialog-footer">
        <el-button @click="emit('close')">{{ t('knowledge.common.cancel') }}</el-button>
        <el-button type="primary" :loading="saving" @click="handleSave">{{ t('knowledge.card.save') }}</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.edit-body {
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
  font-size: var(--font-size-xs);
  color: var(--foreground-primary);
  opacity: 0.85;
}

.field-input {
  height: 36px;
  padding: 0 12px;
  background: var(--color-bg-input);
  border: 1px solid var(--border-medium);
  border-radius: 10px;
  color: var(--foreground-primary);
  font-size: var(--font-size-base);
  font-family: inherit;
  outline: none;
  transition: border-color 0.2s;
}

.field-input:focus {
  border-color: var(--color-accent);
}

.field-textarea {
  padding: 10px 12px;
  background: var(--color-bg-input);
  border: 1px solid var(--border-medium);
  border-radius: 10px;
  color: var(--foreground-primary);
  font-size: var(--font-size-base);
  font-family: inherit;
  outline: none;
  resize: vertical;
  transition: border-color 0.2s;
}

.field-textarea:focus {
  border-color: var(--color-accent);
}

.group-picker {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.group-pick-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 10px;
  border: 1px solid var(--border-subtle, #e5e7eb);
  border-radius: 6px;
  background: transparent;
  color: var(--foreground-primary);
  font-size: var(--font-size-sm);
  font-family: inherit;
  cursor: pointer;
  text-align: left;
}

.group-pick-item:hover {
  border-color: var(--border-medium);
}

.group-pick-item.is-current {
  border-color: rgba(59, 130, 246, 0.4);
  background: rgba(59, 130, 246, 0.08);
}

.group-pick-current {
  font-size: var(--font-size-xs, 12px);
  color: var(--el-color-primary, #409eff);
}

.group-pick-empty {
  padding: 8px 0;
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
