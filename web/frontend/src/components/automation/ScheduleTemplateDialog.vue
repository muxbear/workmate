<script setup lang="ts">
/**
 * 定时模板的新建 / 编辑弹窗。
 *
 * 模板是任务的完整预设，因此表单覆盖任务会用到的全部配置：
 * 名称、图标、类型、版本、描述、提示词、排期（复用 AutomationScheduleFields），
 * 以及模型 / 专家 / 技能 / 知识库 / 工作区 / 权限。
 *
 * 版本号：新建默认 1.0.0；编辑时默认取「次版本 +1」（1.2.3 → 1.3.0），
 * 并且**允许手工修改**——与专家版本的交互一致。保存时把值一并提交，
 * 服务端只在没传版本号时才自己兜底。
 */
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import AutomationScheduleFields from '@/components/automation/AutomationScheduleFields.vue'
import { fetchExperts } from '@/services/expertApi'
import { fetchKnowledgeBases } from '@/services/knowledgeBaseApi'
import { fetchProviders } from '@/services/modelApi'
import { fetchSkills } from '@/services/skillApi'
import { createTemplate, fetchTemplateTypes, updateTemplate } from '@/services/scheduleTemplateApi'
import { extractErrorMessage } from '@/services/request'
import { createDefaultSchedule } from '@/types/automation'
import { bumpMinorVersion, DEFAULT_VERSION, isValidVersion } from '@/utils/version'
import type { AutomationSchedule, ContextMode } from '@/types/automation'
import type {
  ScheduleTemplate,
  ScheduleTemplateDraft,
  TemplateTypeOption,
} from '@/types/scheduleTemplate'

const props = defineProps<{ template?: ScheduleTemplate | null }>()
const emit = defineEmits<{ close: []; saved: [] }>()

const isEditing = computed(() => Boolean(props.template))

interface TemplateForm {
  name: string
  description: string
  icon: string
  category: string
  version: string
  promptText: string
  schedule: AutomationSchedule
  providerId: string | null
  modelId: string | null
  expertId: string | null
  expertName: string | null
  contextMode: ContextMode
  skillIds: string[]
  kbIds: string[]
  workspaceId: string | null
  allowNetwork: boolean
  allowShell: boolean
  fullAccess: boolean
}

const form = reactive<TemplateForm>({
  name: '',
  description: '',
  icon: '⏰',
  category: '',
  version: DEFAULT_VERSION,
  promptText: '',
  schedule: createDefaultSchedule(),
  providerId: null,
  modelId: null,
  expertId: null,
  expertName: null,
  contextMode: 'default',
  skillIds: [],
  kbIds: [],
  workspaceId: null,
  allowNetwork: false,
  allowShell: false,
  fullAccess: false,
})

const saving = ref(false)
const types = ref<TemplateTypeOption[]>([])

const modelOptions = ref<{ label: string; providerId: string; modelId: string }[]>([])
const expertOptions = ref<{ label: string; id: string }[]>([])
const skillOptions = ref<{ label: string; id: string }[]>([])
const kbOptions = ref<{ label: string; id: string }[]>([])

/** 工作区没有独立接口：与「新建自动化」一致，用预设 + 自定义名字 */
const WORKSPACE_PRESETS = [
  { value: 'my-files', label: '我的文件（沙箱）' },
]

/**
 * 「单次」模板里的日期只是占位，真正建任务时会被替换成当天；
 * 这里照实回填，让编辑者能看出它是一条单次模板。
 */
function applyTemplate(template: ScheduleTemplate): void {
  form.name = template.name
  form.description = template.description
  form.icon = template.icon
  form.category = template.category
  // 编辑时默认给出「次版本 +1」的结果（仍可手工改），提交时以表单里的值为准
  form.version = bumpMinorVersion(template.version)
  form.promptText = template.promptText
  form.schedule = {
    ...createDefaultSchedule(),
    ...template.schedule,
    weekDays: [...template.schedule.weekDays],
    weekIntervalDays: [...template.schedule.weekIntervalDays],
  }
  form.providerId = template.providerId
  form.modelId = template.modelId
  form.expertId = template.expertId
  form.expertName = template.expertName
  form.contextMode = template.contextMode
  form.skillIds = [...template.skillIds]
  form.kbIds = [...template.kbIds]
  form.workspaceId = template.workspaceId
  form.allowNetwork = template.allowNetwork
  form.allowShell = template.allowShell
  form.fullAccess = template.fullAccess
}

