<script setup lang="ts">
import { ref, watch, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Plus, X, Wrench, Zap, Network } from 'lucide-vue-next'
import type {
  Expert,
  ExpertUpdateRequest,
  ExpertProfileUpdateRequest,
  ExpertConfigUpdateRequest,
} from '@/types/expert'
import { EXPERT_CATEGORY_LABELS, EXPERT_COLORS } from '@/types/expert'
import type { Tool } from '@/types/tool'
import type { Skill } from '@/types/skill'
import { getSkillIcon } from '@/components/skill/iconMap'
import { DEFAULT_VERSION, bumpPatchVersion, isValidVersion } from '@/utils/version'
import { useModelStore } from '@/stores/model'
import { useMcpStore } from '@/stores/mcp'
import ToolSelectDialog from '@/components/common/ToolSelectDialog.vue'
import SkillSelectDialog from '@/components/common/SkillSelectDialog.vue'

const props = defineProps<{
  visible: boolean
  expert: Expert | null
  mode: 'create' | 'edit'
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (
    e: 'save',
    data: {
      basic: ExpertUpdateRequest
      profile: ExpertProfileUpdateRequest
      config: ExpertConfigUpdateRequest
    },
  ): void
}>()

const activeTab = ref<'basic' | 'model' | 'tools' | 'skills' | 'mcp'>('basic')

/* ---- 外部 Store ---- */
const modelStore = useModelStore()
const mcpStore = useMcpStore()

/* ---- 表单状态 ---- */
const formName = ref('')
const formTitle = ref('')
const formCategory = ref('custom')
const formTags = ref<string[]>([])
const formTagInput = ref('')
const formIcon = ref('')
const formColor = ref(EXPERT_COLORS[0])
const formInitials = ref('')
const formDescription = ref('')
const formFeatured = ref(false)
const formScene = ref('')
const formSortOrder = ref(0)
const formIsPublished = ref(true)

const formProviderId = ref('')
const formModelId = ref('')
const formSystemPrompt = ref('')
const formVersion = ref(DEFAULT_VERSION)

/**
 * 已配置工具/技能的行模型。
 *
 * 两种数据源形状不同：`/api/experts/:id` 返回 snake_case 的 ToolBrief /
 * ExpertSkillBrief，而选择弹窗里的 Tool / Skill 类型字段又各有出入，因此这里
 * 统一收敛成只含展示所需字段的本地模型。
 */
interface ExpertToolRow {
  id: string
  name: string
  displayName: string
  category: string
}

interface ExpertSkillRow {
  id: string
  name: string
  description: string
  category: string
  icon: string
}

const formTools = ref<ExpertToolRow[]>([])
const formSkills = ref<ExpertSkillRow[]>([])

/* ---- 工具 / 技能选择弹窗 ---- */
const toolSelectVisible = ref(false)
const skillSelectVisible = ref(false)

interface McpConfigRow {
  mcpToolId: string
  mcpToolName: string
  config: Record<string, unknown>
  enabled: boolean
}
const formMcpConfigs = ref<McpConfigRow[]>([])

/* ---- 可选数据 ---- */
const categoryOptions = Object.entries(EXPERT_CATEGORY_LABELS).map(([key, label]) => ({
  key,
  label,
}))

const sceneOptions = [
  { key: '', label: '无' },
  { key: 'content', label: '内容创作' },
  { key: 'invest', label: '投资分析' },
  { key: 'legal', label: '法律财税' },
  { key: 'sme', label: '小微企业' },
]

/* ---- 提供商 & 模型（来自模型菜单配置）---- */
const providers = computed(() => modelStore.providers)

const selectedProvider = computed(
  () => providers.value.find((p) => p.id === formProviderId.value) ?? null,
)

/** 当前提供商下的模型列表 */
const availableModels = computed(() => {
  if (!selectedProvider.value) return []
  const chatTypes = ['llm', 'vision', 'multimodal']
  return selectedProvider.value.models.filter(
    (m) => (m.status === 'active' || m.status === 'beta') && chatTypes.includes(m.type),
  )
})

