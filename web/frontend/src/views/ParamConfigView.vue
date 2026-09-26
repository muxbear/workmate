<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import {
  Edit2,
  FolderTree,
  GripVertical,
  Plus,
  Search,
  Settings2,
  Trash2,
  X,
} from 'lucide-vue-next'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useParamStore } from '@/stores/param'
import { useDragSort } from '@/composables/useDragSort'
import {
  PARAM_CODE_PATTERN,
  PARAM_TYPE_CLASSES,
  PARAM_TYPE_LABELS,
  VALUE_PARAM_TYPES,
} from '@/types/param'
import type { ParamItem, ParamPayload, ParamType } from '@/types/param'

const store = useParamStore()

const parentDrag = useDragSort({
  scope: 'parents',
  getItemIds: () => store.parents.map((node) => node.id),
  onReorder: (ids) => store.reorderParents(ids).catch((error) => showError(error)),
})

const childDrag = useDragSort({
  scope: 'children',
  getItemIds: () => store.children.map((node) => node.id),
  onReorder: (ids) => store.reorderChildren(ids).catch((error) => showError(error)),
})

const dialogVisible = ref(false)
const dialogMode = ref<'create' | 'edit'>('create')
const editingItem = ref<ParamItem | null>(null)

const form = reactive<ParamPayload>(createEmptyForm())

function createEmptyForm(): ParamPayload {
  return {
    paramCode: '',
    parentCode: null,
    paramLabel: '',
    paramName: '',
    paramValue: null,
    paramType: 'group',
    description: '',
  }
}

const isParentForm = computed(() => form.parentCode === null)

const dialogTitle = computed(() => {
  if (dialogMode.value === 'create') {
    return isParentForm.value ? '新增父级参数' : '新增子参数'
  }
  return isParentForm.value ? '编辑父级参数' : '编辑子参数'
})

function openCreateParent() {
  Object.assign(form, createEmptyForm())
  editingItem.value = null
  dialogMode.value = 'create'
  dialogVisible.value = true
}

function openCreateChild() {
  const parentCode = store.selectedCode
  if (!parentCode) return
  Object.assign(form, createEmptyForm(), {
    parentCode,
    paramType: 'string' as ParamType,
    paramValue: '',
  })
  editingItem.value = null
  dialogMode.value = 'create'
  dialogVisible.value = true
}

function openEdit(item: ParamItem) {
  editingItem.value = item
  form.paramCode = item.paramCode
  form.parentCode = item.parentCode
  form.paramLabel = item.paramLabel
  form.paramName = item.paramName
  form.paramValue = item.paramValue ?? ''
  form.paramType = item.paramType
  form.description = item.description
  dialogMode.value = 'edit'
  dialogVisible.value = true
}

function showError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  ElMessage.error(message)
}

function formatTime(value: string): string {
  if (!value) return '-'
  return value.replace('T', ' ').slice(0, 19)
}

function startParentDrag(event: PointerEvent, id: string) {
  if (store.searchQuery.trim()) return
  parentDrag.onHandleDown(event, id)
}

function startChildDrag(event: PointerEvent, id: string) {
  childDrag.onHandleDown(event, id)
}

async function saveParam() {
  const code = form.paramCode.trim()
  const label = form.paramLabel.trim()
  const name = form.paramName.trim()
  if (!code || !label || !name) {
    ElMessage.warning('参数编码、标签与名称不能为空')
    return
  }
  if (!PARAM_CODE_PATTERN.test(code)) {
    ElMessage.warning('参数编码仅支持字母、数字、点、下划线与中划线')
    return
  }

  const payload: ParamPayload = {
    paramCode: code,
    parentCode: form.parentCode,
    paramLabel: label,
    paramName: name,
    paramValue: form.paramValue,
    paramType: form.paramType,
    description: form.description.trim(),
  }

  if (payload.parentCode === null) {
    payload.paramValue = null
  } else {
    const rawValue = payload.paramValue ?? ''
    if (
      payload.paramType === 'number' &&
      rawValue.trim() !== '' &&
      Number.isNaN(Number(rawValue))
    ) {
      ElMessage.warning('数字参数值格式不正确')
      return
    }
    if (payload.paramType === 'boolean' && rawValue !== 'true' && rawValue !== 'false') {
      ElMessage.warning('布尔参数值只能为 true 或 false')
      return
    }
    if (payload.paramType === 'json') {
      try {
        JSON.parse(rawValue)
      } catch {
        ElMessage.warning('参数值必须是合法的 JSON')
        return
      }
    }
  }

  try {
    if (dialogMode.value === 'create') {
      await store.handleCreate(payload)
      ElMessage.success(payload.parentCode ? '子参数创建成功' : '父级参数创建成功')
    } else if (editingItem.value) {
      await store.handleUpdate(editingItem.value, payload)
      ElMessage.success('参数更新成功')
    }
    dialogVisible.value = false
  } catch (error) {
    showError(error)
  }
}

