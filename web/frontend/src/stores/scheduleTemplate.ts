import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  createTemplate,
  deleteTemplate,
  fetchTemplateTypes,
  fetchTemplates,
  updateTemplate,
} from '@/services/scheduleTemplateApi'
import { extractErrorMessage } from '@/services/request'
import { toTaskDraft } from '@/types/scheduleTemplate'
import { DEFAULT_PAGE_SIZE } from '@/types/pagination'
import {
  type ScheduleTemplate,
  type ScheduleTemplateDraft,
  type TemplateTypeOption,
} from '@/types/scheduleTemplate'
import { useAutomationStore } from '@/stores/automation'

/** 列表展示形态：卡片 / 表格 */
export type TemplateViewMode = 'card' | 'table'

export const useScheduleTemplateStore = defineStore('scheduleTemplate', () => {
  const automation = useAutomationStore()

  const templates = ref<ScheduleTemplate[]>([])
  const types = ref<TemplateTypeOption[]>([])
  const total = ref(0)
  const page = ref(1)
  const pageSize = ref<number>(DEFAULT_PAGE_SIZE)
  const keyword = ref('')
  const categoryFilter = ref('')
  const viewMode = ref<TemplateViewMode>('card')
  const loading = ref(false)
  const error = ref('')

  /** 是否还有下一页（表格与卡片两种形态共用同一份分页状态） */
  const totalPages = computed(() =>
    total.value > 0 ? Math.ceil(total.value / pageSize.value) : 0,
  )

  /** 当前筛选出的类型名（用于空态文案） */
  const activeCategoryLabel = computed(() => {
    if (!categoryFilter.value) return ''
    return types.value.find((item) => item.value === categoryFilter.value)?.label ?? ''
  })

  async function loadTemplates(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const data = await fetchTemplates({
        page: page.value,
        pageSize: pageSize.value,
        keyword: keyword.value,
        category: categoryFilter.value,
      })
      templates.value = data.items ?? []
      total.value = data.total ?? 0
      // 后端可能因为筛选变化把我们「顶」回上一页
      if (data.page && data.page !== page.value) page.value = data.page
    } catch (err) {
      error.value = extractErrorMessage(err)
      templates.value = []
      total.value = 0
    } finally {
      loading.value = false
    }
  }

  async function loadTypes(): Promise<void> {
    try {
      types.value = await fetchTemplateTypes()
    } catch {
      // 类型拿不到不该把整页打挂：筛选区会退化成只有「全部」
      types.value = []
    }
  }

  async function create(draft: ScheduleTemplateDraft): Promise<ScheduleTemplate> {
    const created = await createTemplate(draft)
    await loadTemplates()
    return created
  }

  async function update(id: string, draft: ScheduleTemplateDraft): Promise<ScheduleTemplate> {
    const updated = await updateTemplate(id, draft)
    await loadTemplates()
    return updated
  }

  async function remove(id: string): Promise<void> {
    await deleteTemplate(id)
    // 删掉当页最后一条时回退一页，避免停在空页
    if (templates.value.length === 1 && page.value > 1) page.value -= 1
    await loadTemplates()
  }

  function resetPage(): void {
    page.value = 1
  }

  // ── 添加到定时任务 ─────────────────────────────────────────

  /**
   * 哪些模板已经被用过。直接看当前用户的任务列表——这样「已添加」与
   * 定时任务页展示的数据永远同源，不会出现两处状态对不上。
   */
  const addedTemplateIds = computed(() => automation.usedTemplateIds)

  /** 正在添加的模板 id（按钮转圈用） */
  const addingId = ref<string | null>(null)

  /** 拉一次任务列表，才能判断哪些模板已添加 */
  async function loadAddedState(): Promise<void> {
    try {
      await automation.loadTasks()
    } catch {
      // 任务列表拿不到就一律按「未添加」展示，点了会由后端再兜一次
    }
  }

  /**
   * 用模板生成一个定时任务。
   *
   * 同一个模板可以重复添加（想要两个不同排期的任务也合理），但按钮在添加成功
   * 后置灰，避免连点造成重复。
   */
  async function addToTasks(template: ScheduleTemplate): Promise<void> {
    addingId.value = template.id
    try {
      await automation.createTask(toTaskDraft(template))
    } finally {
      addingId.value = null
    }
  }

  return {
    templates,
    types,
    total,
    page,
    pageSize,
    keyword,
    categoryFilter,
    viewMode,
    loading,
    error,
    totalPages,
    activeCategoryLabel,
    loadTemplates,
    loadTypes,
    create,
    update,
    remove,
    resetPage,
    addedTemplateIds,
    addingId,
    loadAddedState,
    addToTasks,
  }
})