/** 编辑时把版本号预填为「次版本 +1」，仍可手工改 */
function resetForCreate(): void {
  form.name = ''
  form.description = ''
  form.icon = '⏰'
  form.category = types.value[0]?.value ?? ''
  form.version = DEFAULT_VERSION
  form.promptText = ''
  form.schedule = createDefaultSchedule()
  form.providerId = null
  form.modelId = null
  form.expertId = null
  form.expertName = null
  form.contextMode = 'default'
  form.skillIds = []
  form.kbIds = []
  form.workspaceId = null
  form.allowNetwork = false
  form.allowShell = false
  form.fullAccess = false
}

watch(
  () => props.template,
  (template) => {
    if (template) {
      applyTemplate(template)
    } else {
      resetForCreate()
    }
  },
  { immediate: true },
)

async function loadOptions(): Promise<void> {
  try {
    types.value = await fetchTemplateTypes()
    if (!isEditing.value && !form.category) form.category = types.value[0]?.value ?? ''
  } catch {
    types.value = []
  }
  try {
    const providers = await fetchProviders()
    const list: { label: string; providerId: string; modelId: string }[] = []
    for (const provider of providers) {
      for (const model of provider.models ?? []) {
        if (model.type !== 'llm' && model.type !== 'multimodal') continue
        if (model.status === 'inactive' || model.status === 'deprecated') continue
        list.push({
          label: model.displayName || model.name,
          providerId: provider.id,
          modelId: model.id,
        })
      }
    }
    modelOptions.value = list
  } catch {
    modelOptions.value = []
  }
  try {
    const res = await fetchExperts({ page: 1, pageSize: 100 })
    expertOptions.value = res.items.map((expert) => ({ label: expert.name, id: expert.id }))
  } catch {
    expertOptions.value = []
  }
  try {
    const res = await fetchSkills({ page: 1, page_size: 100 })
    skillOptions.value = res.items.map((skill) => ({ label: skill.name, id: skill.id }))
  } catch {
    skillOptions.value = []
  }
  try {
    const list = await fetchKnowledgeBases({ page: 1, page_size: 100 })
    kbOptions.value = list.map((kb) => ({ label: kb.name, id: kb.id }))
  } catch {
    kbOptions.value = []
  }
}

void loadOptions()

/** 模型下拉的当前值：把 providerId + modelId 组合成一个可比较的键 */
const modelValue = computed({
  get: () => (form.providerId && form.modelId ? `${form.providerId}::${form.modelId}` : ''),
  set: (value: string) => {
    const hit = modelOptions.value.find(
      (item) => `${item.providerId}::${item.modelId}` === value,
    )
    form.providerId = hit?.providerId ?? null
    form.modelId = hit?.modelId ?? null
  },
})

function onExpertChange(id: string | null): void {
  form.expertName = expertOptions.value.find((item) => item.id === id)?.label ?? null
}

function buildDraft(): ScheduleTemplateDraft {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    icon: form.icon.trim() || '⏰',
    category: form.category,
    version: form.version.trim(),
    promptText: form.promptText.trim(),
    promptParts: form.promptText.trim()
      ? [{ type: 'text', text: form.promptText.trim() }]
      : [],
    schedule: form.schedule,
    model: null,
    customModelId: null,
    providerId: form.providerId,
    modelId: form.modelId,
    expertId: form.expertId,
    expertName: form.expertName,
    contextMode: form.contextMode,
    skillIds: form.skillIds,
    kbIds: form.kbIds,
    workspaceId: form.workspaceId,
    workspaceName: form.workspaceId,
    allowNetwork: form.allowNetwork,
    allowShell: form.allowShell,
    fullAccess: form.fullAccess,
  }
}

function validate(): string {
  if (!form.name.trim()) return '请填写模板名称'
  if (!form.promptText.trim()) return '请填写模板描述或提示词'
  if (!isValidVersion(form.version.trim())) {
    return '版本号需为「主版本.次版本.修订号」格式，如 1.0.0'
  }
  if (form.schedule.freqGroup === 'cycle' && form.schedule.cycleKind === 'once') {
    if (!form.schedule.onceDate) return '单次模板需要选择执行日期'
  }
  if (form.schedule.validityMode === 'range') {
    if (!form.schedule.validFrom || !form.schedule.validTo) return '指定时间段需要填写开始与结束日期'
  }
  return ''
}

async function handleSave(): Promise<void> {
  const problem = validate()
  if (problem) {
    ElMessage.warning(problem)
    return
  }
  saving.value = true
  try {
    const draft = buildDraft()
    if (props.template) {
      await updateTemplate(props.template.id, draft)
      ElMessage.success('模板已更新（版本 ' + draft.version + '）')
    } else {
      await createTemplate(draft)
      ElMessage.success('模板已创建')
    }
    emit('saved')
  } catch (err) {
    ElMessage.error(extractErrorMessage(err))
  } finally {
    saving.value = false
  }
}

