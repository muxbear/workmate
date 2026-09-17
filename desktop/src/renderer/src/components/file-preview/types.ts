/**
 * 统一的文件来源抽象
 *
 * 「文件预览」组件不关心文件来自哪里：知识库文档与工作空间文件各自实现一个
 * `FilePreviewSource`，预览组件只按类型调用 readText / readBytes。
 */

export interface FilePreviewSource {
  /** 唯一键（标签页去重、切换时重新加载） */
  key: string
  /** 文件名（决定渲染方式） */
  name: string
  /** 展示用相对路径 */
  relPath: string
  /** 读取文本内容（markdown / 文本类） */
  readText(): Promise<{ content: string; truncated?: boolean }>
  /** 读取原始字节（图片 / PDF / Word）；不支持时可不实现 */
  readBytes?(): Promise<{ bytes: Uint8Array }>
  /** 可选：保存字节（工作空间文件可编辑；知识库为只读） */
  saveBytes?(bytes: ArrayBuffer): Promise<void>
  /** 可选：Markdown 内相对图片的解析上下文（工作空间传 workspaceId） */
  markdownWorkspaceId?: string
}
