<script setup lang="ts">
/**
 * 文档索引进度流水线（右侧「索引进度」标签页）
 *
 * 对齐 web 版 KbIndexingPipeline：总进度 + 分片/实体/关系指标 + 七阶段列表
 * （排队/解析/切片/向量化/稀疏索引/实体关系抽取/完成），运行中的阶段带转圈与阶段进度条。
 *
 * 数据源是 store 里按 kbId+relPath 实时取到的文档行：`knowledge:import-progress`
 * 事件已在 store 侧打补丁（含 stage/progress/计数），本组件无需另接 IPC，天然流式刷新。
 */
import { computed } from 'vue'
import { useKnowledgeStore } from '../../store/knowledge'
import { computeIndexStages, type IndexStageStatus } from './indexStages'

const props = defineProps<{
  kbId: string
  relPath: string
}>()

const emit = defineEmits<{ close: [] }>()

const kbStore = useKnowledgeStore()

/** 当前文档行（终端事件时 store 会整表刷新，行对象随之更新） */
const doc = computed(
  () => kbStore.documentsOf(props.kbId).find((item) => item.relPath === props.relPath) ?? null
)

/** 七阶段模型：已完成 done / 当前 running / 之后 pending / 失败 failed */
const stages = computed(() =>
  computeIndexStages({
    status: doc.value?.status,
    stage: doc.value?.stage,
    progress: doc.value?.progress,
    errorMessage: doc.value?.errorMessage
  })
)

const totalPercent = computed(() => Math.round(doc.value?.progress ?? 0))

