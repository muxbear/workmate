<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted, type CSSProperties } from 'vue'
import { ElMessage } from 'element-plus'
import { X, Search, Download, ChevronDown, Upload, Check, AlertTriangle } from 'lucide-vue-next'
import type { Skill, SkillCreateRequest } from '@/types/skill'
import { CATEGORY_LABELS } from '@/types/skill'
import * as skillApi from '@/services/skillApi'
import { fetchChildrenParams } from '@/services/paramApi'
import { useSkillStore } from '@/stores/skill'

const props = defineProps<{
  visible: boolean
  skill: Skill | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'save', data: SkillCreateRequest): void
}>()

const isEditing = computed(() => !!props.skill)
const activeTab = ref<'download' | 'upload'>('upload')

// ---- Click-outside & keyboard ----
const repoSelectRef = ref<HTMLElement | null>(null)
const repoDropdownRef = ref<HTMLElement | null>(null)

function handleClickOutside(e: MouseEvent) {
  const target = e.target as Node
  if (repoSelectRef.value?.contains(target)) return
  if (repoDropdownRef.value?.contains(target)) return
  repoDropdownOpen.value = false
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    repoDropdownOpen.value = false
    if (!props.visible) return
    emit('close')
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside, true)
  document.addEventListener('keydown', handleKeydown)
})

watch(activeTab, (tab) => {
  if (tab === 'download') void loadRepoSources()
})

// 每次打开弹窗都重新拉取来源，保证「参数配置」的改动即时生效
watch(
  () => props.visible,
  (visible) => {
    repoDropdownOpen.value = false
    if (visible) void loadRepoSources(true)
  },
)

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside, true)
  document.removeEventListener('keydown', handleKeydown)
  stopDropdownTracking()
})

// ============================================================
//  Tab 1: Repository Download
// ============================================================
interface RepoOption {
  id: string
  label: string
  url: string
  desc: string
  authority: string
}

interface RepoSkill {
  id: string
  dirName: string
  name: string
  description: string
  category: string
  rank: number
  popularity: number
  selected: boolean
}

const repoOptions = ref<RepoOption[]>([])
const selectedRepo = ref<RepoOption | null>(null)
const repoDropdownOpen = ref(false)
const isCustomRepo = ref(false)
const customRepoUrl = ref('')
const importingRepo = ref(false)
const repoTriggerRef = ref<HTMLButtonElement | null>(null)
const dropdownStyle = ref<CSSProperties>({})

const repoUrl = computed(() => selectedRepo.value?.url ?? '')

/** 技能下载站点对应的「参数配置」参数编码 */
const SKILL_DOWNLOAD_SITE_CODE = 'skill_download_site'

/**
 * 读取「参数配置」中参数编码为 skill_download_site 的参数：
 * 该分组下的每个子参数即一个下载站点（编码=来源 id、标签=站点名称、值=仓库地址）。
 */
async function fetchConfiguredRepoSources(): Promise<RepoOption[] | null> {
  try {
    const params = await fetchChildrenParams(SKILL_DOWNLOAD_SITE_CODE)
    const options = params
      .map((item) => ({
        id: item.paramCode,
        label: item.paramLabel || item.paramName || item.paramCode,
        url: (item.paramValue ?? '').trim(),
        desc: item.description || item.paramName || '',
        authority: item.paramType,
      }))
      .filter((item) => item.id && item.label)
    return options.length > 0 ? options : null
  } catch {
    // 未配置该参数或当前账号无参数读取权限时，回退到后端内置来源
    return null
  }
}

/** 加载技能下载站点：优先取「参数配置」的参数，其次回退后端注册表（真实抓取，非硬编码） */
async function loadRepoSources(force = false): Promise<void> {
  if (!force && repoOptions.value.length > 0) return
  try {
    const configured = await fetchConfiguredRepoSources()
    const options =
      configured ??
      (await skillApi.fetchRepoSkillSources()).map((item) => ({
        id: item.id,
        label: item.name,
        url: item.homepage,
        desc: item.description,
        authority: item.authority,
      }))
    repoOptions.value = options
    repoError.value = ''
    const current = options.find((opt) => opt.id === selectedRepo.value?.id)
    selectedRepo.value = current ?? options[0] ?? null
  } catch (err: unknown) {
    repoError.value = err instanceof Error ? err.message : '加载技能仓库来源失败'
  }
}

