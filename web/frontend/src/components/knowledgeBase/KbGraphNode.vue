<script setup lang="ts">
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import {
  ENTITY_TYPE_COLORS,
  ENTITY_TYPE_FALLBACK_COLOR,
} from '@/types/knowledgeBase'

const props = defineProps<{
  id: string
  data: {
    name: string
    type: string
    mentions: number
    color: string
    hovered: boolean
    selected: boolean
    dimmed: boolean
  }
}>()


const nodeColor = computed(
  () => ENTITY_TYPE_COLORS[props.data.type] || ENTITY_TYPE_FALLBACK_COLOR,
)

/**
 * 节点直径随"提到该实体的文档数"增长。
 *
 * 用**对数**而不是线性：`mentions` 现在是文档数，一个常见实体可能出现在上百篇文档里，
 * 线性放大会让一个枢纽节点吞掉整张画布、其余节点挤成一团。对数在 1～上百的范围内都能
 * 拉开可辨的差距（1 篇 → 60，3 篇 → 72，7 篇 → 84，15 篇及以上封顶 96）。
 *
 * 此前是 `48 + mentions * 3` 封顶 72——那时 mentions 恒为 1（写侧同文档内去重 +
 * 每次重抽先删行），所以每个节点永远都是 51，这个公式其实从未表达过任何信息。
 */
const circleSize = computed(() =>
  Math.min(96, 48 + Math.log2(props.data.mentions + 1) * 12),
)
</script>

<template>
  <div
    class="kb-graph-node"
    :class="{
      'kb-graph-node--selected': data.selected,
      'kb-graph-node--dimmed': data.dimmed,
    }"
  >
    <Handle type="target" :position="Position.Top" :connectable="false" />
    <div
      class="node-sphere"
      :style="{
        background: `radial-gradient(circle at 35% 35%, ${nodeColor}66, ${nodeColor}22)`,
        borderColor: nodeColor,
        width: circleSize + 'px',
        height: circleSize + 'px',
      }"
    >
      <span class="node-sphere-text">{{ data.name.length > 3 ? data.name.slice(0, 3) : data.name }}</span>
    </div>
    <span class="node-label">{{ data.name }}</span>
    <Handle type="source" :position="Position.Bottom" :connectable="false" />
  </div>
</template>

<style scoped>
.kb-graph-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  cursor: grab;
  transition: opacity 0.2s, filter 0.2s;
}

.kb-graph-node:active {
  cursor: grabbing;
}

.kb-graph-node--dimmed {
  opacity: 0.2;
}

.node-sphere {
  border-radius: 50%;
  border: 3px solid;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.2s, box-shadow 0.2s;
  box-shadow: var(--graph-sphere-shadow);
}

.kb-graph-node:hover .node-sphere {
  transform: scale(1.12);
}

.kb-graph-node--selected .node-sphere {
  transform: scale(1.08);
  box-shadow: 0 0 24px var(--node-glow, rgba(59, 130, 246, 0.5));
}

.node-sphere-text {
  font-size: 14px;
  font-weight: 700;
  color: #fff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
}

.node-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--graph-node-label);
  text-align: center;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-shadow: var(--graph-label-shadow);
}

:deep(.vue-flow__handle) {
  opacity: 0;
  pointer-events: none;
}
</style>
