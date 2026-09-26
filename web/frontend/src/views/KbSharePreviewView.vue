<script setup lang="ts">
/**
 * 链接分享的落地页（迭代 6 T6.3）。
 *
 * 三条设计：
 *
 * 1. **未登录也能打开**：先给一份**元信息**（库名/描述/文档数/分享人），让人知道
 *    这是什么再决定要不要接受——只给一个登录页，收到链接的人不知道自己在点什么。
 *    页面上**没有任何正文**，匿名面到此为止；
 * 2. **接受需要登录**：登录后点「接受并打开」，后端会落成一条普通的已接受分享行；
 * 3. **失效只有一种说法**：不存在 / 已撤销 / 已过期在后端是同一个 404，这里也只显示
 *    同一句话——区分它们等于告诉扫链接的人"这个 token 曾经有效"。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Database, FileText, Layers, LogIn, UserCheck } from 'lucide-vue-next'
import { useAuthStore } from '@/stores/auth'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBase'
import { previewShareLink } from '@/services/knowledgeBaseApi'
import type { KBShareLinkPreview } from '@/types/knowledgeBase'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const store = useKnowledgeBaseStore()

const token = computed(() => String(route.params.token ?? ''))
const preview = ref<KBShareLinkPreview | null>(null)
const loading = ref(true)
const accepting = ref(false)
const error = ref('')

onMounted(async () => {
  try {
    preview.value = await previewShareLink(token.value)
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : '分享链接不存在或已失效'
  } finally {
    loading.value = false
  }
})

function goLogin() {
  // 带上 redirect，登录后回到本页继续接受
  void router.push({ name: 'login', query: { redirect: route.fullPath } })
}

async function accept() {
  if (accepting.value) return
  accepting.value = true
  try {
    const result = await store.acceptShareLink(token.value)
    ElMessage.success(
      result.already ? '你已经在共享名单里了' : '已加入，可在「知识库 → 共享给我的」中查看',
    )
    void router.push('/knowledge-base')
  } catch (err: unknown) {
    ElMessage.error(err instanceof Error ? err.message : '接受失败，请稍后重试')
  } finally {
    accepting.value = false
  }
}
</script>

<template>
  <div class="share-preview-page">
    <div class="preview-card">
      <div v-if="loading" class="preview-state">正在打开分享…</div>

      <!-- 失效：与后端的统一 404 同一句话 -->
      <div v-else-if="error" class="preview-state is-error">
        <div class="state-title">无法打开该分享</div>
        <div class="state-desc">{{ error }}</div>
        <div class="state-hint">链接可能已被撤销或过期，请联系分享人重新获取。</div>
      </div>

      <template v-else-if="preview">
        <div class="preview-header">
          <div class="preview-icon"><Database :size="22" /></div>
          <div>
            <h1 class="preview-title">{{ preview.kbName }}</h1>
            <p class="preview-owner">
              <template v-if="preview.ownerName">{{ preview.ownerName }} 分享</template>
              <template v-else>有人分享了这份知识库</template>
              <span class="preview-perm">{{ preview.permission === 'write' ? '（可写）' : '（只读）' }}</span>
            </p>
          </div>
        </div>

        <p v-if="preview.description" class="preview-desc">{{ preview.description }}</p>

        <div class="preview-stats">
          <span class="stat"><FileText :size="14" />{{ preview.docsCount }} 篇文档</span>
          <span class="stat"><Layers :size="14" />{{ preview.chunksCount }} 个切片</span>
        </div>

        <p class="preview-notice">
          登录后即可查看该知识库的内容（搜索、浏览与检索）。
        </p>

        <div class="preview-actions">
          <button v-if="auth.isAuthenticated" class="btn-primary" :disabled="accepting" @click="accept">
            <UserCheck :size="16" />{{ accepting ? '正在加入…' : '接受并打开' }}
          </button>
          <button v-else class="btn-primary" @click="goLogin">
            <LogIn :size="16" />登录后接受
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.share-preview-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--background-secondary, #f5f7fa);
}

.preview-card {
  width: 100%;
  max-width: 460px;
  padding: 28px;
  border-radius: 12px;
  background: var(--surface-card, #fff);
  border: 1px solid var(--border-subtle, #e5e7eb);
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.preview-state {
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
  text-align: center;
}

.preview-state.is-error .state-title {
  font-size: var(--font-size-base);
  color: var(--foreground-primary);
  margin-bottom: 8px;
}

.state-desc {
  color: var(--el-color-danger, #f56c6c);
  margin-bottom: 6px;
}

.state-hint {
  font-size: var(--font-size-xs, 12px);
}

.preview-header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.preview-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: var(--el-color-primary-light-9, #ecf5ff);
  color: var(--el-color-primary, #409eff);
  flex-shrink: 0;
}

.preview-title {
  margin: 0;
  font-size: 18px;
  color: var(--foreground-primary);
}

.preview-owner {
  margin: 4px 0 0;
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
}

.preview-perm {
  color: var(--el-color-primary, #409eff);
}

.preview-desc {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
  line-height: 1.6;
}

.preview-stats {
  display: flex;
  gap: 16px;
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
}

.stat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.preview-notice {
  margin: 0;
  font-size: var(--font-size-xs, 12px);
  color: var(--foreground-secondary);
}

.preview-actions {
  display: flex;
  justify-content: flex-end;
}

.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 18px;
  border: none;
  border-radius: 8px;
  background: var(--el-color-primary, #409eff);
  color: #fff;
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
