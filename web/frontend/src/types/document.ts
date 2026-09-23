/** 右侧工作区文档标签页相关类型：按文档类型分派到对应的文档组件 */

export type DocumentKind =
  | 'markdown'
  | 'html'
  | 'json'
  | 'image'
  | 'video'
  | 'pdf'
  | 'table'
  | 'text'
  | 'word'
  | 'excel'
  | 'powerpoint'
  | 'binary'

/** 文档类型信息（标签页与预览头展示用） */
export interface DocumentTypeInfo {
  kind: DocumentKind
  /** 中文类型名，例如 Markdown / Word / 图片 */
  label: string
  /** 是否按文本读取：true 交给文本类组件，false 使用二进制对象地址 */
  text: boolean
  /** 是否已提供对应的文档组件（false 表示组件规划中，当前仅支持下载） */
  ready: boolean
}

/** 传给文档组件的统一载荷 */
export interface DocumentPayload {
  name: string
  kind: DocumentKind
  label: string
  /** 文本类文档内容（text 为 true 时使用） */
  text: string
  /** 二进制文档的对象地址（图片 / PDF 等使用） */
  url: string
  /** 所属会话 id：Markdown 内相对路径配图需要它来拼产物地址 */
  threadId?: string
  /** 当前文档的虚拟路径（作为相对图片的基准目录） */
  basePath?: string
  /** 会话产物虚拟路径集合（判断相对路径是否命中真实产物） */
  artifactPaths?: string[]
  /** 产物虚拟路径 → 字节数（成片内联预览上限判断用） */
  artifactSizes?: Record<string, number>
}
