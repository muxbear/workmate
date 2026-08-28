<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { Plus, X, Wrench, Zap, Network, Star } from 'lucide-vue-next'
import type {
  Expert,
  ExpertUpdateRequest,
  ExpertProfileUpdateRequest,
  ExpertConfigUpdateRequest,
} from '@/types/expert'
import {
  EXPERT_CATEGORY_LABELS,
  EXPERT_COLORS,
} from '@/types/expert'

const props = defineProps<{
  visible: boolean
  expert: Expert | null
  mode: 'create' | 'edit'
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'save', data: {
    basic: ExpertUpdateRequest
    profile: ExpertProfileUpdateRequest
    config: ExpertConfigUpdateRequest
  }): void
}>()

const activeTab = ref<'basic' | 'model' | 'tools' | 'skills' | 'mcp'>('basic')

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

const formToolNames = ref<string[]>([])
const formSkillIds = ref<string[]>([])

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

const mockTools = [
  { name: 'http_request', displayName: 'HTTP 请求', type: 'function' },
  { name: 'execute_code', displayName: '代码执行', type: 'function' },
  { name: 'web_scraper', displayName: '网页抓取', type: 'function' },
  { name: 'tavily_search', displayName: 'Tavily 搜索', type: 'function' },
  { name: 'kb_search', displayName: '知识库搜索', type: 'function' },
  { name: 'sql_query', displayName: 'SQL 查询', type: 'function' },
  { name: 'image_generate', displayName: '图片生成', type: 'function' },
  { name: 'github-mcp', displayName: 'GitHub MCP', type: 'mcp' },
  { name: 'notion-mcp', displayName: 'Notion MCP', type: 'mcp' },
  { name: 'filesystem-mcp', displayName: '文件系统 MCP', type: 'mcp' },
]

const mockMcpTools = [
  { id: 'mcp-1', name: 'github-mcp', description: 'GitHub 仓库管理' },
  { id: 'mcp-2', name: 'notion-mcp', description: 'Notion 页面读写' },
  { id: 'mcp-3', name: 'filesystem-mcp', description: '本地文件系统' },
]

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
      formToolNames.value = expert.tools.map((t) => t.name)
      formSkillIds.value = expert.skills.map((s) => s.id)
      formMcpConfigs.value = expert.mcpConfigs.map((c) => ({
        mcpToolId: c.mcpToolId,
        mcpToolName: c.mcpToolName,
        config: { ...c.config },
        enabled: c.enabled,
      }))
    } else {
      // reset
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
      formToolNames.value = []
      formSkillIds.value = []
      formMcpConfigs.value = []
    }
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

/* ---- tool toggle ---- */
function toggleTool(name: string) {
  const idx = formToolNames.value.indexOf(name)
  if (idx === -1) {
    formToolNames.value.push(name)
  } else {
    formToolNames.value.splice(idx, 1)
  }
}

/* ---- mcp config management ---- */
function addMcpConfig() {
  formMcpConfigs.value.push({
    mcpToolId: '',
    mcpToolName: '',
    config: { command: 'npx', args: [], transport: 'stdio', env: {} },
    enabled: true,
  })
}

function removeMcpConfig(idx: number) {
  formMcpConfigs.value.splice(idx, 1)
}

