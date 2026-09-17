<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import ConfirmDialog from '../../ConfirmDialog.vue'
import KnowledgeConfigForm from '../../knowledge/KnowledgeConfigForm.vue'
import { useSettingsStore, type SettingsKey } from '../../../store/settings'
import {
  createDraft,
  draftValueToOverride,
  KNOWLEDGE_FIELD_LIST,
  type KnowledgeDraft,
  type KnowledgeDraftValue
} from '../../knowledge/knowledgeFields'
import type { KnowledgeOverrideKey } from '../../../../../preload/index.d'

/**
 * 「知识库设置」页（全局配置）
 *
 * 表单主体是共享的 KnowledgeConfigForm（与「按知识库设置」弹窗同一份实现），本页只负责：
 * 草稿回填、组装 payload、保存到全局设置，以及本地存储目录（该卡片仅在此页出现）。
 */

const settingsStore = useSettingsStore()

/** 表单草稿：进入页面时由 store 回填，点「保存设置」才写回主进程 */
const draft = reactive<KnowledgeDraft>(createDraft({}))
/** 本地存储目录（全局项：索引库位置按机器维度，不参与按知识库覆盖） */
const directory = ref('')

/** 从 store 同步草稿（挂载时、以及主进程设置加载完成后回填） */
function syncFromStore(): void {
  Object.assign(draft, createDraft(settingsStore.knowledgeGlobalValues))
  // 设置为空时回填主进程解析的默认目录（与设计稿一致：输入框展示具体路径而非占位符）
  directory.value =
    settingsStore.knowledgeDirectory || settingsStore.meta?.defaultKnowledgeDir || ''
}

onMounted(() => {
  syncFromStore()
})

// 主进程设置加载可能晚于本页挂载，加载完成后回填草稿
watch(
  () => settingsStore.loaded,
  (ready) => {
    if (ready) syncFromStore()
  }
)

/** 轻量 toast（保存反馈） */
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null
function showToast(text: string): void {
  toast.value = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = ''
  }, 1800)
}

function onFieldChange(key: KnowledgeOverrideKey, value: KnowledgeDraftValue): void {
  draft[key] = value
}

/** 组装待写入项；任一数值项非法则提示并返回 null（不保存） */
function buildPayload(): Array<[SettingsKey, unknown]> | null {
  const payload: Array<[SettingsKey, unknown]> = [['knowledge.directory', directory.value]]
  for (const field of KNOWLEDGE_FIELD_LIST) {
    const result = draftValueToOverride(field, draft[field.key])
    if ('error' in result) {
      showToast(`保存失败：${result.error}`)
      return null
    }
    payload.push([`knowledge.${field.key}` as SettingsKey, result.value])
  }
  return payload
}

const saving = ref(false)

async function onSave(): Promise<void> {
  const payload = buildPayload()
  if (!payload) return
  saving.value = true
  const ok = await settingsStore.saveMany(payload)
  saving.value = false
  if (!ok) {
    showToast('保存失败：主进程校验未通过')
    return
  }
  syncFromStore()
  showToast('知识库设置已保存')
}

/** 目录切换确认：切换后旧目录的索引库不再可见（不迁移），先确认再打开对话框 */
const dirConfirmOpen = ref(false)

function onSelectDirectory(): void {
  dirConfirmOpen.value = true
}

async function onConfirmSelectDirectory(): Promise<void> {
  dirConfirmOpen.value = false
  await pickDirectory()
}

/** 选择知识库目录（系统原生对话框；取消不改动） */
async function pickDirectory(): Promise<void> {
  try {
    await settingsStore.changeKnowledgeDir()
    directory.value = settingsStore.knowledgeDirectory
  } catch (err) {
    console.warn('[knowledge] select dir failed:', err)
    showToast('选择目录失败')
  }
}
</script>

<template>
  <div class="s-page kb-page">
    <!-- 说明 + 保存 -->
    <div class="kb-header">
      <div>
        <p class="kb-intro">这些配置将用于主页面“知识库”的文件处理、索引构建与问答检索。</p>
        <p class="kb-intro-sub">修改后仅影响后续新增或重新索引的文件。</p>
        <p class="kb-intro-warn">
          索引与检索能力开发中：当前「文件上传」「本地存储」配置已生效；「RAG
          索引」「混合检索与重排」「知识图谱抽取」暂不生效。
        </p>
      </div>
      <button class="s-btn s-btn--primary kb-save" :disabled="saving" @click="onSave">
        保存设置
      </button>
    </div>

    <!-- 配置卡片（与「按知识库设置」弹窗共用同一份实现） -->
    <KnowledgeConfigForm
      :draft="draft"
      :directory="directory"
      @change="onFieldChange"
      @update:directory="directory = $event"
      @select-directory="onSelectDirectory"
    />

    <!-- 目录切换二次确认（换目录不迁移旧索引库） -->
    <ConfirmDialog
      v-if="dirConfirmOpen"
      title="切换知识库目录"
      message="切换后新目录会成为知识库的存放位置，旧目录中的知识库不会自动迁移（需手工迁回或重新导入），确认继续选择吗？"
      confirm-text="继续选择"
      @confirm="onConfirmSelectDirectory"
      @cancel="dirConfirmOpen = false"
    />

    <!-- 保存反馈 -->
    <Transition name="kb-toast">
      <div v-if="toast" class="kb-toast">
        {{ toast }}
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.s-page {
  max-width: 1060px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding-bottom: 40px;
}

/* ═══════════════════ 顶部说明 + 保存 ═══════════════════ */
.kb-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
}

.kb-intro {
  font-size: 14px;
  line-height: 1.7;
  color: var(--kw-color-text-muted);
}

.kb-intro-warn {
  margin-top: 8px;
  font-size: 12px;
  line-height: 18px;
  color: #b45309;
}

.kb-intro-sub {
  margin-top: 4px;
  font-size: 12px;
  color: var(--kw-color-text-faint);
}

.kb-save {
  flex-shrink: 0;
  padding: 8px 16px;
  font-size: 14px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
}

.kb-save:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* ═══════════════════ 保存 toast ═══════════════════ */
.kb-toast {
  position: fixed;
  bottom: 32px;
  left: 50%;
  transform: translateX(-50%);
  background: #2c3337;
  color: #fff;
  padding: 10px 20px;
  border-radius: 999px;
  font-size: 14px;
  z-index: 9999;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
}

.kb-toast-enter-active,
.kb-toast-leave-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s ease;
}

.kb-toast-enter-from,
.kb-toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}
</style>