/** 提供商切换时清空模型选择 */
watch(formProviderId, () => {
  formModelId.value = ''
})

/* ---- MCP 工具列表（来自 MCP 菜单配置）---- */
const mcpTools = computed(() => mcpStore.tools)

/* ---- watch expert ---- */
watch(
  () => props.expert,
  (expert) => {
    if (expert) {
      formName.value = expert.name
      formTitle.value = expert.title
      formCategory.value = expert.category
      formTags.value = [...expert.tags]
      formIcon.value = expert.icon
      formColor.value = expert.color || EXPERT_COLORS[0]
      formInitials.value = expert.initials
      formDescription.value = expert.description
      formFeatured.value = expert.featured
      formScene.value = expert.scene || ''
      formSortOrder.value = expert.sortOrder
      formIsPublished.value = expert.isPublished
      formProviderId.value = expert.providerId || ''
      formModelId.value = expert.modelId || ''
      formSystemPrompt.value = expert.systemPrompt
      // 编辑时版本号默认递增一个修订号，用户仍可在「基本信息」里手工修改
      formVersion.value = bumpPatchVersion(expert.version)
      formTools.value = expert.tools.map((t) => ({
        id: t.id,
        name: t.name,
        displayName: t.displayName || t.name,
        category: t.category,
      }))
      formSkills.value = expert.skills.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        category: s.category,
        icon: s.icon,
      }))
      formMcpConfigs.value = expert.mcpConfigs.map((c) => ({
        mcpToolId: c.mcpToolId,
        mcpToolName: c.mcpToolName,
        config: { ...c.config },
        enabled: c.enabled,
      }))
    } else {
      formName.value = ''
      formTitle.value = ''
      formCategory.value = 'custom'
      formTags.value = []
      formTagInput.value = ''
      formIcon.value = ''
      formColor.value = EXPERT_COLORS[0]
      formInitials.value = ''
      formDescription.value = ''
      formFeatured.value = false
      formScene.value = ''
      formSortOrder.value = 0
      formIsPublished.value = true
      formProviderId.value = ''
      formModelId.value = ''
      formSystemPrompt.value = ''
      formVersion.value = DEFAULT_VERSION
      formTools.value = []
      formSkills.value = []
      formMcpConfigs.value = []
    }
    toolSelectVisible.value = false
    skillSelectVisible.value = false
    activeTab.value = 'basic'
  },
  { immediate: true },
)

/* ---- tag management ---- */
function addTag() {
  const val = formTagInput.value.trim()
  if (val && !formTags.value.includes(val)) {
    formTags.value.push(val)
  }
  formTagInput.value = ''
}

function removeTag(tag: string) {
  formTags.value = formTags.value.filter((t) => t !== tag)
}

/* ---- 工具管理（后端按 Tool.name 关联，去重也用 name）---- */
function handleToolsAdded(tools: Tool[]) {
  for (const tool of tools) {
    if (formTools.value.some((t) => t.name === tool.name)) continue
    formTools.value.push({
      id: tool.id,
      name: tool.name,
      displayName: tool.displayName || tool.name,
      category: tool.category,
    })
  }
  toolSelectVisible.value = false
}

function removeTool(name: string) {
  formTools.value = formTools.value.filter((t) => t.name !== name)
}

/* ---- 技能管理（后端按 skill_id 关联，去重也用 id）---- */
function handleSkillsAdded(skills: Skill[]) {
  for (const skill of skills) {
    if (formSkills.value.some((s) => s.id === skill.id)) continue
    formSkills.value.push({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      category: skill.category,
      icon: skill.icon,
    })
  }
  skillSelectVisible.value = false
}

function removeSkill(id: string) {
  formSkills.value = formSkills.value.filter((s) => s.id !== id)
}

/* ---- mcp config management ---- */
function addMcpConfig() {
  formMcpConfigs.value.push({
    mcpToolId: '',
    mcpToolName: '',
    config: { transport: 'stdio', url: '', command: 'npx', args: [], env: {} },
    enabled: true,
  })
}