/** 下拉面板挂在 body 上并用 fixed 定位，避免被弹窗容器裁剪 */
function updateDropdownPosition() {
  const trigger = repoTriggerRef.value
  if (!trigger) return
  const rect = trigger.getBoundingClientRect()
  dropdownStyle.value = {
    top: `${Math.round(rect.bottom + 4)}px`,
    left: `${Math.round(rect.left)}px`,
    width: `${Math.round(Math.max(rect.width, 280))}px`,
  }
}

function stopDropdownTracking() {
  window.removeEventListener('scroll', updateDropdownPosition, true)
  window.removeEventListener('resize', updateDropdownPosition)
}

watch(repoDropdownOpen, (open) => {
  if (!open) {
    stopDropdownTracking()
    return
  }
  updateDropdownPosition()
  window.addEventListener('scroll', updateDropdownPosition, true)
  window.addEventListener('resize', updateDropdownPosition)
})

function toggleRepoDropdown() {
  repoDropdownOpen.value = !repoDropdownOpen.value
}

function selectRepoOption(opt: RepoOption) {
  selectedRepo.value = opt
  isCustomRepo.value = false
  repoDropdownOpen.value = false
  resetRepoData()
}

function selectCustomRepo() {
  ElMessage.warning('自定义仓库地址暂不支持，请选择已注册的权威技能仓库')
}

function resetRepoData() {
  repoSkills.value = []
  repoError.value = ''
  skillSearch.value = ''
  skillPage.value = 1
}

const fetchingRepo = ref(false)
const repoSkills = ref<RepoSkill[]>([])
const repoError = ref('')
const skillSearch = ref('')
const skillPage = ref(1)
const skillPageSize = 6

const filteredRepoSkills = computed(() => {
  let list = repoSkills.value
  if (skillSearch.value.trim()) {
    const kw = skillSearch.value.trim().toLowerCase()
    list = list.filter(
      (s) =>
        s.name.toLowerCase().includes(kw) ||
        s.description.toLowerCase().includes(kw) ||
        s.category.toLowerCase().includes(kw),
    )
  }
  return list
})

const pagedRepoSkills = computed(() => {
  const start = (skillPage.value - 1) * skillPageSize
  return filteredRepoSkills.value.slice(start, start + skillPageSize)
})

const totalFiltered = computed(() => filteredRepoSkills.value.length)

const allSelected = computed({
  get: () =>
    pagedRepoSkills.value.length > 0 &&
    pagedRepoSkills.value.every((s) => s.selected),
  set: (val: boolean) =>
    pagedRepoSkills.value.forEach((s) => {
      s.selected = val
    }),
})

const isIndeterminate = computed(() => {
  const n = pagedRepoSkills.value.filter((s) => s.selected).length
  return n > 0 && n < pagedRepoSkills.value.length
})

const selectedCount = computed(() => repoSkills.value.filter((s) => s.selected).length)

async function fetchRepo() {
  const source = selectedRepo.value
  if (!source) return
  fetchingRepo.value = true
  repoError.value = ''
  repoSkills.value = []
  skillSearch.value = ''
  skillPage.value = 1

  try {
    const res = await skillApi.fetchRepoSkills({
      source: source.id,
      keyword: '',
      page: 1,
      page_size: 100,
    })
    repoSkills.value = res.items.map((item) => ({
      id: item.id,
      dirName: item.dir_name,
      name: item.name,
      description: item.description,
      category: item.category,
      rank: item.rank,
      popularity: item.popularity,
      selected: false,
    }))
    if (repoSkills.value.length === 0) {
      repoError.value = '该技能仓库暂无可用技能，请稍后重试'
    }
  } catch (err: unknown) {
    repoError.value = err instanceof Error ? err.message : '获取仓库技能列表失败'
  } finally {
    fetchingRepo.value = false
  }
}

function handleSearchChange() {
  skillPage.value = 1
}

async function importSelected() {
  const source = selectedRepo.value
  const selected = repoSkills.value.filter((s) => s.selected)
  if (!source) return
  if (selected.length === 0) {
    ElMessage.warning('请选择要导入的技能')
    return
  }
  importingRepo.value = true
  try {
    const res = await skillApi.importRepoSkills(
      source.id,
      selected.map((s) => s.id),
    )
    await skillStore.fetchSkills()
    if (res.invalid_count > 0) {
      ElMessage.warning(`已导入 ${res.valid_count} 个技能，${res.invalid_count} 个校验未通过`)
    } else if (res.skipped_count > 0) {
      ElMessage.success(`已导入 ${res.valid_count} 个技能，${res.skipped_count} 个已存在被跳过`)
    } else {
      ElMessage.success(`已导入 ${res.valid_count} 个技能`)
    }
    emit('close')
  } catch (err: unknown) {
    ElMessage.error(err instanceof Error ? err.message : '导入技能失败')
  } finally {
    importingRepo.value = false
  }
}