function onMcpToolSelect(idx: number, mcpToolId: string) {
  const mcp = mockMcpTools.find((m) => m.id === mcpToolId)
  if (mcp) {
    formMcpConfigs.value[idx].mcpToolName = mcp.name
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

  const basic: ExpertUpdateRequest = {
    name: formName.value,
    title: formTitle.value,
    description: formDescription.value,
    systemPrompt: formSystemPrompt.value,
    providerId: formProviderId.value || undefined,
    modelId: formModelId.value || undefined,
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
    toolNames: [...formToolNames.value],
    skillIds: [...formSkillIds.value],
    mcpConfigs: formMcpConfigs.value.map((c) => ({
      mcpToolId: c.mcpToolId,
      config: c.config,
      enabled: c.enabled,
    })),
  }

  emit('save', { basic, profile, config })
}

const isEditing = computed(() => props.mode === 'edit')
const drawerTitle = computed(() => isEditing.value ? `编辑专家 — ${props.expert?.name || ''}` : '新建专家')
</script>

<template>
  <el-drawer
    :model-value="visible"
    :title="drawerTitle"
    direction="rtl"
    size="640px"
    :close-on-click-modal="false"
    @close="emit('close')"
  >
    <template #header>
      <div class="drawer-header">
        <span class="drawer-title">{{ drawerTitle }}</span>
        <div class="drawer-actions">
          <el-button @click="emit('close')">取消</el-button>
          <el-button type="primary" @click="handleSave">保存</el-button>
        </div>
      </div>
    </template>

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
            <el-input v-model="formInitials" placeholder="如：林" maxlength="8" style="width: 80px" />
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
            <el-select v-model="formProviderId" placeholder="选择提供商" clearable style="width: 100%">
              <el-option label="DeepSeek" value="p1" />
              <el-option label="OpenAI" value="p2" />
              <el-option label="通义千问" value="p3" />
            </el-select>
          </el-form-item>
          <el-form-item label="模型">
            <el-select v-model="formModelId" placeholder="选择模型" clearable style="width: 100%">
              <el-option label="deepseek-chat" value="m1" />
              <el-option label="gpt-4o" value="m2" />
              <el-option label="qwen-max" value="m3" />
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

      <!-- 工具 -->
      <el-tab-pane label="工具" name="tools">
        <div class="tool-section">
          <div class="tool-section-title">
            <Wrench :size="14" />
            内置工具
          </div>
          <div class="tool-list">
            <div
              v-for="tool in mockTools.filter(t => t.type === 'function')"
              :key="tool.name"
              class="tool-item"
              :class="{ 'tool-item--active': formToolNames.includes(tool.name) }"
              @click="toggleTool(tool.name)"
            >
              <el-checkbox :model-value="formToolNames.includes(tool.name)" size="small" />
              <span class="tool-name">{{ tool.displayName }}</span>
              <span class="tool-id">{{ tool.name }}</span>
            </div>
          </div>
        </div>
        <div class="tool-section">
          <div class="tool-section-title">
            <Network :size="14" />
            MCP 工具
          </div>
          <div class="tool-list">
            <div
              v-for="tool in mockTools.filter(t => t.type === 'mcp')"
              :key="tool.name"
              class="tool-item"
              :class="{ 'tool-item--active': formToolNames.includes(tool.name) }"
              @click="toggleTool(tool.name)"
            >
              <el-checkbox :model-value="formToolNames.includes(tool.name)" size="small" />
              <span class="tool-name">{{ tool.displayName }}</span>
              <el-tag size="small" type="warning">MCP</el-tag>
            </div>
          </div>
        </div>
      </el-tab-pane>

      <!-- 技能 -->
      <el-tab-pane label="技能" name="skills">
        <div class="skill-section">
          <div v-if="formSkillIds.length === 0" class="skill-empty">
            暂未关联技能
          </div>
          <div v-else class="skill-list">
            <el-tag
              v-for="skillId in formSkillIds"
              :key="skillId"
              closable
              size="default"
              @close="formSkillIds = formSkillIds.filter(id => id !== skillId)"
            >
              <Zap :size="12" style="margin-right: 4px" />
              {{ skillId }}
            </el-tag>
          </div>
          <el-button size="small" plain @click="formSkillIds.push('skill-' + Date.now())">
            <Plus :size="14" style="margin-right: 4px" />
            添加技能
          </el-button>
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
                  @change="(val: string) => onMcpToolSelect(idx, val)"
                >
                  <el-option
                    v-for="mcp in mockMcpTools"
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
                <el-input
                  v-model="(cfg.config as Record<string, string>).command"
                  size="small"
                  placeholder="command (如 npx)"
                >
                  <template #prepend>command</template>
                </el-input>
                <el-input
                  :model-value="Array.isArray(cfg.config.args) ? (cfg.config.args as string[]).join(' ') : ''"
                  size="small"
                  placeholder="args (空格分隔)"
                  @update:model-value="(val: string) => { (cfg.config as Record<string, unknown>).args = val.split(' ').filter(Boolean) }"
                >
                  <template #prepend>args</template>
                </el-input>
                <el-select
                  :model-value="(cfg.config as Record<string, string>).transport || 'stdio'"
                  size="small"
                  style="width: 100%"
                  @update:model-value="(val: string) => { (cfg.config as Record<string, string>).transport = val }"
                >
                  <template #prepend>transport</template>
                  <el-option label="stdio" value="stdio" />
                  <el-option label="sse" value="sse" />
                </el-select>
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
  </el-drawer>
</template>

<style scoped>
.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.drawer-title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
}

.drawer-actions {
  display: flex;
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

.tool-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
  margin-bottom: 12px;
}

.tool-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tool-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: border-color var(--transition-fast);

  &:hover {
    border-color: rgba(59, 130, 246, 0.25);
  }
}

.tool-item--active {
  border-color: var(--accent-primary);
  background: var(--accent-primary-light);
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
  flex-wrap: wrap;
  gap: 8px;
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
