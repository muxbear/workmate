<script setup lang="ts">
import type { KnowledgeFolder } from './knowledgeList'
import type { KnowledgeBaseSummary, KnowledgeStats } from '../../../../shared/contracts'
import KnowledgeEditModal from './KnowledgeEditModal.vue'
import KnowledgeSettingsModal from './KnowledgeSettingsModal.vue'
import KnowledgeUploadModal from './KnowledgeUploadModal.vue'
import KnowledgeDetailModal from './KnowledgeDetailModal.vue'
import KnowledgeSearchModal from './KnowledgeSearchModal.vue'
import KnowledgeGraphModal from './KnowledgeGraphModal.vue'
import KnowledgeRenameModal from './KnowledgeRenameModal.vue'
import KnowledgeShareModal from './KnowledgeShareModal.vue'
import KnowledgeCreateModal from './KnowledgeCreateModal.vue'
import KnowledgeOverviewModal from './KnowledgeOverviewModal.vue'
import ConfirmDialog from '../ConfirmDialog.vue'
import type { useKbLibraryOps } from '@renderer/composables/useKbLibraryOps'
import type { useKbUploads } from '@renderer/composables/useKbUploads'
import type { useKbDocOps } from '@renderer/composables/useKbDocOps'
import type { useKbGroups } from '@renderer/composables/useKbGroups'
import type { useKbFileOps } from '@renderer/composables/useKbFileOps'

/**
 * 知识库弹窗宿主（R6：自 KnowledgePage 模板外提）。
 *
 * 13 个弹窗集中绑定（编辑/按库设置/上传/删除确认×2/详情/检索调试/图谱/重命名×2/
 * 共享/新建/概览）。接口范式：**注入组合件 API 对象**（各弹窗的开关与提交本就是
 * 组合件行为），页面只补上下文（当前库、概览数据）与概览关闭事件。
 */
defineProps<{
  libraryOps: ReturnType<typeof useKbLibraryOps>
  uploads: ReturnType<typeof useKbUploads>
  docOps: ReturnType<typeof useKbDocOps>
  fileOps: ReturnType<typeof useKbFileOps>
  groups: ReturnType<typeof useKbGroups>
  /** 当前选中知识库（上传/概览弹窗上下文） */
  selectedLibrary: KnowledgeFolder
  /** 当前选中知识库 id（检索调试/图谱上下文） */
  selectedKbId: string
  /** 概览弹窗开关（页面的 openOverview 还负责拉取 stats） */
  overviewOpen: boolean
  /** 概览统计与库列表（来自 knowledge store） */
  stats: KnowledgeStats | null
  bases: KnowledgeBaseSummary[]
}>()

const emit = defineEmits<{ closeOverview: [] }>()
</script>

<template>
  <!-- 知识库编辑 / 按库设置弹窗 + 删除确认 -->
  <KnowledgeEditModal
    :open="libraryOps.editOpen.value"
    :library="libraryOps.editLibrary.value"
    @close="libraryOps.editOpen.value = false"
    @saved="libraryOps.saveLibraryEdit"
  />
  <KnowledgeSettingsModal
    :open="libraryOps.settingsOpen.value"
    :library="libraryOps.settingsLibrary.value"
    @close="libraryOps.settingsOpen.value = false"
    @saved="libraryOps.onLibrarySettingsSaved"
  />
  <KnowledgeUploadModal
    :open="uploads.uploadOpen.value"
    :library="selectedLibrary"
    @close="uploads.uploadOpen.value = false"
    @submit="uploads.onUploadSubmit"
  />
  <ConfirmDialog
    v-if="libraryOps.deleteCandidate.value"
    title="删除知识库"
    :message="`确定删除「${libraryOps.deleteCandidate.value.name}」吗？该知识库的按库设置会一并清除，此操作不可撤销。`"
    confirm-text="删除"
    @confirm="libraryOps.confirmDeleteLibrary"
    @cancel="libraryOps.deleteCandidate.value = null"
  />
  <ConfirmDialog
    v-if="docOps.deleteFileNode.value"
    title="删除文件"
    :message="`确定删除「${docOps.deleteFileNode.value.name}」吗？${
      docOps.deleteFileNode.value.kind === 'folder' ? '该文件夹及其中的文件会' : '该文件会'
    }从当前知识库移除，此操作不可撤销。`"
    confirm-text="删除"
    @confirm="docOps.confirmDeleteFile"
    @cancel="docOps.deleteFileNode.value = null"
  />
  <KnowledgeDetailModal
    :open="fileOps.detailOpen.value"
    :title="fileOps.detailTitle.value"
    :items="fileOps.detailItems.value"
    @close="fileOps.detailOpen.value = false"
  />
  <KnowledgeSearchModal
    :open="docOps.searchOpen.value"
    :kb-id="selectedKbId"
    :library-name="selectedLibrary?.name"
    @close="docOps.searchOpen.value = false"
  />
  <KnowledgeGraphModal
    :open="docOps.graphOpen.value"
    :kb-id="selectedKbId"
    :library-name="selectedLibrary?.name"
    @close="docOps.graphOpen.value = false"
  />
  <KnowledgeRenameModal
    :open="fileOps.fileRenameOpen.value"
    :current="fileOps.renameTarget.value?.name ?? ''"
    title="重新命名"
    :hint="
      fileOps.renameTarget.value?.kind === 'folder'
        ? '重命名文件夹后，其中文件的路径会一起更新。'
        : '重命名后，列表与预览标签页中的名称会同步更新。'
    "
    @close="fileOps.fileRenameOpen.value = false"
    @submit="fileOps.submitFileRename"
  />
  <KnowledgeRenameModal
    :open="docOps.libraryRenameOpen.value"
    :current="selectedLibrary.name"
    title="重命名知识库"
    label="知识库名称"
    hint="重命名只改显示名称，知识库中的文件与索引设置不受影响。"
    @close="docOps.libraryRenameOpen.value = false"
    @submit="docOps.submitLibraryRename"
  />
  <KnowledgeShareModal
    :open="docOps.shareOpen.value"
    :target-name="docOps.shareName.value"
    :target-kind="docOps.shareKind.value"
    :target-id="docOps.shareTargetId.value"
    @close="docOps.shareOpen.value = false"
    @created="docOps.onShareCreated"
  />

  <!-- 新建知识库 / 概览 -->
  <KnowledgeCreateModal
    :open="groups.createOpen.value"
    :kind="groups.createKind.value"
    @close="groups.createOpen.value = false"
    @submit="groups.onCreateLibrary"
  />
  <KnowledgeOverviewModal
    :open="overviewOpen"
    :stats="stats"
    :libraries="bases"
    @close="emit('closeOverview')"
  />
</template>