// ============================================================
//  Tab 2: Local Upload
// ============================================================
const skillStore = useSkillStore()
const uploadResult = ref<{ name: string; valid: boolean; message: string }[]>([])
const uploadMessage = ref('')
const isDragging = ref(false)
const uploading = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const uploadFile = ref<File | null>(null)

const uploadFileName = computed(() => uploadFile.value?.name || '')
const uploadSummary = ref<{
  total: number; valid_count: number; invalid_count: number; skipped_count: number
} | null>(null)

function triggerFileInput() {
  fileInput.value?.click()
}

function handleFileDrop(e: DragEvent) {
  isDragging.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) checkFile(file)
}

function handleFileInputChange() {
  const file = fileInput.value?.files?.[0]
  if (file) checkFile(file)
}

function checkFile(file: File) {
  uploadFile.value = file
  uploadResult.value = []
  uploadSummary.value = null
  uploadMessage.value = ''
}

async function doUpload() {
  if (!uploadFile.value) return
  uploading.value = true
  uploadMessage.value = ''
  uploadResult.value = []
  uploadSummary.value = null
  try {
    const res = await skillStore.uploadSkillPackage(uploadFile.value)
    uploadSummary.value = {
      total: res.total,
      valid_count: res.valid_count,
      invalid_count: res.invalid_count,
      skipped_count: res.skipped_count,
    }
    if (res.invalid_count > 0) {
      uploadMessage.value = `校验完成: ${res.valid_count} 通过, ${res.invalid_count} 未通过`
    } else {
      uploadMessage.value = `全部 ${res.valid_count} 个技能校验通过`
    }
    uploadResult.value = res.results.map((r) => ({
      name: r.name,
      valid: r.valid,
      message: r.valid ? '通过' : r.errors.map((e) => `${e.field}: ${e.message}`).join('; '),
    }))
    ElMessage.success(`成功导入 ${res.valid_count} 个技能`)
  } catch (err: unknown) {
    uploadMessage.value = err instanceof Error ? err.message : '上传失败'
    ElMessage.error(uploadMessage.value)
  } finally {
    uploading.value = false
  }
}

function handleUploadImport() {
  emit('close')
}

// ============================================================
//  Tab 3: Manual Create
// ============================================================
const categoryOptions = computed(() =>
  Object.entries(CATEGORY_LABELS).map(([key, label]) => ({ key, label })),
)

const sourceOptions = [
  { key: 'local', label: '本地上传' },
  { key: 'builtin', label: '内置' },
  { key: 'anthropic-official', label: 'Anthropic 官方' },
  { key: 'superpowers', label: 'Superpowers' },
]

interface EditFormData {
  name: string; description: string; icon: string; category: string; source: string; prompt: string
}

const form = ref<EditFormData>({
  name: '', description: '', icon: 'Zap', category: 'custom', source: 'local', prompt: '',
})

watch(
  () => props.skill,
  (s) => {
    if (s) {
      form.value = {
        name: s.name, description: s.description, icon: s.icon,
        category: s.category, source: s.source || 'local', prompt: s.prompt,
      }
    } else {
      form.value = { name: '', description: '', icon: 'Zap', category: 'custom', source: 'local', prompt: '' }
    }
  },
  { immediate: true },
)

function handleManualSubmit() {
  if (!form.value.name.trim()) { ElMessage.warning('请输入技能名称'); return }
  const data: SkillCreateRequest & { source?: string } = {
    name: form.value.name.trim(),
    description: form.value.description,
    icon: form.value.icon,
    category: form.value.category,
    prompt: form.value.prompt,
    source: form.value.source,
  }
  emit('save', data)
}

