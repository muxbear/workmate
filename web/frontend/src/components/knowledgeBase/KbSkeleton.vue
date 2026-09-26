<script setup lang="ts">
/**
 * 知识库模块的加载骨架（迭代 6 T6.6）。
 *
 * **为什么需要它**：知识库模块此前是全站唯一不用骨架屏的模块（其它 5 个视图都在用
 * `el-skeleton`），只用 `v-loading` 转个圈。更要紧的是，**三处在数据还在路上时显示
 * 空态**——其中 `KbDocsTab` 显示的是"暂无文档，点击右上角上传"这个**行动号召**，
 * 用户会以为库是空的、跑去重复上传。
 *
 * 抽成组件是为了让"加载中"在这几个列表里长得一样：`el-skeleton` 的 `rows` 参数各写
 * 各的（此前有 4 份复制的 `.skeleton-card` 类），看起来像三个不同的界面。
 */
withDefaults(
  defineProps<{
    /** 骨架行数。列表项用 3～5，详情块用 6～10 */
    rows?: number
    /** 渲染几个骨架块（卡片网格用），默认 1 */
    count?: number
  }>(),
  { rows: 3, count: 1 },
)
</script>

<template>
  <div class="kb-skeleton" role="status" aria-busy="true" aria-label="加载中">
    <div v-for="i in count" :key="i" class="kb-skeleton-block">
      <el-skeleton :rows="rows" animated />
    </div>
  </div>
</template>

<style scoped>
.kb-skeleton {
  padding: 8px 4px;
}

.kb-skeleton-block + .kb-skeleton-block {
  margin-top: 12px;
}
</style>
