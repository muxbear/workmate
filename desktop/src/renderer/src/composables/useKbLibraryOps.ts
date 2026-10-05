import { ref, type Ref } from 'vue'
import { useKnowledgeStore } from '@store/knowledge'
import { useKnowledgeSettingsStore } from '@store/knowledgeSettings'
import type { KnowledgeFolder } from '@renderer/components/knowledge/knowledgeList'

/**
 * 知识库条目操作（R6：自 KnowledgePage 外提）。
 *
 * 侧栏条目三点菜单的状态（同一时刻只允许一个）+ 编辑 / 设置 / 删除三个弹窗的目标与提交；
 * 删除确认会级联清理页面侧的标签与索引进度目标（经 Ref 注入），并同步清理
 * 渲染层的按库配置缓存（主进程已清 kb-settings.json）。
 */

export interface KbLibraryOpsDeps {
  /** 打开的标签页（删除知识库后收敛为常驻「问答」） */
  openTabs: Ref<string[]>
  /** 当前激活标签 */
  activeTab: Ref<string>
  /** 索引进度目标（删除知识库后清空） */
  pipelineTarget: Ref<{ kbId: string; relPath: string } | null>
  /** 轻提示（toast） */
  notify: (text: string) => void
}

export function useKbLibraryOps(deps: KbLibraryOpsDeps) {
  const kbStore = useKnowledgeStore()
  const knowledgeSettingsStore = useKnowledgeSettingsStore()

  /** 当前展开三点菜单的知识库 id（同一时刻只允许一个） */
  const openLibMenu = ref<string | null>(null)
  /** 知识库设置弹窗目标（按库覆盖配置） */
  const settingsLibrary = ref<KnowledgeFolder | null>(null)
  const settingsOpen = ref(false)
  /** 知识库编辑弹窗目标 */
  const editLibrary = ref<KnowledgeFolder | null>(null)
  const editOpen = ref(false)
  /** 待确认删除的知识库 */
  const deleteCandidate = ref<KnowledgeFolder | null>(null)

  const openEditLibrary = (library: KnowledgeFolder): void => {
    openLibMenu.value = null
    editLibrary.value = library
    editOpen.value = true
  }

  /** 编辑保存（名称 + 描述）：写主进程，成功后按返回值刷新列表 */
  const saveLibraryEdit = async (name: string, description: string): Promise<void> => {
    const target = editLibrary.value
    editLibrary.value = null
    if (!target) return
    const ok = await kbStore.updateBase(target.id, { name, description })
    deps.notify(ok ? `已更新「${name}」` : kbStore.lastError || '保存失败')
  }

  const openLibrarySettings = (library: KnowledgeFolder): void => {
    openLibMenu.value = null
    settingsLibrary.value = library
    settingsOpen.value = true
  }

  const askDeleteLibrary = (library: KnowledgeFolder): void => {
    openLibMenu.value = null
    deleteCandidate.value = library
  }

  /** 删除确认：主进程级联清理文档与磁盘，再清渲染层的按库配置缓存 */
  const confirmDeleteLibrary = async (): Promise<void> => {
    const target = deleteCandidate.value
    deleteCandidate.value = null
    if (!target) return
    const ok = await kbStore.removeBase(target.id)
    if (!ok) {
      deps.notify(kbStore.lastError || '删除失败')
      return
    }
    // 主进程已清 kb-settings.json；渲染层同步清缓存，避免弹窗仍显示旧覆盖
    await knowledgeSettingsStore.saveOverrides(target.id, {})
    deps.openTabs.value = ['问答']
    deps.activeTab.value = '问答'
    deps.pipelineTarget.value = null
    deps.notify(`已删除「${target.name}」`)
  }

  const onLibrarySettingsSaved = (name: string): void => {
    deps.notify(`「${name}」设置已保存`)
  }

  return {
    openLibMenu,
    settingsLibrary,
    settingsOpen,
    editLibrary,
    editOpen,
    deleteCandidate,
    openEditLibrary,
    saveLibraryEdit,
    openLibrarySettings,
    askDeleteLibrary,
    confirmDeleteLibrary,
    onLibrarySettingsSaved
  }
}
