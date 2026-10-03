<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useKnowledgeStore } from '../../store/knowledge'
import { layoutGraph } from './graphLayout'
import type { KnowledgeGraphView } from '../../../../preload/index.d'

/**
 * 知识库图谱可视化（弹窗）
 *
 * 数据：`knowledge:graph-view`（主进程跨文档聚合折叠）；布局：graphLayout 纯函数
 * （手写 SVG 力导向，零新增依赖）。交互：hover 高亮邻域、点击看实体详情与邻居、
 * 滚轮缩放、拖拽平移 / 拖拽节点。
 */
const props = defineProps<{
  open: boolean
  kbId: string
  libraryName?: string
}>()

const emit = defineEmits<{
  close: []
}>()

const kbStore = useKnowledgeStore()

/** 画布逻辑尺寸（viewBox；CSS 等比缩放显示） */
const VIEW_WIDTH = 760
const VIEW_HEIGHT = 520

/** 8 类受控实体 + 未知兜底的配色（与图谱抽取白名单一致） */
const TYPE_COLORS: Record<string, string> = {
  人物: '#6366f1',
  组织: '#0ea5e9',
  产品: '#f59e0b',
  概念: '#10b981',
  算法: '#ef4444',
  地点: '#14b8a6',
  时间: '#8b5cf6',
  事件: '#f97316'
}
const TYPE_FALLBACK_COLOR = '#94a3b8'

const visible = ref(props.open)
watch(
  () => props.open,
  (open) => {
    visible.value = open
  },
  { immediate: true }
)

const loading = ref(false)
const errorMsg = ref('')
const view = ref<KnowledgeGraphView | null>(null)
const positions = ref<Map<string, { x: number; y: number }>>(new Map())
const selectedKey = ref<string | null>(null)
const hoveredKey = ref<string | null>(null)
const scale = ref(1)
const offset = ref({ x: 0, y: 0 })

type DragState =
  | { kind: 'pan'; startX: number; startY: number; originX: number; originY: number }
  | { kind: 'node'; key: string; startX: number; startY: number; originX: number; originY: number }
const dragState = ref<DragState | null>(null)

async function loadGraph(): Promise<void> {
  if (!props.kbId) return
  loading.value = true
  errorMsg.value = ''
  selectedKey.value = null
  const data = await kbStore.graphView(props.kbId)
  loading.value = false
  if (!data) {
    errorMsg.value = kbStore.lastError || '读取图谱失败'
    view.value = null
    return
  }
  view.value = data
  const result = layoutGraph(
    { nodes: data.nodes, links: data.links },
    { width: VIEW_WIDTH, height: VIEW_HEIGHT }
  )
  positions.value = new Map(result.positions)
  offset.value = { x: 0, y: 0 }
  scale.value = 1
}

watch(
  () => [props.open, props.kbId] as const,
  () => {
    if (props.open && props.kbId) void loadGraph()
  },
  { immediate: true }
)

const nodes = computed(() => view.value?.nodes ?? [])
const links = computed(() => view.value?.links ?? [])

/** 邻接表：key → 邻居（含关系标签），供高亮与详情用 */
const neighbors = computed(() => {
  const map = new Map<string, Array<{ key: string; label: string }>>()
  const nameOf = new Map(nodes.value.map((node) => [node.key, node.name]))
  for (const link of links.value) {
    if (!nameOf.has(link.from) || !nameOf.has(link.to)) continue
    const label = link.labels.join(' / ')
    const fromList = map.get(link.from) ?? []
    fromList.push({ key: link.to, label })
    map.set(link.from, fromList)
    const toList = map.get(link.to) ?? []
    toList.push({ key: link.from, label })
    map.set(link.to, toList)
  }
  return map
})

/** 当前高亮焦点（hover 优先，其次选中）与其一跳邻居 */
const focusKey = computed(() => hoveredKey.value ?? selectedKey.value)
const highlighted = computed(() => {
  const focus = focusKey.value
  if (!focus) return null
  const set = new Set<string>([focus])
  for (const item of neighbors.value.get(focus) ?? []) set.add(item.key)
  return set
})

