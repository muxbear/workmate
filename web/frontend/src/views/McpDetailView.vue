<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Download, Star, Clock, Check } from 'lucide-vue-next'
import { useMcpStore } from '@/stores/mcp'

const route = useRoute()
const router = useRouter()
const mcpStore = useMcpStore()

const activeTab = ref('overview')

const configTab = ref<'remote' | 'stdio'>('remote')
const remoteTransport = ref('streamable_http')

const remoteConfigSnippet = computed(() => {
  const tool = mcpStore.currentTool
  const fallbackUrl =
    remoteTransport.value === 'streamable_http'
      ? "http://127.0.0.1:8001/mcp/web-search-http/mcp"
      : "http://127.0.0.1:8001/mcp/web-search/sse"
  const url =
    (remoteTransport.value === 'streamable_http'
      ? tool?.streamable_http_url || tool?.url
      : tool?.sse_url || tool?.url) || fallbackUrl

  return [
    '{',
    '  "mcpServers": {',
    `    "${mcpStore.currentTool?.name || 'fetch'}": {`,
    `      "type": "${remoteTransport.value}",`,
    `      "url": "${url}"`,
    '    }',
    '  }',
    '}',
  ].join('\n')
})

const stdioConfigSnippet = computed(() => {
  const tool = mcpStore.currentTool
  const name = tool?.name || 'fetch'
  const command = tool?.command || 'uvx'
  const args = tool?.args?.length ? tool.args : ['mcp-server-fetch']
  return [
    '{',
    '  "mcpServers": {',
    `    "${name}": {`,
    `      "args": ${JSON.stringify(args)},`,
    `      "command": "${command}"`,
    '    }',
    '  }',
    '}',
  ].join('\n')
})

const tabs = [
  { key: 'overview', label: '概述' },
  { key: 'tools', label: '工具' },
  { key: 'usage', label: '使用说明' },
  { key: 'reviews', label: '评价' },
]

function goBack() {
  router.push({ name: 'mcp-square' })
}