async function confirmDelete(item: ParamItem) {
  const isParent = !item.parentCode
  const cascadeText =
    isParent && item.childCount > 0 ? '，其下 ' + item.childCount + ' 个子参数将一并删除' : ''
  try {
    await ElMessageBox.confirm(
      '确定删除参数「' + item.paramLabel + '」吗' + cascadeText + '？',
      '删除确认',
      {
        type: 'warning',
        confirmButtonText: '删除',
        cancelButtonText: '取消',
      },
    )
  } catch {
    return
  }
  try {
    await store.handleDelete(item)
    ElMessage.success('删除成功')
  } catch (error) {
    showError(error)
  }
}

onMounted(() => {
  store.fetchParents().catch((error) => showError(error))
})

const typeOptions = computed<ParamType[]>(() => {
  return isParentForm.value ? ['group', ...VALUE_PARAM_TYPES] : VALUE_PARAM_TYPES
})
</script>

<template>
  <div class="param-page">
    <div class="param-topbar">
      <div class="topbar-left">
        <div class="topbar-icon">
          <Settings2 :size="20" />
        </div>
        <div>
          <h1 class="topbar-title">参数配置</h1>
          <p class="topbar-sub">系统参数管理 · 分组维护与键值配置</p>
        </div>
      </div>
      <div class="topbar-right">
        <span class="topbar-stats">共 {{ store.parents.length }} 个参数分组</span>
      </div>
    </div>

    <div class="param-body">
      <aside class="tree-panel">
        <div class="panel-head">
          <div class="panel-title">
            <FolderTree :size="15" />
            <span>父级参数</span>
            <span class="panel-count">{{ store.parents.length }}</span>
          </div>
          <button class="add-btn" @click="openCreateParent">
            <Plus :size="14" />
            新增分组
          </button>
        </div>

        <div class="tree-search">
          <Search :size="14" class="search-icon" />
          <input
            v-model="store.searchQuery"
            type="text"
            placeholder="搜索编码 / 标签 / 名称"
            class="search-input"
          />
          <button
            v-if="store.searchQuery"
            class="search-clear"
            @click="store.searchQuery = String()"
           aria-label="清空搜索">
            <X :size="12" />
          </button>
        </div>

        <div class="tree-scroll">
          <div v-if="store.loadingParents" class="tree-empty">加载中...</div>
          <div v-else-if="store.filteredParents.length === 0" class="tree-empty">
            {{ store.searchQuery ? '未找到匹配的父级参数' : '暂无父级参数，可点击上方新增分组' }}
          </div>
          <div
            v-for="node in store.filteredParents"
            :key="node.id"
            class="tree-row"
            :class="{
              selected: store.selectedCode === node.paramCode,
              'drag-active': parentDrag.draggingId.value === node.id,
              'drop-before': parentDrag.dropBeforeId.value === node.id,
              'drop-after': parentDrag.dropAfterId.value === node.id,
            }"
            data-drag-row=""
            data-drag-scope="parents"
            :data-drag-row-id="node.id"
            @click="store.selectParent(node.paramCode)"
          >
            <span
              class="drag-handle"
              title="拖拽排序"
              @pointerdown="(event) => startParentDrag(event, node.id)"
            >
              <GripVertical :size="14" />
            </span>
            <div class="node-main">
              <span class="node-label">{{ node.paramLabel || node.paramName }}</span>
              <span class="node-code">{{ node.paramCode }}</span>
            </div>
            <span class="child-count" title="子参数数量">{{ node.childCount }}</span>
            <div class="row-actions" @click.stop>
              <button class="row-btn" title="编辑" @click="openEdit(node)" aria-label="编辑">
                <Edit2 :size="13" />
              </button>
              <button class="row-btn danger" title="删除" @click="confirmDelete(node)" aria-label="删除">
                <Trash2 :size="13" />
              </button>
            </div>
          </div>
        </div>
      </aside>

      <section class="content-panel">
        <div v-if="!store.selectedParent" class="content-empty">
          <FolderTree :size="42" class="empty-icon" />
          <p>从左侧选择一个父级参数查看其子参数</p>
        </div>
        <template v-else>
          <div class="content-head">
            <div class="content-title-wrap">
              <h2 class="content-title">
                {{ store.selectedParent.paramLabel || store.selectedParent.paramName }}
              </h2>
              <span class="content-code">{{ store.selectedParent.paramCode }}</span>
              <span class="content-sub">共 {{ store.children.length }} 个子参数</span>
            </div>
            <button class="add-btn" @click="openCreateChild">
              <Plus :size="14" />
              新增子参数
            </button>
          </div>

          <div class="table-scroll">
            <div class="param-table">
              <div class="table-header">
                <span class="col-handle" />
                <span>参数编码</span>
                <span>参数标签</span>
                <span>参数名称</span>
                <span>参数值</span>
                <span>类型</span>
                <span>更新时间</span>
                <span class="col-actions">操作</span>
              </div>

              <div v-if="store.loadingChildren" class="table-tip">加载中...</div>
              <div v-else-if="store.children.length === 0" class="table-tip">
                该分组暂无子参数，点击右上角新增
              </div>
              <div
                v-for="item in store.children"
                :key="item.id"
                class="table-row"
                :class="{
                  'drag-active': childDrag.draggingId.value === item.id,
                  'drop-before': childDrag.dropBeforeId.value === item.id,
                  'drop-after': childDrag.dropAfterId.value === item.id,
                }"
                data-drag-row=""
                data-drag-scope="children"
                :data-drag-row-id="item.id"
              >
                <span class="col-handle">
                  <span
                    class="drag-handle"
                    title="拖拽排序"
                    @pointerdown="(event) => startChildDrag(event, item.id)"
                  >
                    <GripVertical :size="14" />
                  </span>
                </span>
                <span class="cell-code" :title="item.paramCode">{{ item.paramCode }}</span>
                <span class="cell-label" :title="item.paramLabel">{{ item.paramLabel }}</span>
                <span class="cell-name" :title="item.paramName">{{ item.paramName }}</span>
                <span class="cell-value" :title="item.paramValue || ''">{{ item.paramValue }}</span>
                <span>
                  <span class="type-badge" :class="PARAM_TYPE_CLASSES[item.paramType]">
                    {{ PARAM_TYPE_LABELS[item.paramType] }}
                  </span>
                </span>
                <span class="cell-time">{{ formatTime(item.updatedAt) }}</span>
                <span class="col-actions">
                  <button class="row-btn" title="编辑" @click="openEdit(item)" aria-label="编辑">
                    <Edit2 :size="13" />
                  </button>
                  <button class="row-btn danger" title="删除" @click="confirmDelete(item)" aria-label="删除">
                    <Trash2 :size="13" />
                  </button>
                </span>
              </div>
            </div>
          </div>
        </template>
      </section>
    </div>
  </div>

  <el-dialog v-model="dialogVisible" :title="dialogTitle" width="620px" append-to-body>
    <div class="param-form">
      <div class="form-row">
        <label class="form-label">所属层级</label>
        <div class="form-readonly">
          {{
            isParentForm
              ? '顶级（父级参数）'
              : '分组：' + (store.selectedParent ? store.selectedParent.paramLabel : '')
          }}
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">参数编码</label>
        <input v-model.trim="form.paramCode" class="form-input" placeholder="例如 mail.host" />
      </div>
      <div class="form-row">
        <label class="form-label">参数标签</label>
        <input
          v-model.trim="form.paramLabel"
          class="form-input"
          placeholder="用于界面展示的短标签"
        />
      </div>
      <div class="form-row">
        <label class="form-label">参数名称</label>
        <input v-model.trim="form.paramName" class="form-input" placeholder="参数名称或说明标题" />
      </div>
      <div class="form-row">
        <label class="form-label">参数类型</label>
        <select v-model="form.paramType" class="form-input">
          <option v-for="type in typeOptions" :key="type" :value="type">
            {{ PARAM_TYPE_LABELS[type] }}
          </option>
        </select>
      </div>
      <div v-if="!isParentForm" class="form-row">
        <label class="form-label">参数值</label>
        <textarea
          v-model="form.paramValue"
          class="form-textarea"
          rows="3"
          placeholder="请输入参数值"
        />
      </div>
      <div class="form-row">
        <label class="form-label">描述</label>
        <textarea
          v-model="form.description"
          class="form-textarea"
          rows="2"
          placeholder="可选，简要说明用途"
        />
      </div>
    </div>
    <template #footer>
      <div class="dialog-footer">
        <button class="btn-ghost" @click="dialogVisible = false">取消</button>
        <button class="btn-primary" @click="saveParam">保存</button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.param-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.param-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 24px 12px;
  flex-shrink: 0;
}
.topbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
}
.topbar-icon {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-primary);
  background: rgba(59, 130, 246, 0.14);
  border-radius: var(--radius-md);
}
.topbar-title {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
}
.topbar-sub {
  margin: 3px 0 0;
  font-size: var(--font-size-sm);
  color: var(--foreground-muted);
}
.topbar-stats {
  font-size: var(--font-size-sm);
  color: var(--foreground-muted);
}