const selectedNode = computed(
  () => nodes.value.find((node) => node.key === selectedKey.value) ?? null
)

const selectedNeighbors = computed(() => {
  const key = selectedKey.value
  if (!key) return []
  const nameOf = new Map(nodes.value.map((node) => [node.key, node.name]))
  return (neighbors.value.get(key) ?? []).map((item) => ({
    name: nameOf.get(item.key) ?? item.key,
    label: item.label
  }))
})

const legend = computed(() => {
  const types = [...new Set(nodes.value.map((node) => node.type))]
  return types.map((type) => ({ type, color: colorOf(type) }))
})

function colorOf(type: string): string {
  return TYPE_COLORS[type] ?? TYPE_FALLBACK_COLOR
}

function radiusOf(mentions: number): number {
  return Math.min(16, Math.max(6, 5 + Math.sqrt(Math.max(1, mentions)) * 2))
}

function positionOf(key: string): { x: number; y: number } {
  return positions.value.get(key) ?? { x: VIEW_WIDTH / 2, y: VIEW_HEIGHT / 2 }
}

/** 节点是否该显示文字标签：高亮集合、重要节点、或小图全显 */
function showLabel(key: string, mentions: number): boolean {
  if (highlighted.value) return highlighted.value.has(key)
  return mentions >= 2 || nodes.value.length <= 40
}

function labelOf(key: string): string {
  const node = nodes.value.find((item) => item.key === key)
  const name = node?.name ?? key
  return name.length > 8 ? `${name.slice(0, 8)}…` : name
}

function lineOpacity(weight: number): number {
  return Math.min(0.8, 0.2 + Math.min(weight, 4) * 0.12)
}

function nodeOpacity(key: string): number {
  if (!highlighted.value) return 1
  return highlighted.value.has(key) ? 1 : 0.15
}

function onNodeClick(key: string): void {
  selectedKey.value = selectedKey.value === key ? null : key
}

function onNodeEnter(key: string): void {
  hoveredKey.value = key
}

function onNodeLeave(): void {
  hoveredKey.value = null
}

function onWheel(event: WheelEvent): void {
  const factor = Math.exp(-event.deltaY * 0.0012)
  scale.value = Math.min(3, Math.max(0.4, scale.value * factor))
}

function resetTransform(): void {
  scale.value = 1
  offset.value = { x: 0, y: 0 }
}

function onBackgroundDown(event: PointerEvent): void {
  dragState.value = {
    kind: 'pan',
    startX: event.clientX,
    startY: event.clientY,
    originX: offset.value.x,
    originY: offset.value.y
  }
}

function onNodeDown(key: string, event: PointerEvent): void {
  event.stopPropagation()
  const position = positionOf(key)
  dragState.value = {
    kind: 'node',
    key,
    startX: event.clientX,
    startY: event.clientY,
    originX: position.x,
    originY: position.y
  }
}

function onPointerMove(event: PointerEvent): void {
  const drag = dragState.value
  if (!drag) return
  if (drag.kind === 'pan') {
    offset.value = {
      x: drag.originX + (event.clientX - drag.startX),
      y: drag.originY + (event.clientY - drag.startY)
    }
    return
  }
  // 节点拖拽：把屏幕位移换算回画布坐标（除以缩放）
  const next = new Map(positions.value)
  next.set(drag.key, {
    x: drag.originX + (event.clientX - drag.startX) / scale.value,
    y: drag.originY + (event.clientY - drag.startY) / scale.value
  })
  positions.value = next
}

function onPointerUp(): void {
  dragState.value = null
}