// ============================================================
//  Pagination helper
// ============================================================
function totalPages() {
  return Math.max(1, Math.ceil(totalFiltered.value / skillPageSize))
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="visible" class="skill-overlay" @click.self="emit('close')">
        <div class="skill-modal">
          <!-- Header -->
          <div class="modal-header">
            <span class="modal-title">{{ isEditing ? '编辑技能' : '创建技能' }}</span>
            <button class="modal-close" @click="emit('close')" aria-label="关闭">
              <X :size="18" />
            </button>
          </div>

          <!-- Tab Navigation -->
          <div v-if="!isEditing" class="modal-tabs">
            <button class="tab-btn" :class="{ active: activeTab === 'upload' }" @click="activeTab = 'upload'">
              本地上传
            </button>
            <button class="tab-btn" :class="{ active: activeTab === 'download' }" @click="activeTab = 'download'">
              从仓库下载
            </button>
          </div>

          <div class="modal-body">
            <!-- =========== TAB 1: UPLOAD =========== -->
            <div v-if="activeTab === 'upload' && !isEditing" class="tab-inner">
              <!-- Custom drop zone -->
              <div
                class="dropzone"
                :class="{ dragging: isDragging }"
                @click="triggerFileInput"
                @dragover.prevent="isDragging = true"
                @dragleave.prevent="isDragging = false"
                @drop.prevent="handleFileDrop"
              >
                <input
                  ref="fileInput"
                  type="file"
                  accept=".zip,.tar.gz,.tgz,.tar.bz2,.tbz2,.tar.xz,.txz,.tar"
                  hidden
                  @change="handleFileInputChange"
                />
                <div class="dz-icon-circle">
                  <Upload :size="22" />
                </div>
                <div class="dz-text">拖拽文件到此处或 <span class="dz-link">点击上传</span></div>
                <div class="dz-formats">
                  <span v-for="f in ['.zip','.tar.gz','.tar.bz2','.tar.xz']" :key="f" class="dz-tag">{{ f }}</span>
                </div>
              </div>

              <!-- Selected file info -->
              <div v-if="uploadFile && uploadResult.length === 0" class="file-info-box">
                <span class="file-name">{{ uploadFileName }}</span>
                <button class="btn btn-primary" :disabled="uploading" @click="doUpload">
                  <span v-if="uploading" class="spinner" />
                  <Upload v-else :size="14" />
                  {{ uploading ? '上传中...' : '上传并校验' }}
                </button>
              </div>

              <!-- Validation -->
              <div v-if="uploadResult.length > 0" class="valid-panel">
                <div class="valid-header">
                  <Check v-if="uploadSummary && uploadSummary.invalid_count === 0" :size="16" class="icon-ok" />
                  <AlertTriangle v-else :size="16" class="icon-warn" />
                  <span>校验结果: {{ uploadMessage }}</span>
                </div>
                <div v-if="uploadSummary" class="upload-summary">
                  <span>共 {{ uploadSummary.total }} 个</span>
                  <span class="dot-ok">通过 {{ uploadSummary.valid_count }}</span>
                  <span v-if="uploadSummary.invalid_count > 0" class="dot-fail">不通过 {{ uploadSummary.invalid_count }}</span>
                  <span v-if="uploadSummary.skipped_count > 0">跳过 {{ uploadSummary.skipped_count }}</span>
                </div>
                <div v-for="r in uploadResult" :key="r.name" class="valid-row">
                  <span class="valid-dot" :class="{ ok: r.valid, fail: !r.valid }" />
                  <span class="valid-name">{{ r.name }}</span>
                  <span class="valid-msg">{{ r.message }}</span>
                </div>
                <div class="actions">
                  <button class="btn btn-ghost" @click="emit('close')">关闭</button>
                </div>
              </div>
            </div>

            <!-- =========== TAB 2: DOWNLOAD =========== -->
            <div v-if="activeTab === 'download' && !isEditing" class="tab-inner">
              <!-- Unified Panel -->
              <div class="download-panel">
                <!-- Top: Repo selector + Fetch (single row) -->
                <div class="dp-top">
                  <div ref="repoSelectRef" class="custom-select" :class="{ open: repoDropdownOpen }">
                    <button
                      ref="repoTriggerRef"
                      class="select-trigger"
                      type="button"
                      @click.stop="toggleRepoDropdown"
                    >
                      <span class="select-trigger-label">{{ isCustomRepo ? '自定义地址' : (selectedRepo?.label ?? '选择下载站点') }}</span>
                      <ChevronDown :size="14" class="select-arrow" />
                    </button>
                    <Teleport to="body">
                      <div
                        v-if="repoDropdownOpen"
                        ref="repoDropdownRef"
                        class="select-dropdown"
                        :style="dropdownStyle"
                        @click.stop
                      >
                        <div
                          v-for="opt in repoOptions"
                          :key="opt.id"
                          class="select-option"
                          :class="{ picked: !isCustomRepo && opt.id === (selectedRepo?.id ?? '') }"
                          @click.stop="selectRepoOption(opt)"
                        >
                          <div class="opt-info">
                            <span class="opt-label">{{ opt.label }}</span>
                            <span class="opt-desc">{{ opt.desc || opt.url }}</span>
                          </div>
                          <Check v-if="!isCustomRepo && opt.id === (selectedRepo?.id ?? '')" :size="14" class="opt-check" />
                        </div>
                        <div class="select-divider" />
                        <div
                          class="select-option"
                          :class="{ picked: isCustomRepo }"
                          @click.stop="selectCustomRepo()"
                        >
                          <div class="opt-info">
                            <span class="opt-label">自定义地址</span>
                            <span class="opt-desc">手动输入仓库 URL</span>
                          </div>
                          <Check v-if="isCustomRepo" :size="14" class="opt-check" />
                        </div>
                      </div>
                    </Teleport>
                  </div>
                  <input
                    v-if="isCustomRepo"
                    v-model="customRepoUrl"
                    type="text"
                    class="text-input dp-url-input"
                    placeholder="输入自定义仓库地址"
                  />
                  <input
                    v-else
                    :value="(selectedRepo?.url ?? '')"
                    type="text"
                    class="text-input dp-url-input readonly"
                    readonly
                  />
                  <button class="btn btn-primary" :disabled="!repoUrl || fetchingRepo" @click="fetchRepo">
                    <span v-if="fetchingRepo" class="spinner" />
                    <Search v-else :size="14" />
                    获取
                  </button>
                </div>

                <!-- Results (only visible after fetch) -->
                <template v-if="repoSkills.length > 0">
                  <div class="dp-divider" />

                  <div class="dp-search">
                    <Search :size="14" class="input-icon" />
                    <input
                      v-model="skillSearch"
                      type="text"
                      class="text-input has-icon"
                      placeholder="检索技能名称、描述或分类..."
                      @input="handleSearchChange"
                    />
                  </div>

                  <div class="dp-select-all">
                    <label class="check-label">
                      <span class="check-box" :class="{ checked: allSelected, partial: isIndeterminate }" @click="allSelected = !allSelected">
                        <Check v-if="allSelected" :size="12" />
                        <span v-else-if="isIndeterminate" class="partial-bar" />
                      </span>
                      <span>全选当前页</span>
                    </label>
                    <span class="count-text">已选 {{ selectedCount }} / {{ repoSkills.length }} 个</span>
                  </div>

                  <div class="dp-skill-list">
                    <div v-for="sk in pagedRepoSkills" :key="sk.id" class="skill-row-item">
                      <span class="check-box small" :class="{ checked: sk.selected }" @click="sk.selected = !sk.selected">
                        <Check v-if="sk.selected" :size="11" />
                      </span>
                      <div class="skill-meta">
                        <span class="skill-meta-name">{{ sk.name }}</span>
                        <span class="skill-meta-desc">{{ sk.description }}</span>
                      </div>
                      <span class="skill-tag">#{{ sk.rank }} · {{ sk.popularity }}★</span>
                    </div>
                  </div>

                  <div v-if="totalFiltered > skillPageSize" class="dp-pager">
                    <button class="page-btn" :disabled="skillPage <= 1" @click="skillPage--">‹</button>
                    <button
                      v-for="p in totalPages()"
                      :key="p"
                      class="page-btn"
                      :class="{ active: p === skillPage }"
                      @click="skillPage = p"
                    >{{ p }}</button>
                    <button class="page-btn" :disabled="skillPage >= totalPages()" @click="skillPage++">›</button>
                  </div>

                  <div class="dp-divider" />

                  <div class="dp-actions">
                    <button class="btn btn-ghost" @click="emit('close')">取消</button>
                    <button class="btn btn-primary" :disabled="selectedCount === 0" @click="importSelected">
                      <Download :size="14" />
                      拉取到本地 ({{ selectedCount }})
                    </button>
                  </div>
                </template>
              </div>

              <!-- Error -->
              <div v-if="repoError" class="error-box">
                <AlertTriangle :size="14" />
                <span>{{ repoError }}</span>
                <button class="btn-text" @click="fetchRepo">重试</button>
              </div>

              <!-- Hint (before fetch) -->
              <div
                v-if="!fetchingRepo && repoSkills.length === 0 && !repoError"
                class="hint-box"
              >
                选择或输入一个技能仓库地址，点击"获取"加载技能列表
              </div>
            </div>

            <!-- =========== 编辑技能表单（仅编辑态） =========== -->
            <div v-if="isEditing" class="tab-inner">
              <div class="form-grid">
                <div class="field">
                  <label class="field-label">技能名称 <span class="required">*</span></label>
                  <input
                    v-model="form.name"
                    type="text"
                    class="text-input"
                    placeholder="输入技能名称"
                    maxlength="64"
                  />
                </div>
                <div class="field">
                  <label class="field-label">描述</label>
                  <textarea
                    v-model="form.description"
                    class="text-input textarea"
                    rows="3"
                    placeholder="简要描述技能的功能和用途..."
                    maxlength="512"
                  />
                </div>
                <div class="field">
                  <label class="field-label">图标名称</label>
                  <input
                    v-model="form.icon"
                    type="text"
                    class="text-input"
                    placeholder="输入 Lucide 图标名称，如 Globe"
                  />
                </div>
                <div class="field">
                  <label class="field-label">分类</label>
                  <select v-model="form.category" class="text-input">
                    <option v-for="opt in categoryOptions" :key="opt.key" :value="opt.key">
                      {{ opt.label }}
                    </option>
                  </select>
                </div>
                <div class="field">
                  <label class="field-label">来源</label>
                  <select v-model="form.source" class="text-input">
                    <option v-for="opt in sourceOptions" :key="opt.key" :value="opt.key">
                      {{ opt.label }}
                    </option>
                  </select>
                </div>
                <div class="field">
                  <label class="field-label">系统提示词</label>
                  <textarea
                    v-model="form.prompt"
                    class="text-input textarea"
                    rows="6"
                    placeholder="编写技能的 Prompt 提示词，指导 AI 行为..."
                  />
                </div>
              </div>
              <div class="actions">
                <button class="btn btn-ghost" @click="emit('close')">取消</button>
                <button class="btn btn-primary" @click="handleManualSubmit">
                  保存
                </button>
              </div>
            </div>

            <!-- Upload tab initial cancel -->
            <div
              v-if="activeTab === 'upload' && !isEditing && uploadResult.length === 0"
              class="actions"
            >
              <button class="btn btn-ghost" @click="emit('close')">取消</button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* ============================================
   OVERLAY & MODAL SHELL
   ============================================ */
.skill-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-overlay);
  z-index: 9999;
}