/** 编辑时的版本提示：说清默认值从哪来、可以改 */
const versionHint = computed(() =>
  isEditing.value
    ? '每次编辑默认递增次版本（' + (props.template?.version ?? DEFAULT_VERSION) + ' → ' + bumpMinorVersion(props.template?.version) + '），可手工修改'
    : '新建模板默认从 1.0.0 开始',
)
</script>

<template>
  <el-dialog
    :model-value="true"
    :title="isEditing ? '编辑定时模板' : '新建定时模板'"
    width="760px"
    top="6vh"
    :close-on-click-modal="false"
    @close="emit('close')"
  >
    <el-form label-width="92px" label-position="left">
      <el-form-item label="名称" required>
        <el-input v-model="form.name" maxlength="100" placeholder="如：每日行业简报" />
      </el-form-item>

      <el-form-item label="图标">
        <el-input v-model="form.icon" maxlength="8" style="width: 96px" />
        <span class="tpl-hint">支持 emoji，如 ⏰ 📰</span>
      </el-form-item>

      <el-form-item label="类型">
        <el-select v-model="form.category" placeholder="选择类型" style="width: 220px">
          <el-option
            v-for="item in types"
            :key="item.value"
            :label="item.label"
            :value="item.value"
          />
        </el-select>
        <span v-if="types.length === 0" class="tpl-hint tpl-hint--warn">
          类型来自「参数配置 → 定时任务模板类型」，尚未配置
        </span>
      </el-form-item>

      <el-form-item label="版本">
        <el-input v-model="form.version" style="width: 160px" placeholder="1.0.0" />
        <span class="tpl-hint">{{ versionHint }}</span>
      </el-form-item>

      <el-form-item label="描述">
        <el-input
          v-model="form.description"
          type="textarea"
          :rows="2"
          maxlength="2000"
          placeholder="卡片上展示的一句话说明"
        />
      </el-form-item>

      <el-form-item label="提示词" required>
        <el-input
          v-model="form.promptText"
          type="textarea"
          :rows="4"
          maxlength="20000"
          placeholder="由模板生成任务时，这段文字会成为任务的提示词"
        />
      </el-form-item>

      <AutomationScheduleFields :schedule="form.schedule" />

      <el-divider content-position="left">任务配置</el-divider>

      <el-form-item label="模型">
        <el-select v-model="modelValue" clearable filterable placeholder="默认模型" style="width: 260px">
          <el-option
            v-for="item in modelOptions"
            :key="`${item.providerId}::${item.modelId}`"
            :label="item.label"
            :value="`${item.providerId}::${item.modelId}`"
          />
        </el-select>
      </el-form-item>

      <el-form-item label="专家">
        <el-select
          v-model="form.expertId"
          clearable
          filterable
          placeholder="不指定"
          style="width: 260px"
          @change="onExpertChange"
        >
          <el-option
            v-for="item in expertOptions"
            :key="item.id"
            :label="item.label"
            :value="item.id"
          />
        </el-select>
      </el-form-item>

      <el-form-item label="技能">
        <el-select v-model="form.skillIds" multiple filterable placeholder="不指定" style="width: 100%">
          <el-option
            v-for="item in skillOptions"
            :key="item.id"
            :label="item.label"
            :value="item.id"
          />
        </el-select>
      </el-form-item>

      <el-form-item label="知识库">
        <el-select v-model="form.kbIds" multiple filterable placeholder="不指定" style="width: 100%">
          <el-option v-for="item in kbOptions" :key="item.id" :label="item.label" :value="item.id" />
        </el-select>
      </el-form-item>

      <el-form-item label="上下文">
        <el-select v-model="form.contextMode" style="width: 200px">
          <el-option label="默认" value="default" />
          <el-option label="引用上传文件" value="files" />
          <el-option label="引用知识库" value="knowledge" />
        </el-select>
      </el-form-item>

      <el-form-item label="工作区">
        <el-select
          v-model="form.workspaceId"
          clearable
          filterable
          allow-create
          default-first-option
          placeholder="默认工作区"
          style="width: 260px"
        >
          <el-option
            v-for="item in WORKSPACE_PRESETS"
            :key="item.value"
            :label="item.label"
            :value="item.value"
          />
        </el-select>
      </el-form-item>

      <el-form-item label="权限">
        <el-checkbox v-model="form.allowNetwork">允许联网</el-checkbox>
        <el-checkbox v-model="form.allowShell">允许执行命令</el-checkbox>
        <el-checkbox v-model="form.fullAccess">完全访问</el-checkbox>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="emit('close')">取消</el-button>
      <el-button type="primary" :loading="saving" @click="handleSave">
        {{ isEditing ? '保存' : '创建' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped lang="scss">
@use '@/assets/styles/automationForm.scss';

.tpl-hint {
  margin-left: 10px;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
}

.tpl-hint--warn {
  color: var(--color-warning, #f59e0b);
}
</style>