function closeModal(): void {
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && visible.value) closeModal()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Transition name="kg-modal">
    <div v-if="visible" class="kg-mask" @click.self="closeModal">
      <div class="kg-card" role="dialog" aria-modal="true" aria-label="知识图谱">
        <header class="kg-header">
          <div class="kg-heading">
            <h2 class="kg-title">知识图谱</h2>
            <p class="kg-subtitle">
              {{ libraryName || '知识库' }} ·
              {{ nodes.length }} 实体 · {{ links.length }} 关系（跨文档聚合）
            </p>
          </div>
          <button class="kg-close" type="button" aria-label="关闭" @click="closeModal">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        <div class="kg-body">
          <p v-if="loading" class="kg-status">正在读取图谱…</p>
          <p v-else-if="errorMsg" class="kg-status kg-status--error">{{ errorMsg }}</p>
          <div v-else-if="!nodes.length" class="kg-empty">
            <p class="kg-empty-title">该知识库暂无图谱数据</p>
            <p class="kg-empty-hint">
              请在「知识库设置」开启「知识图谱抽取」并重建索引；已有索引的资料可用
              「重抽图谱」补抽。
            </p>
          </div>

          <template v-else>
            <div class="kg-toolbar">
              <div class="kg-legend">
                <span v-for="item in legend" :key="item.type" class="kg-legend-item">
                  <span class="kg-legend-dot" :style="{ background: item.color }"></span>
                  {{ item.type }}
                </span>
              </div>
              <button class="kg-reset" type="button" @click="resetTransform">重置视图</button>
            </div>
            <p v-if="view?.truncated" class="kg-truncated">
              实体较多：仅显示出现次数最高的一批（含其关联关系）
            </p>

            <div class="kg-canvas-wrap">
              <svg
                class="kg-canvas"
                :viewBox="`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`"
                @wheel.prevent="onWheel"
                @pointerdown="onBackgroundDown"
                @pointermove="onPointerMove"
                @pointerup="onPointerUp"
                @pointerleave="onPointerUp"
              >
                <g :transform="`translate(${offset.x}, ${offset.y}) scale(${scale})`">
                  <line
                    v-for="link in links"
                    :key="`${link.from}|${link.to}`"
                    class="kg-link"
                    :x1="positionOf(link.from).x"
                    :y1="positionOf(link.from).y"
                    :x2="positionOf(link.to).x"
                    :y2="positionOf(link.to).y"
                    :stroke-width="1 + Math.min(link.weight, 4) * 0.5"
                    :stroke-opacity="lineOpacity(link.weight)"
                  />
                  <g
                    v-for="node in nodes"
                    :key="node.key"
                    class="kg-node"
                    :class="{ 'kg-node--selected': node.key === selectedKey }"
                    :transform="`translate(${positionOf(node.key).x}, ${positionOf(node.key).y})`"
                    :opacity="nodeOpacity(node.key)"
                    @pointerdown="onNodeDown(node.key, $event)"
                    @click="onNodeClick(node.key)"
                    @mouseenter="onNodeEnter(node.key)"
                    @mouseleave="onNodeLeave"
                  >
                    <circle
                      :r="radiusOf(node.mentions)"
                      :fill="colorOf(node.type)"
                      :stroke="node.key === selectedKey ? '#0f172a' : 'rgba(255,255,255,0.9)'"
                      stroke-width="1.5"
                    />
                    <text
                      v-if="showLabel(node.key, node.mentions)"
                      class="kg-node-label"
                      y="-12"
                      text-anchor="middle"
                    >
                      {{ labelOf(node.key) }}
                    </text>
                  </g>
                </g>
              </svg>

              <aside v-if="selectedNode" class="kg-detail">
                <h3 class="kg-detail-name">{{ selectedNode.name }}</h3>
                <p class="kg-detail-row">
                  <span class="kg-detail-label">类型</span>{{ selectedNode.type }}
                </p>
                <p class="kg-detail-row">
                  <span class="kg-detail-label">提及</span>{{ selectedNode.mentions }} 次 ·
                  {{ selectedNode.docs }} 篇文档
                </p>
                <h4 class="kg-detail-sub">关联实体（{{ selectedNeighbors.length }}）</h4>
                <ul class="kg-detail-list">
                  <li v-for="item in selectedNeighbors.slice(0, 12)" :key="item.name">
                    {{ item.name }}
                    <span class="kg-detail-rel">{{ item.label }}</span>
                  </li>
                </ul>
                <p v-if="selectedNeighbors.length > 12" class="kg-detail-more">
                  还有 {{ selectedNeighbors.length - 12 }} 个未显示…
                </p>
              </aside>
            </div>
          </template>
        </div>

        <footer class="kg-footer">
          <button class="kg-btn" type="button" @click="closeModal">关闭</button>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.kg-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(4px);
}

