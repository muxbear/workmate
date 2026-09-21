<script setup lang="ts">
import { computed } from 'vue'
import type { DocumentPayload } from '@/types/document'

/** 表格文档组件（CSV / TSV）：解析为表格展示，超出上限时截断 */
const props = defineProps<{ payload: DocumentPayload }>()

const MAX_ROWS = 200

/** 简单 CSV 解析：支持双引号包裹与转义 */
function parseDelimited(text: string): string[][] {
  const delimiter = text.includes(',') ? ',' : '\t'
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        cell += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === delimiter) {
      row.push(cell)
      cell = ''
    } else if (char === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (char !== '\r') {
      cell += char
    }
  }
  if (cell || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((item) => item.some((value) => value.trim() !== ''))
}

const rows = computed(() => parseDelimited(props.payload.text || ''))
const header = computed(() => rows.value[0] ?? [])
const body = computed(() => rows.value.slice(1, MAX_ROWS + 1))
const truncated = computed(() => rows.value.length - 1 > MAX_ROWS)
</script>

<template>
  <div class="table-viewer">
    <table class="table-body">
      <thead>
        <tr>
          <th v-for="(cell, index) in header" :key="index">{{ cell }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(line, rowIndex) in body" :key="rowIndex">
          <td v-for="(cell, cellIndex) in line" :key="cellIndex">{{ cell }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="truncated" class="table-tip">仅展示前 {{ MAX_ROWS }} 行，完整内容请下载查看</p>
  </div>
</template>

<style scoped>
.table-viewer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 100%;
}

.table-body {
  border-collapse: collapse;
  width: 100%;
  font-size: var(--font-size-xs);
}

.table-body :deep(th),
.table-body :deep(td) {
  border: 1px solid var(--border-medium);
  padding: 6px 8px;
  text-align: left;
  color: var(--foreground-secondary);
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.table-body :deep(th) {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
  font-weight: var(--font-weight-semibold);
}

.table-tip {
  margin: 0;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
}
</style>