function formatInstallCount(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`
  }
  return String(count)
}

onMounted(() => {
  const id = route.params.id as string
  mcpStore.fetchToolById(id)
})

watch(
  () => route.params.id,
  (newId) => {
    if (newId) mcpStore.fetchToolById(newId as string)
  },
)
</script>

<template>
  <div class="mcp-detail">
    <div v-if="mcpStore.detailLoading" class="loading-wrap">
      <el-skeleton :rows="10" animated />
    </div>

    <template v-else-if="mcpStore.currentTool">
      <!-- Breadcrumb -->
      <div class="breadcrumb">
        <button class="back-link" @click="goBack">
          <ArrowLeft :size="16" />
          返回 MCP 广场
        </button>
        <span class="sep">/</span>
        <span class="current-page">{{ mcpStore.currentTool.name }}</span>
      </div>

      <!-- Header Card -->
      <div class="header-card">
        <div class="header-left">
          <div class="large-icon">
            <span class="large-icon-text">{{ mcpStore.currentTool.icon }}</span>
          </div>
          <div class="header-info">
            <div class="name-row">
              <h1 class="tool-name">{{ mcpStore.currentTool.name }}</h1>
              <span v-if="mcpStore.currentTool.official" class="official-badge">官方</span>
              <span class="version-badge">{{ mcpStore.currentTool.version }}</span>
            </div>
            <div class="meta-row">
              <span>{{ mcpStore.currentTool.author }}</span>
              <span class="meta-sep">·</span>
              <span>
                <Download :size="13" />
                {{ formatInstallCount(mcpStore.currentTool.installs) }} 次安装
              </span>
              <span class="meta-sep">·</span>
              <span class="rating-meta">
                <Star :size="13" />
                {{ mcpStore.currentTool.rating }}
              </span>
              <span class="meta-sep">·</span>
              <span>
                <Clock :size="13" />
                {{ mcpStore.currentTool.updated_at }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Tab Bar -->
      <div class="tab-bar">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="tab-btn"
          :class="{ active: activeTab === tab.key }"
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
        </button>
      </div>

      <!-- Tab Content -->
      <div class="tab-content">
        <!-- Overview Tab -->
        <div v-if="activeTab === 'overview'" class="two-columns">
          <div class="left-col">
            <div class="content-card">
              <h3 class="card-title">简介</h3>
              <p class="card-desc">{{ mcpStore.currentTool.description }}</p>
            </div>

            <div class="content-card">
              <h3 class="card-title">核心功能</h3>
              <ul class="feature-list">
                <li v-for="(feat, i) in mcpStore.currentTool.features" :key="i">
                  <Check :size="14" class="check-icon" />
                  {{ feat }}
                </li>
              </ul>
            </div>
          </div>

          <div class="right-col">
            <div class="content-card">
              <div class="config-tabs">
                <button
                  class="config-tab-btn"
                  :class="{ active: configTab === 'remote' }"
                  @click="configTab = 'remote'"
                >
                  Remote
                </button>
                <button
                  class="config-tab-btn"
                  :class="{ active: configTab === 'stdio' }"
                  @click="configTab = 'stdio'"
                >
                  Stdio
                </button>
              </div>

              <div v-if="configTab === 'remote'" class="config-panel">
                <label class="config-field-label">传输类型</label>
                <el-select v-model="remoteTransport" class="transport-select">
                  <el-option label="Streamable HTTP" value="streamable_http" />
                  <el-option label="SSE" value="sse" />
                </el-select>
                <pre class="config-code">{{ remoteConfigSnippet }}</pre>
              </div>

              <div v-else class="config-panel">
                <pre class="config-code">{{ stdioConfigSnippet }}</pre>
              </div>
            </div>

            <div class="content-card">
              <h3 class="card-title">分类标签</h3>
              <div class="tags-row">
                <span
                  v-for="tag in mcpStore.currentTool.tags"
                  :key="tag"
                  class="tag"
                >
                  {{ tag }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- Tools Tab -->
        <div v-if="activeTab === 'tools'" class="content-card">
          <h3 class="card-title">工具列表</h3>
          <div v-if="mcpStore.currentTool.tools.length > 0" class="tool-list">
            <div
              v-for="tool in mcpStore.currentTool.tools"
              :key="tool.name"
              class="tool-item"
            >
              <div class="tool-item-icon">{{ tool.icon }}</div>
              <div class="tool-item-body">
                <div class="tool-item-name">{{ tool.name }}</div>
                <p class="tool-item-desc">{{ tool.description }}</p>
              </div>
            </div>
          </div>
          <el-empty v-else description="暂无工具" />
        </div>

        <!-- Usage Tab -->
        <div v-if="activeTab === 'usage'" class="content-card">
          <h3 class="card-title">使用说明</h3>
          <p class="card-desc">MCP 服务通过标准 MCP 协议接入，支持 Remote 和 Stdio 两种连接方式。</p>

          <div class="usage-section">
            <h4 class="usage-title">Remote</h4>
            <p class="usage-desc">在 MCP 客户端中选择 Streamable HTTP 或 SSE，并填写以下配置：</p>
            <pre class="config-code">{{ remoteConfigSnippet }}</pre>
          </div>

          <div class="usage-section">
            <h4 class="usage-title">Stdio</h4>
            <p class="usage-desc">如果通过本地进程启动，请使用以下配置：</p>
            <pre class="config-code">{{ stdioConfigSnippet }}</pre>
          </div>
        </div>

        <!-- Reviews Tab -->
        <div v-if="activeTab === 'reviews'" class="content-card">
          <h3 class="card-title">用户评价</h3>
          <el-empty description="暂无评价" />
        </div>
      </div>
    </template>

    <div v-else class="empty-wrap">
      <el-empty :description="mcpStore.error || '未找到该 MCP 工具'"">
        <el-button @click="goBack">返回 MCP 广场</el-button>
      </el-empty>
    </div>
  </div>
</template>

<style scoped>
.mcp-detail {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 24px 32px;
  height: 100%;
  overflow-y: auto;
  background: var(--surface-primary);
}

.loading-wrap,
.empty-wrap {
  padding: 48px 0;
}

/* Breadcrumb */
.breadcrumb {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-size-md);
}

.back-link {
  display: flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  color: var(--accent-primary);
  font-size: var(--font-size-md);
  cursor: pointer;
  padding: 0;
}

.back-link:hover {
  opacity: 0.8;
}

.sep {
  color: var(--foreground-muted);
}

.current-page {
  color: var(--foreground-secondary);
}

/* Header Card */
.header-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 28px 32px;
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: 16px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 20px;
}

.large-icon {
  width: 72px;
  height: 72px;
  border-radius: 16px;
  background: rgba(59, 130, 246, 0.15);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.large-icon-text {
  font-size: 36px;
  line-height: 1;
}

.header-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.name-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.tool-name {
  font-size: 20px;
  font-weight: var(--font-weight-bold);
  color: var(--foreground-primary);
  margin: 0;
}

.official-badge {
  font-size: 11px;
  font-weight: var(--font-weight-semibold);
  color: var(--accent-primary);
  background: rgba(59, 130, 246, 0.15);
  padding: 4px 10px;
  border-radius: 6px;
}

.version-badge {
  font-size: 11px;
  color: var(--foreground-secondary);
  background: rgba(38, 51, 89, 0.3);
  padding: 4px 10px;
  border-radius: 6px;
}

.meta-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-size-md);
  color: var(--foreground-secondary);
  flex-wrap: wrap;
}

.meta-row :deep(svg) {
  vertical-align: -2px;
}

.meta-sep {
  color: var(--foreground-muted);
}

.rating-meta {
  color: #f59e0b;
}




/* Tab Bar */
.tab-bar {
  display: flex;
  gap: 0;
  padding: 4px;
  background: var(--surface-card);
  border-radius: 12px;
}

.tab-btn {
  padding: 10px 20px;
  border-radius: 10px;
  border: none;
  background: none;
  color: var(--foreground-secondary);
  font-size: var(--font-size-md);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.tab-btn:hover {
  color: var(--foreground-primary);
}

.tab-btn.active {
  background: rgba(59, 130, 246, 0.2);
  color: var(--accent-primary);
  font-weight: var(--font-weight-semibold);
}

/* Two Column Layout */
.two-columns {
  display: flex;
  gap: 24px;
}

.left-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
}

.right-col {
  width: 340px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  flex-shrink: 0;
}

/* Content Cards */
.content-card {
  padding: 24px;
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xl);
}

.card-title {
  font-size: 16px;
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
  margin: 0 0 16px;
}

.card-desc {
  font-size: var(--font-size-md);
  color: var(--foreground-secondary);
  line-height: 1.7;
  margin: 0;
}

/* Feature List */
.feature-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.feature-list li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: var(--font-size-md);
  color: var(--foreground-secondary);
  line-height: 1.5;
}

.check-icon {
  color: #22c55e;
  margin-top: 3px;
  flex-shrink: 0;
}

/* Info List */
.info-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.info-label {
  font-size: var(--font-size-base);
  color: var(--foreground-secondary);
}

.info-value {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  color: var(--foreground-primary);
}

.info-value.link {
  color: var(--accent-primary);
  text-decoration: none;
  display: flex;
  align-items: center;
  gap: 4px;
}

.info-value.link:hover {
  text-decoration: underline;
}

/* Connection Config */
.config-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  padding: 4px;
  background: var(--surface-secondary);
  border-radius: 10px;
}

.config-tab-btn {
  flex: 1;
  padding: 8px 12px;
  border: none;
  border-radius: 8px;
  background: none;
  color: var(--foreground-secondary);
  font-size: var(--font-size-base);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.config-tab-btn:hover {
  color: var(--foreground-primary);
}

.config-tab-btn.active {
  background: rgba(59, 130, 246, 0.2);
  color: var(--accent-primary);
  font-weight: var(--font-weight-semibold);
}

.config-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.config-field-label {
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
}

.transport-select {
  width: 100%;
}

.config-code {
  margin: 0;
  padding: 16px;
  background: var(--surface-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  color: var(--foreground-primary);
  font-family: 'JetBrains Mono', 'SFMono-Regular', Consolas, 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.usage-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 20px;
}

.usage-title {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
}

.usage-desc {
  margin: 0;
  font-size: var(--font-size-base);
  color: var(--foreground-secondary);
  line-height: 1.7;
}

/* Tags */
.tags-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.tag {
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
  background: rgba(38, 51, 89, 0.2);
  padding: 6px 12px;
  border-radius: 8px;
}

/* Tools */
.tool-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.tool-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
  background: var(--surface-secondary);
  border-radius: 10px;
}

.tool-item-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: rgba(59, 130, 246, 0.15);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  line-height: 1;
  flex-shrink: 0;
}

.tool-item-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.tool-item-name {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
}

.tool-item-desc {
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
  line-height: 1.6;
  margin: 0;
}
</style>