.skill-modal {
  width: 680px;
  max-width: 92vw;
  height: 660px;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  background: var(--color-modal-bg);
  border: 1px solid var(--color-border-card);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-modal);
  overflow: hidden;
}

/* ---- Header ---- */
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 24px;
  border-bottom: 1px solid var(--color-border-input);
  flex-shrink: 0;
}

.modal-title {
  font-size: 17px;
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
}

.modal-close {
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--color-text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--transition-fast);
}

.modal-close:hover {
  background: var(--surface-secondary);
  color: var(--color-text-primary);
}

/* ---- Tabs ---- */
.modal-tabs {
  display: flex;
  padding: 4px;
  margin: 16px 24px 0;
  background: var(--surface-secondary);
  border-radius: var(--radius-lg);
  gap: 2px;
  flex-shrink: 0;
}

.tab-btn {
  flex: 1;
  padding: 9px 0;
  border: none;
  border-radius: 7px;
  background: transparent;
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  color: var(--foreground-secondary);
  cursor: pointer;
  font-family: var(--font-family-base);
  transition: all var(--transition-fast);
}

.tab-btn:hover { color: var(--foreground-primary); }

.tab-btn.active {
  background: var(--accent-primary);
  color: #fff;
  font-weight: var(--font-weight-semibold);
  box-shadow: 0px 2px 8px rgba(59, 130, 246, 0.3);
}

