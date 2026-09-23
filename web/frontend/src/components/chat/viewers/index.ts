import type { Component } from 'vue'
import type { DocumentKind } from '@/types/document'
import MarkdownViewer from './MarkdownViewer.vue'
import JsonViewer from './JsonViewer.vue'
import HtmlViewer from './HtmlViewer.vue'
import TextViewer from './TextViewer.vue'
import TableViewer from './TableViewer.vue'
import ImageViewer from './ImageViewer.vue'
import VideoViewer from './VideoViewer.vue'
import PdfViewer from './PdfViewer.vue'
import PendingDocumentViewer from './PendingDocumentViewer.vue'

/**
 * 文档类型 → 文档组件映射表。
 *
 * 新增一种文档类型时只需三步：
 * 1. 在 `@/types/document` 的 DocumentKind 中登记类型；
 * 2. 在 `@/utils/documentType` 中登记扩展名 / MIME 识别规则；
 * 3. 在此处把类型指向新的文档组件（组件统一接收 DocumentPayload）。
 *
 * 规划中：Word / Excel / PPT 需服务端解析（docx→html、xlsx→表格、pptx→图片）后再接入组件。
 */
export const DOCUMENT_VIEWERS: Record<DocumentKind, Component> = {
  markdown: MarkdownViewer,
  json: JsonViewer,
  html: HtmlViewer,
  text: TextViewer,
  table: TableViewer,
  image: ImageViewer,
  video: VideoViewer,
  pdf: PdfViewer,
  word: PendingDocumentViewer,
  excel: PendingDocumentViewer,
  powerpoint: PendingDocumentViewer,
  binary: PendingDocumentViewer,
}

/** 取文档类型对应的组件（未登记类型回退到占位组件） */
export function viewerFor(kind: DocumentKind): Component {
  return DOCUMENT_VIEWERS[kind] ?? PendingDocumentViewer
}