function removeMcpConfig(idx: number) {
  formMcpConfigs.value.splice(idx, 1)
}

/** 就地更新某条 MCP 配置的字段（config 是弱类型的运行时参数对象） */
function patchMcpConfig(cfg: McpConfigRow, patch: Record<string, unknown>) {
  Object.assign(cfg.config, patch)
}

function onMcpToolSelect(idx: number, mcpToolId: string) {
  const mcp = mcpTools.value.find((m) => m.id === mcpToolId)
  if (!mcp) return
  const transport = mcp.transport || 'stdio'
  const url =
    transport === 'sse'
      ? mcp.sse_url || mcp.url
      : transport === 'streamable_http'
        ? mcp.streamable_http_url || mcp.url
        : mcp.url || ''
  formMcpConfigs.value[idx].mcpToolName = mcp.name
  formMcpConfigs.value[idx].config = {
    transport,
    url,
    command: mcp.command || '',
    args: Array.isArray(mcp.args) ? [...mcp.args] : [],
    env: { ...(mcp.env || {}) },
  }
}

/* ---- save ---- */
function handleSave() {
  if (!formName.value.trim()) {
    ElMessage.warning('请输入专家名称')
    activeTab.value = 'basic'
    return
  }
  if (!formTitle.value.trim()) {
    ElMessage.warning('请输入专家头衔')
    activeTab.value = 'basic'
    return
  }
  if (!isValidVersion(formVersion.value)) {
    ElMessage.warning('版本号需为「主版本.次版本.修订号」格式，如 1.0.0')
    activeTab.value = 'basic'
    return
  }

  const basic: ExpertUpdateRequest = {
    name: formName.value,
    title: formTitle.value,
    description: formDescription.value,
    systemPrompt: formSystemPrompt.value,
    providerId: formProviderId.value || undefined,
    modelId: formModelId.value || undefined,
    version: formVersion.value,
  }

  const profile: ExpertProfileUpdateRequest = {
    title: formTitle.value,
    category: formCategory.value,
    tags: formTags.value,
    icon: formIcon.value,
    color: formColor.value,
    initials: formInitials.value,
    featured: formFeatured.value,
    scene: formScene.value || undefined,
    sortOrder: formSortOrder.value,
    isPublished: formIsPublished.value,
  }

  const config: ExpertConfigUpdateRequest = {
    systemPrompt: formSystemPrompt.value,
    providerId: formProviderId.value || undefined,
    modelId: formModelId.value || undefined,
    toolNames: formTools.value.map((t) => t.name),
    skillIds: formSkills.value.map((s) => s.id),
    mcpConfigs: formMcpConfigs.value.map((c) => ({
      mcpToolId: c.mcpToolId,
      config: c.config,
      enabled: c.enabled,
    })),
  }

  emit('save', { basic, profile, config })
}

const isEditing = computed(() => props.mode === 'edit')
const dialogTitle = computed(() =>
  isEditing.value ? `编辑专家 — ${props.expert?.name || ''}` : '新建专家',
)

/* ---- 加载外部数据 ---- */
onMounted(() => {
  if (modelStore.providers.length === 0) {
    modelStore.fetchAll()
  }
  if (mcpStore.tools.length === 0) {
    mcpStore.fetchTools()
  }
})
</script>

