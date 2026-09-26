<script setup lang="ts">
/** 分享知识库——搜索并邀请用户；可选**只读/可写**与**有效期**。 */
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBase'
import { searchShareCandidates } from '@/services/knowledgeBaseApi'
import type { KB, KBShare, ShareExpiresIn } from '@/types/knowledgeBase'

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

//: 权限与有效期（迭代 6 T6.3）。**可写只放开内容操作**（上传/删文档/改切片），
//: 改配置、重建、分享、删库仍仅库主——文案里要说清，否则用户以为"可写=全权"
const permission = ref<'read' | 'write'>('read')
const expiresIn = ref<ShareExpiresIn>('never')
const EXPIRES_OPTIONS: { value: ShareExpiresIn; label: string }[] = [
  { value: '1d', label: '1 天' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: 'never', label: '永久有效' },
]

watch(() => props.visible, (v) => {
  if (v) {
    selected.value = []
    permission.value = 'read'
    expiresIn.value = 'never'
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
    await store.inviteShares(props.kb.id, selected.value, {
      permission: permission.value, expiresIn: expiresIn.value,
    })
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
        邀请用户访问「{{ kb?.name }}」。对方接受后可在
        <b>知识库 → 共享给我的</b> 中查询、浏览与检索。
        <template v-if="permission === 'read'">
          当前为<b>只读</b>：不能上传或修改内容。
        </template>
        <template v-else>
          当前为<b>可写</b>：可以上传、删除文档与编辑切片；
          <b>但不能改索引配置、重建索引、分享或删除知识库</b>。
        </template>
      </p>

      <!-- 权限与有效期（迭代 6 T6.3） -->
      <div class="share-options">
        <div class="option-item">
          <span class="option-label">权限</span>
          <el-radio-group v-model="permission" size="small">
            <el-radio value="read">只读</el-radio>
            <el-radio value="write">可写</el-radio>
          </el-radio-group>
        </div>
        <div class="option-item">
          <span class="option-label">有效期</span>
          <el-select v-model="expiresIn" size="small" class="expires-select">
            <el-option
              v-for="opt in EXPIRES_OPTIONS"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>
        </div>
      </div>

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
.share-options {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle, #e5e7eb);
  border-radius: 8px;
}

.option-item {
  display: flex;
  align-items: center;
  gap: 12px;
}

.option-label {
  width: 48px;
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
}

.expires-select {
  width: 140px;
}

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
