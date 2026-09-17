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
  /**
   * 读取文本内容（markdown / 文本类）
   *
   * 传入上次返回的 cursor 可继续读取后续内容，直到 truncated 为 false，
   * 预览侧据此实现「加载更多」，从而完整读取整篇文档。
   */
  readText(cursor?: number): Promise<{
    content: string
    truncated?: boolean
    cursor?: number
    totalChars?: number
  }>
  /** 读取原始字节（图片 / PDF / Word）；不支持时可不实现 */
  readBytes?(): Promise<{ bytes: Uint8Array }>
  /** 可选：保存字节（工作空间文件可编辑；知识库为只读） */
  saveBytes?(bytes: ArrayBuffer): Promise<void>
  /** 可选：Markdown 内相对图片的解析上下文（工作空间传 workspaceId） */
  markdownWorkspaceId?: string
  /** 可选：知识库 id（知识库预览的相对路径图片按知识库内路径读取） */
  markdownKnowledgeId?: string
}