/* ---- Body ---- */
.modal-body {
  padding: 20px 24px 24px;
  overflow-y: auto;
  flex: 1;
}

.tab-inner {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

/* ============================================
   SHARED: Form Elements
   ============================================ */
.field {
  margin-bottom: 16px;
  flex-shrink: 0;
}

.field-label {
  display: block;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-label);
  margin-bottom: 8px;
}

.required { color: var(--color-text-error); }

.text-input {
  width: 100%;
  padding: 10px 14px;
  background: var(--color-bg-input);
  border: 1px solid var(--color-border-input);
  border-radius: var(--radius-input);
  font-size: var(--font-size-base);
  color: var(--color-text-primary);
  font-family: var(--font-family-base);
  outline: none;
  box-sizing: border-box;
  transition: border-color var(--transition-fast);
}

.text-input::placeholder { color: var(--color-text-muted); }
.text-input:focus { border-color: var(--accent-primary); box-shadow: 0px 0px 0px 2px rgba(59,130,246,0.12); }
.text-input.readonly { opacity: 0.7; cursor: default; }
.text-input.has-icon { padding-left: 36px; }

.textarea {
  resize: vertical;
  min-height: 60px;
  line-height: 1.5;
}

/* ============================================
   SHARED: Buttons
   ============================================ */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 20px;
  border: none;
  border-radius: var(--radius-button);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  font-family: var(--font-family-base);
  cursor: pointer;
  transition: all var(--transition-fast);
  white-space: nowrap;
}

