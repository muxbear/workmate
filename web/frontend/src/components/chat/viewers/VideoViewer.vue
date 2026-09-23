<script setup lang="ts">
import type { DocumentPayload } from '@/types/document'

/**
 * 视频文档组件（mp4 / webm / mov / m4v 等）。
 *
 * `payload.url` 由 DocumentViewer 带鉴权拉取字节后生成 blob 对象地址，
 * 因此 `<video>` 不需要（也无法）自己携带 Authorization 头。
 * preload=metadata 只取首帧与时长，避免打开预览即整段下载。
 */
defineProps<{ payload: DocumentPayload }>()
</script>

<template>
  <div class="video-viewer">
    <video
      v-if="payload.url"
      :src="payload.url"
      :title="payload.name"
      class="video-body"
      controls
      preload="metadata"
    ></video>
  </div>
</template>

<style scoped>
.video-viewer {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  min-height: 100%;
}

.video-body {
  max-width: 100%;
  border-radius: var(--radius-lg);
  background: #000;
}
</style>