<template>
  <el-dialog
    :model-value="visible"
    :title="dialogTitle"
    width="min(720px, 92vw)"
    class="expert-edit-dialog"
    :close-on-click-modal="false"
    @close="emit('close')"
  >
    <div class="dialog-body">
      <el-tabs v-model="activeTab" class="edit-tabs">
        <!-- 基本信息 -->
        <el-tab-pane label="基本信息" name="basic">
          <el-form label-width="90px" label-position="right">
            <el-form-item label="名称">
              <el-input v-model="formName" placeholder="专家名称" maxlength="128" />
            </el-form-item>
            <el-form-item label="头衔">
              <el-input v-model="formTitle" placeholder="如：内容创作专家" maxlength="128" />
            </el-form-item>
            <el-form-item label="版本号">
              <el-input
                v-model="formVersion"
                placeholder="如：1.0.0"
                maxlength="32"
                style="width: 160px"
              />
              <span class="form-hint">{{
                isEditing ? '每次编辑默认递增修订号，可手工修改' : '新建专家默认从 1.0.0 开始'
              }}</span>
            </el-form-item>
            <el-form-item label="分类">
              <el-select v-model="formCategory" placeholder="选择分类" style="width: 100%">
                <el-option
                  v-for="cat in categoryOptions"
                  :key="cat.key"
                  :label="cat.label"
                  :value="cat.key"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="标签">
              <div class="tag-editor">
                <el-tag
                  v-for="tag in formTags"
                  :key="tag"
                  closable
                  size="small"
                  @close="removeTag(tag)"
                >
                  {{ tag }}
                </el-tag>
                <el-input
                  v-model="formTagInput"
                  size="small"
                  style="width: 120px"
                  placeholder="输入标签"
                  @keyup.enter="addTag"
                />
                <el-button size="small" text @click="addTag">
                  <Plus :size="14" />
                </el-button>
              </div>
            </el-form-item>
            <el-form-item label="头像颜色">
              <div class="color-picker">
                <div
                  v-for="(color, idx) in EXPERT_COLORS"
                  :key="idx"
                  class="color-swatch"
                  :class="{ 'color-swatch--active': formColor === color }"
                  :style="{ background: color }"
                  @click="formColor = color"
                />
              </div>
            </el-form-item>
            <el-form-item label="头像文字">
              <el-input
                v-model="formInitials"
                placeholder="如：林"
                maxlength="8"
                style="width: 80px"
              />
            </el-form-item>
            <el-form-item label="描述">
              <el-input
                v-model="formDescription"
                type="textarea"
                :rows="3"
                placeholder="专家描述"
              />
            </el-form-item>
            <el-form-item label="精选">
              <el-switch v-model="formFeatured" />
            </el-form-item>
            <el-form-item v-if="formFeatured" label="精选场景">
              <el-select v-model="formScene" placeholder="选择场景" style="width: 100%">
                <el-option
                  v-for="scene in sceneOptions"
                  :key="scene.key"
                  :label="scene.label"
                  :value="scene.key"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="排序">
              <el-input-number v-model="formSortOrder" :min="0" :max="9999" />
            </el-form-item>
            <el-form-item label="发布状态">
              <el-switch v-model="formIsPublished" />
              <span class="form-hint">未发布的专家不会出现在同步列表中</span>
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <!-- 模型与提示词 -->
        <el-tab-pane label="模型与提示词" name="model">
          <el-form label-width="90px" label-position="right">
            <el-form-item label="提供商">
              <el-select
                v-model="formProviderId"
                placeholder="选择提供商"
                clearable
                style="width: 100%"
                :loading="modelStore.loading"
              >
                <el-option v-for="p in providers" :key="p.id" :label="p.name" :value="p.id">
                  <span>{{ p.logo }} {{ p.name }}</span>
                  <el-tag
                    v-if="p.status !== 'connected'"
                    size="small"
                    type="info"
                    style="margin-left: 8px"
                  >
                    {{ p.status === 'unconfigured' ? '未配置' : '连接异常' }}
                  </el-tag>
                </el-option>
              </el-select>
            </el-form-item>
            <el-form-item label="模型">
              <el-select
                v-model="formModelId"
                :placeholder="formProviderId ? '选择模型' : '请先选择提供商'"
                :disabled="!formProviderId"
                clearable
                style="width: 100%"
              >
                <el-option
                  v-for="m in availableModels"
                  :key="m.id"
                  :label="m.displayName"
                  :value="m.id"
                >
                  <span>{{ m.displayName }}</span>
                  <el-tag size="small" type="info" style="margin-left: 8px">
                    {{ m.type }}
                  </el-tag>
                </el-option>
              </el-select>
            </el-form-item>
            <el-form-item label="系统提示词">
              <el-input
                v-model="formSystemPrompt"
                type="textarea"
                :rows="10"
                placeholder="输入系统提示词（System Prompt）"
              />
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <!-- 工具：仅展示已配置项，通过「添加工具」弹窗从工具库中检索、翻页、多选添加 -->
        <el-tab-pane label="工具" name="tools">
          <div class="tool-section">
            <div class="section-head">
              <div class="tool-section-title">
                <Wrench :size="14" />
                已配置工具
                <span class="section-count">{{ formTools.length }}</span>
              </div>
              <el-button size="small" plain @click="toolSelectVisible = true">
                <Plus :size="14" style="margin-right: 4px" />
                添加工具
              </el-button>
            </div>

            <div v-if="formTools.length === 0" class="tool-empty">
              尚未添加工具，点击右上角「添加工具」从工具库中选择
            </div>
            <div v-else class="tool-list">
              <div v-for="tool in formTools" :key="tool.name" class="tool-item">
                <span class="tool-name">{{ tool.displayName }}</span>
                <span class="tool-id">{{ tool.name }}</span>
                <el-tooltip content="移除" placement="top">
                  <el-button text size="small" @click="removeTool(tool.name)">
                    <X :size="14" />
                  </el-button>
                </el-tooltip>
              </div>
            </div>
          </div>
        </el-tab-pane>

        <!-- 技能：仅展示已配置项，通过「添加技能」弹窗从技能库中检索、翻页、多选添加 -->
        <el-tab-pane label="技能" name="skills">
          <div class="skill-section">
            <div class="section-head">
              <div class="tool-section-title">
                <Zap :size="14" />
                已配置技能
                <span class="section-count">{{ formSkills.length }}</span>
              </div>
              <el-button size="small" plain @click="skillSelectVisible = true">
                <Plus :size="14" style="margin-right: 4px" />
                添加技能
              </el-button>
            </div>

            <div v-if="formSkills.length === 0" class="skill-empty">
              尚未添加技能，点击右上角「添加技能」从技能库中选择
            </div>
            <div v-else class="skill-list">
              <div v-for="skill in formSkills" :key="skill.id" class="skill-item">
                <component :is="getSkillIcon(skill.icon)" :size="14" class="skill-item-icon" />
                <span class="skill-item-name">{{ skill.name }}</span>
                <span class="skill-item-desc">{{ skill.description || '暂无描述' }}</span>
                <el-tooltip content="移除" placement="top">
                  <el-button text size="small" @click="removeSkill(skill.id)">
                    <X :size="14" />
                  </el-button>
                </el-tooltip>
              </div>
            </div>
          </div>
        </el-tab-pane>

        <!-- MCP -->
        <el-tab-pane label="MCP" name="mcp">
          <div class="mcp-section">
            <div class="mcp-list">
              <div v-for="(cfg, idx) in formMcpConfigs" :key="idx" class="mcp-card">
                <div class="mcp-card-head">
                  <el-select
                    v-model="cfg.mcpToolId"
                    placeholder="选择 MCP 工具"
                    size="small"
                    style="width: 200px"
                    filterable
                    @change="(val: string) => onMcpToolSelect(idx, val)"
                  >
                    <el-option
                      v-for="mcp in mcpTools"
                      :key="mcp.id"
                      :label="mcp.name"
                      :value="mcp.id"
                    />
                  </el-select>
                  <el-switch v-model="cfg.enabled" size="small" />
                  <el-button text size="small" @click="removeMcpConfig(idx)">
                    <X :size="14" />
                  </el-button>
                </div>
                <div class="mcp-card-body">
                  <el-select
                    :model-value="(cfg.config as Record<string, string>).transport || 'stdio'"
                    size="small"
                    style="width: 100%"
                    @update:model-value="(val: string) => patchMcpConfig(cfg, { transport: val })"
                  >
                    <template #prepend>transport</template>
                    <el-option label="stdio" value="stdio" />
                    <el-option label="sse" value="sse" />
                    <el-option label="streamable_http" value="streamable_http" />
                  </el-select>
                  <el-input
                    v-if="(cfg.config as Record<string, string>).transport !== 'stdio'"
                    v-model="(cfg.config as Record<string, string>).url"
                    size="small"
                    placeholder="url"
                  >
                    <template #prepend>url</template>
                  </el-input>
                  <template v-else>
                    <el-input
                      v-model="(cfg.config as Record<string, string>).command"
                      size="small"
                      placeholder="command (如 npx)"
                    >
                      <template #prepend>command</template>
                    </el-input>
                    <el-input
                      :model-value="
                        Array.isArray(cfg.config.args)
                          ? (cfg.config.args as string[]).join(' ')
                          : ''
                      "
                      size="small"
                      placeholder="args (空格分隔)"
                      @update:model-value="
                        (val: string) => patchMcpConfig(cfg, { args: val.split(' ').filter(Boolean) })
                      "
                    >
                      <template #prepend>args</template>
                    </el-input>
                  </template>
                </div>
              </div>
            </div>
            <el-button size="small" plain @click="addMcpConfig">
              <Plus :size="14" style="margin-right: 4px" />
              添加 MCP 配置
            </el-button>
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>
    <template #footer>
      <div class="dialog-actions">
        <el-button @click="emit('close')">取消</el-button>
        <el-button type="primary" @click="handleSave">保存</el-button>
      </div>
    </template>
  </el-dialog>

  <!-- 工具 / 技能选择弹窗（多选，数据来自「工具」「技能」菜单页配置） -->
  <ToolSelectDialog
    :visible="toolSelectVisible"
    :agent-name="formName || '该专家'"
    :existing-tool-names="formTools.map((t) => t.name)"
    multiple
    @close="toolSelectVisible = false"
    @add-batch="handleToolsAdded"
  />
  <SkillSelectDialog
    :visible="skillSelectVisible"
    :agent-name="formName || '该专家'"
    :existing-skill-ids="formSkills.map((s) => s.id)"
    multiple
    @close="skillSelectVisible = false"
    @add-batch="handleSkillsAdded"
  />