.param-body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 14px;
  padding: 0 24px 24px;
}
.tree-panel {
  width: 330px;
  min-width: 330px;
  display: flex;
  flex-direction: column;
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
.panel-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
}
.panel-count {
  min-width: 20px;
  padding: 1px 6px;
  text-align: center;
  font-size: 11px;
  border-radius: 10px;
  background: rgba(59, 130, 246, 0.14);
  color: var(--accent-primary);
}
.add-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--accent-primary);
  color: #fff;
  font-size: var(--font-size-sm);
  cursor: pointer;
  white-space: nowrap;
  transition: opacity var(--transition-fast);
}
.add-btn:hover {
  opacity: 0.88;
}

.tree-search {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 10px 12px;
  padding: 6px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--surface-primary);
  flex-shrink: 0;
}
.search-icon {
  color: var(--foreground-muted);
  flex-shrink: 0;
}
.search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--foreground-primary);
  font-size: var(--font-size-sm);
}
.search-clear {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: var(--foreground-muted);
  color: var(--surface-primary);
  cursor: pointer;
}
.tree-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 8px 12px;
}
.tree-empty {
  padding: 36px 16px;
  text-align: center;
  font-size: var(--font-size-sm);
  color: var(--foreground-muted);
}
.tree-row {
  position: relative;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto 58px;
  align-items: center;
  gap: 6px;
  padding: 8px 6px;
  border-radius: var(--radius-md);
  cursor: pointer;
  user-select: none;
}
.tree-row:hover {
  background: var(--surface-secondary);
}
.tree-row.selected {
  background: rgba(59, 130, 246, 0.16);
}
.tree-row.drag-active {
  opacity: 0.55;
}
.drop-before::before,
.drop-after::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  height: 2px;
  background: var(--accent-primary);
  pointer-events: none;
}
.drop-before::before {
  top: -1px;
}
.drop-after::after {
  bottom: -1px;
}
.drag-handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--foreground-muted);
  cursor: grab;
  touch-action: none;
}
.drag-handle:active {
  cursor: grabbing;
}
.node-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.node-label {
  font-size: var(--font-size-sm);
  color: var(--foreground-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.node-code {
  font-size: 11px;
  color: var(--foreground-muted);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.child-count {
  min-width: 22px;
  padding: 1px 7px;
  text-align: center;
  font-size: 11px;
  border-radius: 10px;
  background: var(--surface-secondary);
  color: var(--foreground-secondary);
}
.row-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  justify-content: flex-end;
  opacity: 0;
  transition: opacity var(--transition-fast);
}
.tree-row:hover .row-actions {
  opacity: 1;
}
.row-btn {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-secondary);
  cursor: pointer;
}
.row-btn:hover {
  background: rgba(59, 130, 246, 0.14);
  color: var(--accent-primary);
}
.row-btn.danger:hover {
  background: rgba(244, 63, 94, 0.14);
  color: #fb7185;
}

.content-panel {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.content-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--foreground-muted);
  font-size: var(--font-size-sm);
}
.empty-icon {
  color: var(--foreground-muted);
  opacity: 0.6;
}
.content-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
.content-title-wrap {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.content-title {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
}
.content-code {
  font-size: 11px;
  color: var(--foreground-muted);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--surface-secondary);
}
.content-sub {
  font-size: var(--font-size-sm);
  color: var(--foreground-muted);
}
.table-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.param-table {
  min-width: 900px;
}
.table-header,
.table-row {
  display: grid;
  grid-template-columns: 36px 150px 150px 150px minmax(180px, 1fr) 88px 140px 76px;
  align-items: center;
  gap: 8px;
}
.table-header {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 9px 14px;
  background: var(--surface-secondary);
  font-size: 11px;
  color: var(--foreground-muted);
  border-bottom: 1px solid var(--border-subtle);
}
.table-row {
  position: relative;
  padding: 7px 14px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
  user-select: none;
}
.table-row:hover {
  background: var(--surface-secondary);
}
.table-row.drag-active {
  opacity: 0.55;
}
.col-handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.cell-code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  color: var(--foreground-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cell-label,
.cell-name,
.cell-value {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cell-label {
  color: var(--foreground-primary);
}
.cell-value {
  color: var(--foreground-secondary);
}
.cell-time {
  font-size: 12px;
  color: var(--foreground-muted);
  white-space: nowrap;
}
.col-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.table-tip {
  padding: 42px 16px;
  text-align: center;
  font-size: var(--font-size-sm);
  color: var(--foreground-muted);
}
.type-badge {
  display: inline-block;
  padding: 1px 8px;
  font-size: 11px;
  border-radius: 10px;
  white-space: nowrap;
}
.type-group {
  background: rgba(100, 116, 139, 0.16);
  color: #94a3b8;
}
.type-string {
  background: rgba(59, 130, 246, 0.14);
  color: #60a5fa;
}
.type-number {
  background: rgba(245, 158, 11, 0.14);
  color: #fbbf24;
}
.type-boolean {
  background: rgba(139, 92, 246, 0.14);
  color: #a78bfa;
}
.type-json {
  background: rgba(34, 211, 238, 0.14);
  color: #22d3ee;
}

.param-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.form-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.form-label {
  width: 78px;
  flex-shrink: 0;
  padding-top: 8px;
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
  text-align: right;
}
.form-readonly {
  flex: 1;
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  padding: 0 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--surface-secondary);
  color: var(--foreground-muted);
  font-size: var(--font-size-sm);
}
.form-input,
.form-textarea {
  flex: 1;
  width: auto;
  padding: 7px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--surface-primary);
  color: var(--foreground-primary);
  font-size: var(--font-size-sm);
  outline: none;
  resize: vertical;
  font-family: inherit;
}
.form-input:focus,
.form-textarea:focus {
  border-color: var(--accent-primary);
}
.form-textarea {
  min-height: 64px;
}
.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.btn-ghost,
.btn-primary {
  padding: 7px 18px;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  cursor: pointer;
}
.btn-ghost {
  border: 1px solid var(--border-medium);
  background: transparent;
  color: var(--foreground-secondary);
}
.btn-ghost:hover {
  background: var(--surface-secondary);
}
.btn-primary {
  border: none;
  background: var(--accent-primary);
  color: #fff;
}
.btn-primary:hover {
  opacity: 0.9;
}
</style>
