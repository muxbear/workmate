<script setup lang="ts">
/** 分享知识库——搜索并邀请用户，被邀请人接受后可**只读**浏览。 */
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBase'
import { searchShareCandidates } from '@/services/knowledgeBaseApi'
import type { KB, KBShare } from '@/types/knowledgeBase'

const props = defineProps<{
  visible: boolean
  kb: KB | null
}>()

const emit = defineEmits<{ (e: 'close'): void; (e: 'shared'): void }>()

const store = useKnowledgeBaseStore()

const candidates = ref<KBShare[]>([])
const selected = ref<string[]>([])
const searching = ref(false)
const submitting = ref(false)

watch(() => props.visible, (v) => {
  if (v) {
    selected.value = []
    void runSearch('')
  }
})

async function runSearch(keyword: string) {
  searching.value = true
  try {
    candidates.value = await searchShareCandidates(keyword)
  } catch (err: unknown) {
    // 此前静默置空：接口 404/500 时用户只看到"搜不到任何人"，没有任何线索
    candidates.value = []
    ElMessage.error(err instanceof Error ? err.message : '加载可分享用户失败')
  } finally {
    searching.value = false
  }
}

async function handleSubmit() {
  if (!props.kb || !selected.value.length) {
    ElMessage.warning('请先选择要分享的用户')
    return
  }
  submitting.value = true
  try {
    await store.inviteShares(props.kb.id, selected.value)
    ElMessage.success('邀请已发送，等待对方接受')
    emit('shared')
    emit('close')
  } catch (err: unknown) {
    ElMessage.error(err instanceof Error ? err.message : '分享失败')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    title="分享知识库"
    width="480px"
    @update:model-value="(v: boolean) => !v && emit('close')"
  >
    <div class="share-body">
      <p class="share-tip">
        邀请用户浏览「{{ kb?.name }}」。对方接受后可在
        <b>知识库 → 共享给我的</b> 中查询、浏览与检索，但不能上传或修改内容。
      </p>

      <el-select
        v-model="selected"
        multiple
        filterable
        remote
        reserve-keyword
        :remote-method="runSearch"
        :loading="searching"
        placeholder="搜索用户名或昵称"
        class="share-select"
      >
        <el-option
          v-for="u in candidates"
          :key="u.userId"
          :label="u.nickname || u.username || u.userId"
          :value="u.userId"
        >
          <span>{{ u.nickname || u.username }}</span>
          <span v-if="u.username" class="opt-sub">@{{ u.username }}</span>
        </el-option>
      </el-select>
    </div>

    <template #footer>
      <el-button @click="emit('close')">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="handleSubmit">
        发送邀请
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.share-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.share-tip {
  margin: 0;
  color: var(--foreground-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.6;
}

.share-select {
  width: 100%;
}

.opt-sub {
  margin-left: 8px;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
}
</style>