</template>

<style scoped>
.dialog-body {
  max-height: min(60vh, 560px);
  overflow-y: auto;
  padding-right: 4px;
  scrollbar-width: thin;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.edit-tabs {
  --el-tabs-header-height: 40px;
}

.edit-tabs :deep(.el-tabs__content) {
  padding: 0 4px;
}

.tag-editor {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.color-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.color-swatch {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  cursor: pointer;
  border: 2px solid transparent;
  transition: border-color var(--transition-fast);
}

.color-swatch--active {
  border-color: var(--color-text-primary);
}

.form-hint {
  margin-left: 12px;
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

/* tool section */
.tool-section {
  margin-bottom: 20px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.tool-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
}

.section-count {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-normal);
  color: var(--foreground-muted);
  padding: 0 6px;
  border-radius: var(--radius-full);
  background: var(--surface-secondary);
}

.tool-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tool-loading,
.tool-empty {
  color: var(--foreground-muted);
  font-size: var(--font-size-sm);
  padding: 16px 0;
  text-align: center;
}

.tool-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
}

.tool-name {
  font-size: var(--font-size-sm);
  color: var(--foreground-primary);
}

.tool-id {
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
  margin-left: auto;
}

/* skill section */
.skill-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.skill-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.skill-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
}

.skill-item-icon {
  color: var(--color-tool-purple, #a78bfa);
  flex-shrink: 0;
}

.skill-item-name {
  font-size: var(--font-size-sm);
  color: var(--foreground-primary);
  flex-shrink: 0;
}

.skill-item-desc {
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 320px;
}

.skill-empty {
  color: var(--foreground-muted);
  font-size: var(--font-size-sm);
  padding: 24px 0;
  text-align: center;
}

/* mcp section */
.mcp-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mcp-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mcp-card {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mcp-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
}

.mcp-card-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