/** 字节数 → 展示文案（与列表页同一口径） */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${bytes} B`
}

/** 内联 SVG 的通用形状描述（lucide v0.400 path 数据，与 web 用同一套图标） */
interface IconShape {
  d?: string
  cx?: number
  cy?: number
  r?: number
  x?: number
  y?: number
  width?: number
  height?: number
  rx?: number
  x1?: number
  y1?: number
  x2?: number
  y2?: number
}

/** 阶段图标按下标对应：排队(Pause) 解析(FileText) 切片(Scissors) 向量化(Sparkle)
 *  稀疏索引(Hash) 实体关系抽取(GitBranch) 完成(CircleCheckBig) */
const stageIcons: IconShape[][] = [
  [
    { x: 14, y: 4, width: 4, height: 16, rx: 1 },
    { x: 6, y: 4, width: 4, height: 16, rx: 1 }
  ],
  [
    { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' },
    { d: 'M14 2v4a2 2 0 0 0 2 2h4' },
    { d: 'M10 9H8' },
    { d: 'M16 13H8' },
    { d: 'M16 17H8' }
  ],
  [
    { cx: 6, cy: 6, r: 3 },
    { d: 'M8.12 8.12 12 12' },
    { d: 'M20 4 8.12 15.88' },
    { cx: 6, cy: 18, r: 3 },
    { d: 'M14.8 14.8 20 20' }
  ],
  [
    {
      d: 'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z'
    }
  ],
  [
    { x1: 4, x2: 20, y1: 9, y2: 9 },
    { x1: 4, x2: 20, y1: 15, y2: 15 },
    { x1: 10, x2: 8, y1: 3, y2: 21 },
    { x1: 16, x2: 14, y1: 3, y2: 21 }
  ],
  [
    { x1: 6, x2: 6, y1: 3, y2: 15 },
    { cx: 18, cy: 6, r: 3 },
    { cx: 6, cy: 18, r: 3 },
    { d: 'M18 9a9 9 0 0 1-9 9' }
  ],
  [
    { d: 'M22 11.08V12a10 10 0 1 1-5.93-9.14' },
    { d: 'm9 11 3 3L22 4' }
  ]
]

/** 阶段状态图标：完成打勾 / 运行转圈 / 失败叹号 / 未开始横杠 */
const statusIcons: Record<IndexStageStatus, IconShape[]> = {
  done: [
    { d: 'M22 11.08V12a10 10 0 1 1-5.93-9.14' },
    { d: 'm9 11 3 3L22 4' }
  ],
  running: [{ d: 'M21 12a9 9 0 1 1-6.219-8.56' }],
  failed: [
    { cx: 12, cy: 12, r: 10 },
    { x1: 12, x2: 12, y1: 8, y2: 12 },
    { x1: 12, x2: 12.01, y1: 16, y2: 16 }
  ],
  pending: [{ d: 'M5 12h14' }]
}
</script>

<template>
  <div class="kb-pipe">
    <template v-if="doc">
      <!-- 头部：文档名 + 大小/路径 + 关闭 -->
      <div class="kb-pipe-head">
        <svg
          class="kb-pipe-head-icon"
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect width="8" height="8" x="3" y="3" rx="2" />
          <path d="M7 11v4a2 2 0 0 0 2 2h4" />
          <rect width="8" height="8" x="13" y="13" rx="2" />
        </svg>
        <div class="kb-pipe-head-text">
          <p class="kb-pipe-title">{{ doc.name }}</p>
          <p class="kb-pipe-sub">{{ formatSize(doc.sizeBytes) }} · {{ doc.relPath }}</p>
        </div>
        <button class="kb-pipe-close" type="button" title="关闭" @click="emit('close')">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>

      <!-- 总进度 -->
      <div class="kb-pipe-total">
        <div class="kb-pipe-total-line">
          <span class="kb-pipe-total-label">总进度</span>
          <span class="kb-pipe-total-value">{{ totalPercent }}%</span>
        </div>
        <div class="kb-pipe-bar">
          <span class="kb-pipe-bar-fill" :style="{ width: `${totalPercent}%` }"></span>
        </div>
      </div>

      <!-- 指标：分片 / 实体 / 关系 -->
      <div class="kb-pipe-metrics">
        <div class="kb-pipe-metric">
          <span class="kb-pipe-metric-value">{{ doc.chunksCount ?? 0 }}</span>
          <span class="kb-pipe-metric-label">分片</span>
        </div>
        <div class="kb-pipe-metric">
          <span class="kb-pipe-metric-value">{{ doc.entitiesCount ?? 0 }}</span>
          <span class="kb-pipe-metric-label">实体</span>
        </div>
        <div class="kb-pipe-metric">
          <span class="kb-pipe-metric-value">{{ doc.relationsCount ?? 0 }}</span>
          <span class="kb-pipe-metric-label">关系</span>
        </div>
      </div>

      <!-- 七阶段流水线 -->
      <div class="kb-pipe-list">
        <div
          v-for="(stage, i) in stages"
          :key="stage.name"
          class="kb-pipe-stage"
          :class="`kb-pipe-stage--${stage.status}`"
        >
          <svg
            class="kb-pipe-stage-icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <template v-for="(shape, si) in stageIcons[i]" :key="si">
              <path v-if="shape.d" :d="shape.d" />
              <circle v-else-if="shape.r !== undefined" :cx="shape.cx" :cy="shape.cy" :r="shape.r" />
              <rect
                v-else-if="shape.width !== undefined"
                :x="shape.x"
                :y="shape.y"
                :width="shape.width"
                :height="shape.height"
                :rx="shape.rx"
              />
              <line v-else :x1="shape.x1" :y1="shape.y1" :x2="shape.x2" :y2="shape.y2" />
            </template>
          </svg>
          <span class="kb-pipe-stage-name">{{ stage.name }}</span>
          <svg
            class="kb-pipe-status-icon"
            :class="{ 'kb-pipe-status-icon--spin': stage.status === 'running' }"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <template v-for="(shape, si) in statusIcons[stage.status]" :key="si">
              <path v-if="shape.d" :d="shape.d" />
              <circle v-else-if="shape.r !== undefined" :cx="shape.cx" :cy="shape.cy" :r="shape.r" />
              <line v-else :x1="shape.x1" :y1="shape.y1" :x2="shape.x2" :y2="shape.y2" />
            </template>
          </svg>
          <div v-if="stage.status === 'running'" class="kb-pipe-stage-bar">
            <span class="kb-pipe-bar-fill" :style="{ width: `${stage.pct}%` }"></span>
          </div>
        </div>
      </div>

      <!-- 图谱失败提示（文档已索引但实体/关系为空；与列表警示图标同源） -->
      <p v-if="doc.graphError" class="kb-pipe-graph-warn">
        图谱未生成：{{ doc.graphError }}
      </p>
    </template>
    <p v-else class="kb-pipe-empty">文档不存在或已删除。</p>
  </div>
</template>

<style scoped>
.kb-pipe {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
.kb-pipe-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.kb-pipe-head-icon {
  margin-top: 2px;
  flex-shrink: 0;
  color: #168b7a;
}
.kb-pipe-head-text {
  min-width: 0;
  flex: 1;
}
.kb-pipe-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: #34454b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-pipe-sub {
  margin: 2px 0 0;
  font-size: 11px;
  color: #879498;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-pipe-close {
  display: flex;
  flex-shrink: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  padding: 4px;
  color: #8a969a;
  cursor: pointer;
}
.kb-pipe-close:hover {
  background: #eff5f2;
  color: #34454b;
}
.kb-pipe-total {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.kb-pipe-total-line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.kb-pipe-total-label {
  font-size: 12px;
  font-weight: 500;
  color: #42575a;
}
.kb-pipe-total-value {
  font-size: 12px;
  font-weight: 600;
  color: #147967;
}
.kb-pipe-bar {
  height: 6px;
  border-radius: 999px;
  background: #e8efec;
  overflow: hidden;
}
.kb-pipe-bar-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: #168b7a;
  transition: width 0.2s ease;
}
.kb-pipe-metrics {
  display: flex;
  gap: 8px;
}
.kb-pipe-metric {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  border: 1px solid #e6eeeb;
  border-radius: 10px;
  background: #f8faf9;
  padding: 8px 6px;
}
.kb-pipe-metric-value {
  font-size: 14px;
  font-weight: 600;
  color: #34454b;
}
.kb-pipe-metric-label {
  font-size: 11px;
  color: #879498;
}
.kb-pipe-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.kb-pipe-stage {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr) 14px;
  align-items: center;
  gap: 8px;
  border-radius: 8px;
  padding: 6px 10px;
}
/* 阶段状态配色与 web KbIndexingPipeline 同色系 */
.kb-pipe-stage--pending {
  color: #9aa7ab;
  background: #f6f8f7;
}
.kb-pipe-stage--done {
  color: #147967;
  background: rgba(16, 185, 129, 0.08);
}
.kb-pipe-stage--running {
  color: #147967;
  background: rgba(22, 139, 122, 0.1);
}
.kb-pipe-stage--failed {
  color: #e05561;
  background: rgba(244, 63, 94, 0.08);
}
.kb-pipe-stage-icon,
.kb-pipe-status-icon {
  flex-shrink: 0;
}
.kb-pipe-stage-name {
  font-size: 12px;
  font-weight: 500;
  color: #42575a;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-pipe-stage--pending .kb-pipe-stage-name {
  color: #9aa7ab;
}
.kb-pipe-stage-bar {
  grid-column: 2 / 4;
  height: 3px;
  margin-top: 2px;
  border-radius: 999px;
  background: #e8efec;
  overflow: hidden;
}
.kb-pipe-status-icon--spin {
  animation: kb-pipe-spin 1.2s linear infinite;
}
@keyframes kb-pipe-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
.kb-pipe-graph-warn {
  margin: 0;
  border-radius: 8px;
  background: rgba(245, 158, 11, 0.1);
  padding: 8px 10px;
  font-size: 11px;
  line-height: 18px;
  color: #a5670a;
  word-break: break-word;
}
.kb-pipe-empty {
  margin: 0;
  font-size: 12px;
  color: #879498;
}
</style>
