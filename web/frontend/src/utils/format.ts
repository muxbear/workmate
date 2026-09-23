/** 人类可读的文件大小（0 或未知返回空串） */
export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

/** 产物类型短标签（按 MIME 推断，用于产物卡片展示） */
export function artifactKindLabel(mime?: string): string {
  if (!mime) return '文件'
  if (mime.startsWith('image/')) return '图片'
  if (mime.startsWith('video/')) return '视频'
  if (mime === 'application/pdf') return 'PDF'
  if (mime.startsWith('text/')) return '文本'
  if (mime.includes('word')) return 'Word'
  if (mime.includes('spreadsheet')) return 'Excel'
  if (mime.includes('presentation')) return 'PPT'
  return '文件'
}