.btn:disabled { opacity: 0.45; cursor: not-allowed; }

.btn-primary {
  background: var(--accent-primary);
  color: #fff;
}

.btn-primary:hover:not(:disabled) { background: var(--color-accent-dark); }

.btn-ghost {
  background: var(--surface-secondary);
  color: var(--foreground-secondary);
  border: 1px solid var(--border-medium);
}

.btn-ghost:hover { border-color: var(--accent-primary); color: var(--foreground-primary); }

.btn-text {
  background: none;
  border: none;
  color: var(--accent-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  padding: 0;
}

.btn-text:hover { text-decoration: underline; }

/* ============================================
   ACTIONS ROW
   ============================================ */
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--color-border-input);
  flex-shrink: 0;
}

/* ============================================
   SPINNER
   ============================================ */
.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255,255,255,0.25);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ============================================
   CUSTOM SELECT DROPDOWN
   ============================================ */
.custom-select { position: relative; width: 180px; flex-shrink: 0; }

.select-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 12px;
  background: var(--color-bg-input);
  border: 1px solid var(--color-border-input);
  border-radius: var(--radius-input);
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
  font-family: var(--font-family-base);
  cursor: pointer;
  transition: border-color var(--transition-fast);
  text-align: left;
}

.select-trigger:hover { border-color: rgba(59,130,246,0.35); }

.custom-select.open .select-trigger {
  border-color: var(--accent-primary);
  box-shadow: 0px 0px 0px 2px rgba(59,130,246,0.12);
}

.select-desc {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  margin-left: auto;
  margin-right: 4px;
}

.select-arrow { color: var(--color-text-muted); flex-shrink: 0; }

.select-trigger-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 下拉面板由 Teleport 挂载到 body，用 fixed 定位避免被弹窗容器（overflow: hidden）裁剪 */
.select-dropdown {
  position: fixed;
  min-width: 220px;
  max-height: 320px;
  overflow-y: auto;
  background: var(--color-bg-card);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-modal);
  z-index: 10050;
}

.select-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 10px 14px;
  border: none;
  background: none;
  color: var(--color-text-secondary);
  font-size: var(--font-size-base);
  font-family: var(--font-family-base);
  cursor: pointer;
  text-align: left;
  transition: background var(--transition-fast);
}

.select-option:hover { background: rgba(59,130,246,0.08); color: var(--color-text-primary); }
.select-option.picked { color: var(--accent-primary); }

.opt-info { display: flex; flex-direction: column; gap: 2px; }
.opt-label { font-weight: var(--font-weight-semibold); }
.opt-desc { font-size: var(--font-size-xs); color: var(--color-text-muted); }
.opt-check { flex-shrink: 0; }

/* ============================================
   DOWNLOAD PANEL (unified)
   ============================================ */
.download-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card);
  background: var(--surface-secondary);
  overflow: hidden;
}

.dp-top {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  flex-shrink: 0;
}

.dp-url-input {
  flex: 1;
  min-width: 0;
}

.select-divider {
  height: 1px;
  background: var(--border-subtle);
  margin: 4px 8px;
}

.dp-divider {
  height: 1px;
  background: var(--color-border-input);
  flex-shrink: 0;
}

.dp-search {
  position: relative;
  padding: 14px 16px 0;
  flex-shrink: 0;
}

.input-icon {
  position: absolute;
  left: 28px;
  top: calc(50% + 7px);
  transform: translateY(-50%);
  color: var(--color-text-muted);
  pointer-events: none;
  z-index: 1;
}

.dp-select-all {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}

.count-text {
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
  font-variant-numeric: tabular-nums;
}

/* ---- Scrollable skill list ---- */
.dp-skill-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dp-skill-list::-webkit-scrollbar { width: 6px; }
.dp-skill-list::-webkit-scrollbar-track { background: transparent; margin: 4px 0; }
.dp-skill-list::-webkit-scrollbar-thumb { background: var(--border-subtle); border-radius: 3px; }
.dp-skill-list::-webkit-scrollbar-thumb:hover { background: var(--border-medium); }

/* ---- Pagination ---- */
.dp-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 10px 16px;
  border-top: 1px solid var(--border-subtle);
  flex-shrink: 0;
}

/* ---- Actions ---- */
.dp-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 16px;
  border-top: 1px solid var(--color-border-input);
  flex-shrink: 0;
}

/* ---- Checkbox ---- */
.check-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-size-base);
  color: var(--color-text-primary);
  cursor: pointer;
  user-select: none;
}

