<script setup lang="ts">
import { computed } from 'vue'
import { Pencil, Trash2, Star, Users, Copy } from 'lucide-vue-next'
import type { Expert } from '@/types/expert'
import { EXPERT_CATEGORY_LABELS, EXPERT_STATUS_LABELS } from '@/types/expert'

const props = defineProps<{ expert: Expert }>()

const emit = defineEmits<{
  (e: 'edit', expert: Expert): void
  (e: 'delete', expert: Expert): void
  (e: 'toggle', expert: Expert): void
  (e: 'clone', expert: Expert): void
}>()

const categoryLabel = computed(
  () => EXPERT_CATEGORY_LABELS[props.expert.category] || props.expert.category,
)

const statusLabel = computed(
  () => EXPERT_STATUS_LABELS[props.expert.status] || props.expert.status,
)

const statusColor = computed(() => {
  switch (props.expert.status) {
    case 'active':
      return 'var(--color-tool-emerald)'
    case 'inactive':
      return 'var(--color-tool-amber)'
    default:
      return 'var(--color-tool-gray)'
  }
})

const usageText = computed(() => {
  const count = props.expert.usageCount
  if (count >= 10000) return (count / 1000).toFixed(1) + 'w'
  if (count >= 1000) return (count / 1000).toFixed(1) + 'k'
  return String(count)
})
</script>

<template>
  <div class="expert-card" :class="{ 'expert-card--inactive': expert.status !== 'active' }">
    <div class="card-head">
      <div class="avatar" :style="{ background: expert.color || 'var(--accent-primary)' }">
        {{ expert.initials || expert.name.charAt(0) }}
      </div>
      <div class="head-info">
        <div class="name-row">
          <span class="name">{{ expert.name }}</span>
          <span class="status-dot" :style="{ background: statusColor }" :title="statusLabel" />
        </div>
        <span class="title">{{ expert.title }}</span>
      </div>
      <el-tag v-if="expert.featured" size="small" type="warning" effect="dark">精选</el-tag>
    </div>

    <div class="card-tags">
      <el-tag
        v-for="tag in expert.tags.slice(0, 3)"
        :key="tag"
        size="small"
        type="info"
      >
        {{ tag }}
      </el-tag>
      <span v-if="expert.tags.length > 3" class="more-tags">+{{ expert.tags.length - 3 }}</span>
    </div>

    <p class="card-desc">{{ expert.description || '暂无描述' }}</p>

    <div class="card-footer">
      <div class="footer-stats">
        <span class="stat-item">
          <Star :size="12" class="stat-icon stat-icon--star" />
          {{ expert.rating.toFixed(1) }}
        </span>
        <span class="stat-item">
          <Users :size="12" class="stat-icon" />
          {{ usageText }}
        </span>
        <span class="stat-item">{{ categoryLabel }}</span>
      </div>
      <div class="footer-actions">
        <el-tooltip content="编辑" placement="top">
          <el-button text size="small" @click.stop="emit('edit', expert)">
            <Pencil :size="14" />
          </el-button>
        </el-tooltip>
        <el-tooltip content="克隆" placement="top">
          <el-button text size="small" @click.stop="emit('clone', expert)">
            <Copy :size="14" />
          </el-button>
        </el-tooltip>
        <el-tooltip :content="expert.status === 'active' ? '停用' : '启用'" placement="top">
          <el-switch
            :model-value="expert.status === 'active'"
            size="small"
            @change="emit('toggle', expert)"
          />
        </el-tooltip>
        <el-tooltip content="删除" placement="top">
          <el-button text size="small" class="delete-btn" @click.stop="emit('delete', expert)">
            <Trash2 :size="14" />
          </el-button>
        </el-tooltip>
      </div>
    </div>
  </div>
</template>

<style scoped>
.expert-card {
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xl);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.expert-card:hover {
  border-color: rgba(59, 130, 246, 0.25);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
}

.expert-card--inactive {
  opacity: 0.6;
}

.card-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.avatar {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 18px;
  font-weight: 700;
  flex-shrink: 0;
}

.head-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.name-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.name {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.title {
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.more-tags {
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
  padding: 2px 6px;
}

.card-desc {
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
  line-height: 1.5;
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 36px;
}

.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.footer-stats {
  display: flex;
  align-items: center;
  gap: 12px;
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  color: var(--foreground-secondary);
}

.stat-icon {
  color: var(--foreground-muted);
}

.stat-icon--star {
  color: #f59e0b;
}

.footer-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.delete-btn:hover {
  color: var(--color-text-error);
}
</style>
