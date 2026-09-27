<script setup lang="ts">
/**
 * 知识库详情弹窗（左栏三点菜单 →「查看详情」）。
 *
 * 内容就是原详情页的"概览"页签（统计卡 / 最近索引活动 / 当前索引方案 / 标签）——
 * 那个页签已经去掉，这里是它唯一的入口，因此左栏**每个分组**都要能打开它。
 *
 * 两条实现上的取舍：
 *
 * 1. **自己拉数据，不碰 store 的选中态**：调用 `store.selectKb` 会重写 `selectedKb`、
 *    重置文档分页、拉图谱并开 SSE——那等于把弹窗背后的详情页一起换掉，"看一眼就走"
 *    的动作不该有这种副作用。这里只读接口，用完即弃。
 * 2. **列表项不够用**：`fetchKnowledgeBase` 返回的 KB 里 `documents` 是空数组
 *    （见 services/knowledgeBaseApi 的 mapKB），直接渲染"最近索引活动"会永远显示
 *    "暂无文档"。所以要多取一页文档并拼进去。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { KB } from '@/types/knowledgeBase'
import * as kbApi from '@/services/knowledgeBaseApi'
import { readApiError } from '@/services/knowledgeBaseApi'
import KbOverviewTab from './KbOverviewTab.vue'

const props = defineProps<{
  visible: boolean
  kbId: string | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const { t } = useI18n()

/** 概览里的"最近索引活动"只展示前 5 篇，取一页刚好 */
const RECENT_LIMIT = 5

const loading = ref(false)
const error = ref<string | null>(null)
const kb = ref<KB | null>(null)

const dialogVisible = computed({
  get: () => props.visible,
  set: (value: boolean) => {
    if (!value) emit('close')
  },
})

watch(
  () => [props.visible, props.kbId] as const,
  ([visible, kbId]) => {
    if (visible && kbId) void load(kbId)
    if (!visible) {
      kb.value = null
      error.value = null
    }
  },
  { immediate: true },
)

async function load(kbId: string) {
  loading.value = true
  error.value = null
  kb.value = null
  try {
    const [detail, docs] = await Promise.all([
      kbApi.fetchKnowledgeBase(kbId),
      // 不带 folder：最近活动是**全库**口径，与该从哪个目录打开无关
      kbApi.fetchDocuments(kbId, { page: 1, page_size: RECENT_LIMIT }),
    ])
    // 竞态守卫：快速连开两个库时，先发的请求可能后回来
    if (props.kbId !== kbId) return
    if (!detail) {
      error.value = t('knowledge.detail.overviewNotFound')
      return
    }
    kb.value = { ...detail, documents: docs.items }
  } catch (err: unknown) {
    if (props.kbId === kbId) error.value = readApiError(err)
  } finally {
    if (props.kbId === kbId) loading.value = false
  }
}
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    :title="kb ? kb.name : t('knowledge.detail.overviewDialogTitle')"
    width="880px"
    append-to-body
    class="kb-overview-dialog"
  >
    <p v-if="kb?.description" class="dialog-desc">{{ kb.description }}</p>

    <div v-if="loading" class="dialog-state">{{ t('knowledge.common.loading') }}</div>
    <div v-else-if="error" class="dialog-state dialog-error">{{ error }}</div>
    <KbOverviewTab v-else-if="kb" :kb="kb" :readonly="!kb.isOwner" />

    <template #footer>
      <el-button @click="emit('close')">{{ t('knowledge.common.close') }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.dialog-desc {
  margin: -6px 0 14px;
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
}

.dialog-state {
  padding: 32px 0;
  text-align: center;
  font-size: var(--font-size-sm);
  color: var(--foreground-muted);
}

.dialog-error {
  color: var(--status-error-text);
}
</style>