.check-box {
  width: 16px;
  height: 16px;
  border: 1px solid var(--color-border-input);
  border-radius: 3px;
  background: var(--color-bg-input);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all var(--transition-fast);
  cursor: pointer;
}

.check-box.checked { background: var(--accent-primary); border-color: var(--accent-primary); color: #fff; }
.check-box.partial { background: var(--accent-primary); border-color: var(--accent-primary); }
.partial-bar { width: 8px; height: 2px; background: #fff; border-radius: 1px; }
.check-box.small { width: 14px; height: 14px; }

/* ---- Skill row ---- */
.skill-row-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  transition: border-color var(--transition-fast), background var(--transition-fast);
}
.skill-row-item:hover { border-color: rgba(59,130,246,0.3); }

.skill-meta { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.skill-meta-name { font-size: var(--font-size-base); font-weight: var(--font-weight-semibold); color: var(--color-text-primary); }
.skill-meta-desc { font-size: var(--font-size-xs); color: var(--foreground-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.skill-tag {
  padding: 2px 10px;
  border-radius: 4px;
  background: var(--surface-inset-soft);
  color: var(--foreground-secondary);
  font-size: var(--font-size-xs);
  flex-shrink: 0;
}

/* ---- Page button ---- */
.page-btn {
  min-width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  font-family: var(--font-family-base);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--transition-fast);
}
.page-btn:hover:not(:disabled):not(.active) { color: var(--accent-primary); background: rgba(59,130,246,0.08); }
.page-btn.active { background: var(--accent-primary); color: #fff; }
.page-btn:disabled { opacity: 0.3; cursor: not-allowed; }

/* ---- Error & Hint ---- */
.error-box {
  margin-top: 14px;
  padding: 12px 16px;
  background: rgba(239,68,68,0.06);
  border: 1px solid rgba(239,68,68,0.2);
  border-radius: var(--radius-lg);
  font-size: var(--font-size-sm);
  color: var(--color-text-error);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.error-box .btn-text { margin-left: auto; }

.hint-box {
  margin-top: 14px;
  padding: 36px 24px;
  text-align: center;
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
  background: var(--surface-secondary);
  border: 1px dashed var(--border-medium);
  border-radius: var(--radius-lg);
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* ============================================
   TAB 2: DROP ZONE
   ============================================ */
.dropzone {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 24px;
  border: 2px dashed var(--border-medium);
  border-radius: var(--radius-card);
  background: var(--surface-secondary);
  text-align: center;
  cursor: pointer;
  transition: border-color var(--transition-fast), background var(--transition-fast);
}

.dropzone:hover,
.dropzone.dragging {
  border-color: var(--accent-primary);
  background: var(--accent-primary-light);
}

.dz-icon-circle {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: 2px dashed var(--color-text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 14px;
  color: var(--color-text-muted);
}

.dz-text {
  font-size: var(--font-size-md);
  color: var(--color-text-secondary);
  margin-bottom: 14px;
}

.dz-link { color: var(--accent-primary); }

.dz-formats {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: center;
}

.dz-tag {
  padding: 3px 10px;
  border-radius: 4px;
  background: var(--accent-primary-light);
  color: var(--accent-primary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
}

/* ---- Validation ---- */
.valid-panel {
  margin-top: 18px;
  padding: 14px 16px;
  background: var(--surface-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
}

.valid-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
}

.icon-ok { color: #22c55e; }
.icon-warn { color: #f59e0b; }

.valid-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
}

.valid-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.valid-dot.ok { background: #22c55e; }
.valid-dot.fail { background: #ef4444; }

.valid-name { flex: 1; font-size: var(--font-size-base); color: var(--color-text-primary); }
.valid-msg { font-size: var(--font-size-sm); color: var(--color-text-muted); }

/* ============================================
   FORM GRID (Manual Create)
   ============================================ */
.form-grid {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow-y: auto;
}

/* ============================================
   TRANSITION
   ============================================ */
.modal-enter-active,
.modal-leave-active {
  transition: opacity var(--transition-normal);
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

/* ============================================
   UPLOAD: FILE INFO & SUMMARY
   ============================================ */
.file-info-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 14px;
  padding: 12px 16px;
  background: var(--surface-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
}

.file-name {
  font-size: var(--font-size-base);
  color: var(--color-text-primary);
}

.upload-summary {
  display: flex;
  gap: 12px;
  margin-bottom: 10px;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.dot-ok { color: #22c55e; }
.dot-fail { color: #ef4444; }
</style>