.kg-card {
  display: flex;
  flex-direction: column;
  width: min(880px, calc(100vw - 48px));
  max-height: min(88vh, 800px);
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid var(--kw-color-border-brand);
  background: var(--kw-color-surface);
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.2);
}

.kg-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 24px;
  border-bottom: 1px solid var(--kw-color-border-brand);
}

.kg-heading {
  min-width: 0;
}

.kg-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.kg-subtitle {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--kw-color-text-muted);
}

.kg-close {
  padding: 4px;
  border: none;
  background: transparent;
  color: var(--kw-color-text-faint);
  cursor: pointer;
}

.kg-close:hover {
  color: var(--kw-color-text);
}

.kg-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 24px;
}

.kg-status {
  margin: 24px 0;
  text-align: center;
  font-size: 13px;
  color: var(--kw-color-text-muted);
}

.kg-status--error {
  color: #c0392b;
}

.kg-empty {
  margin: 28px auto;
  max-width: 420px;
  padding: 24px;
  border-radius: 12px;
  border: 1px dashed var(--kw-color-border-brand);
  text-align: center;
}

.kg-empty-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.kg-empty-hint {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--kw-color-text-muted);
}

.kg-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.kg-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.kg-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--kw-color-text-muted);
}

.kg-legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.kg-reset {
  padding: 5px 12px;
  border-radius: 8px;
  border: 1px solid var(--kw-color-border-brand);
  background: transparent;
  color: var(--kw-color-text-secondary);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}

.kg-reset:hover {
  color: var(--kw-color-text);
}

.kg-truncated {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--kw-color-text-muted);
}

.kg-canvas-wrap {
  position: relative;
  display: flex;
  gap: 12px;
}

.kg-canvas {
  flex: 1;
  min-width: 0;
  border-radius: 12px;
  border: 1px solid var(--kw-color-border-brand);
  background: rgba(15, 23, 42, 0.02);
  cursor: grab;
  touch-action: none;
}

.kg-canvas:active {
  cursor: grabbing;
}

.kg-link {
  stroke: #94a3b8;
}

.kg-node {
  cursor: pointer;
}

.kg-node-label {
  font-size: 10px;
  fill: var(--kw-color-text-secondary);
  pointer-events: none;
  user-select: none;
}

.kg-detail {
  width: 208px;
  flex-shrink: 0;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid var(--kw-color-border-brand);
  overflow-y: auto;
  max-height: 520px;
}

.kg-detail-name {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--kw-color-text);
  word-break: break-all;
}

.kg-detail-row {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--kw-color-text-secondary);
}

.kg-detail-label {
  display: inline-block;
  width: 36px;
  color: var(--kw-color-text-muted);
}

.kg-detail-sub {
  margin: 10px 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--kw-color-text-muted);
}

.kg-detail-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  color: var(--kw-color-text-secondary);
}

.kg-detail-rel {
  margin-left: 6px;
  color: var(--kw-color-text-faint);
}

.kg-detail-more {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--kw-color-text-faint);
}

.kg-footer {
  display: flex;
  padding: 12px 24px 16px;
  border-top: 1px solid var(--kw-color-border-brand);
}

.kg-btn {
  flex: 1;
  padding: 10px;
  border-radius: 12px;
  border: none;
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
  font-size: 14px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
}

.kg-btn:hover {
  opacity: 0.92;
}

.kg-modal-enter-active,
.kg-modal-leave-active {
  transition: opacity 0.2s;
}

.kg-modal-enter-active .kg-card,
.kg-modal-leave-active .kg-card {
  transition: transform 0.2s;
}

.kg-modal-enter-from,
.kg-modal-leave-to {
  opacity: 0;
}

.kg-modal-enter-from .kg-card,
.kg-modal-leave-to .kg-card {
  transform: scale(0.96);
}
</style>
