/**
 * 两种文件来源的适配器：知识库文档 / 工作空间文件
 *
 * 两者都实现 `FilePreviewSource`，因此可以共用同一个预览组件。
 */
import { useKnowledgeStore } from '../../store/knowledge'
import { useWorkspaceStore } from '../../store/workspace'
import type { FilePreviewSource } from './types'

/** 知识库文档来源（只读；内容经 knowledge:read-file 读取） */
export function createKnowledgeFileSource(
  kbId: string,
  doc: { name: string; relPath: string }
): FilePreviewSource {
  const knowledge = useKnowledgeStore()
  return {
    key: doc.relPath,
    name: doc.name,
    relPath: doc.relPath,
    markdownKnowledgeId: kbId,
    async readText(cursor?: number) {
      const result = await knowledge.readFile(kbId, doc.relPath, 'text', cursor)
      if (!result) throw new Error(knowledge.lastError || '读取文件失败')
      return {
        content: result.content ?? '',
        truncated: result.truncated,
        cursor: result.cursor,
        totalChars: result.totalChars
      }
    },
    async readBytes() {
      const result = await knowledge.readFile(kbId, doc.relPath, 'bytes')
      if (!result?.bytes) throw new Error(knowledge.lastError || '读取文件失败')
      return { bytes: result.bytes }
    }
    // 知识库文件为只读：不提供 saveBytes
  }
}

/** 工作空间文件来源（Word 可保存；Markdown 内相对图片按 workspaceId 解析） */
export function createWorkspaceFileSource(
  workspaceId: string,
  entry: { name: string; relPath: string }
): FilePreviewSource {
  const workspace = useWorkspaceStore()
  return {
    key: entry.relPath,
    name: entry.name,
    relPath: entry.relPath,
    markdownWorkspaceId: workspaceId,
    async readText(cursor?: number) {
      const result = await workspace.readFile(workspaceId, entry.relPath, cursor)
      return {
        content: result.content,
        truncated: result.truncated,
        cursor: result.cursor,
        totalChars: result.totalChars
      }
    },
    async readBytes() {
      const result = await workspace.readFileBytes(workspaceId, entry.relPath)
      return { bytes: result.bytes }
    },
    async saveBytes(bytes: ArrayBuffer) {
      await workspace.saveFile(workspaceId, entry.relPath, bytes)
    }
  }
}
