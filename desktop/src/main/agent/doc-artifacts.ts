import type { DocArtifactFile, AgentArtifactMeta, ArtifactPreviewKind } from '../../preload/index.d'

/** 文档产物扩展名白名单：命中才触发右侧自动展开/消息链接（主进程权威，渲染层展示沿用） */
export const DOC_EXTENSIONS: ReadonlySet<string> = new Set([
  'md',
  'html',
  'htm',
  'txt',
  'json',
  'csv',
  'yaml',
  'yml',
  'xml',
  'doc',
  'docx',
  'pdf'
])

/** 按扩展名决定右侧栏展示组件类型（word/pdf 需完整文件字节，文本型可流式） */
export function artifactPreviewKind(ext: string): ArtifactPreviewKind {
  if (ext === 'doc' || ext === 'docx') return 'word'
  if (ext === 'pdf') return 'pdf'
  if (DOC_EXTENSIONS.has(ext)) return 'text'
  return 'unsupported'
}

export function isDocExt(ext: string): boolean {
  return DOC_EXTENSIONS.has(ext.toLowerCase())
}

/** 从原始文件名字符串取小写扩展名（无点） */
function extOf(name: string): string {
  const parts = name.split('.')
  return parts.length > 1 ? (parts.pop() ?? '').toLowerCase() : ''
}

/** 文本中候选文档路径：允许中文/字母数字/常见符号分隔的相对或绝对路径 */
const DOC_PATH_CANDIDATE_RE =
  /[^\s'<>，。；：、【】()]+?\.(?:md|docx|doc|html|htm|txt|json|csv|yaml|yml|xml|pdf)(?![a-zA-Z0-9])/gi

/** 去掉末尾常见标点（提取自工具返回文本时） */
function stripTrailingPunct(value: string): string {
  const set = '。，；：、)】】'
  while (value.length > 0 && set.indexOf(value[value.length - 1]) !== -1) {
    value = value.slice(0, -1)
  }
  return value.trim()
}

/**
 * 归一化工作区相对路径：反斜杠统一为 /，去包裹引号/反引号（ASCII 34/39/96）与尾部标点；
 * 绝对 Windows 路径仅在落在 baseDir 内时转为相对路径；剥离前导 / 与 ./；拒绝 .. 穿越。
 */
export function normalizeWorkspaceRelPath(rawPath: string, baseDir?: string): string | null {
  let value = String(rawPath ?? '').trim()
  while (
    value.length > 0 &&
    (value.charCodeAt(0) === 34 || value.charCodeAt(0) === 39 || value.charCodeAt(0) === 96)
  ) {
    value = value.slice(1)
  }
  while (
    value.length > 0 &&
    (value.charCodeAt(value.length - 1) === 34 ||
      value.charCodeAt(value.length - 1) === 39 ||
      value.charCodeAt(value.length - 1) === 96)
  ) {
    value = value.slice(0, -1)
  }
  value = stripTrailingPunct(value)
  if (!value) return null
  const slash = value.split('\\').join('/')
  let rel = slash
  if (baseDir) {
    const base = baseDir.split('\\').join('/').replace(/\/+$/, '')
    if (/^[a-zA-Z]:\//.test(rel)) {
      const baseLower = base.toLowerCase()
      const relLower = rel.toLowerCase()
      if (relLower === baseLower) return ''
      if (relLower.startsWith(baseLower + '/')) {
        rel = rel.slice(base.length + 1)
      } else {
        return null
      }
    }
  }
  while (rel.startsWith('/')) rel = rel.slice(1)
  while (rel.startsWith('./')) rel = rel.slice(2)
  const segments = rel.split('/').filter((seg) => seg.length > 0)
  if (segments.some((seg) => seg === '..' || seg === '.')) return null
  if (segments.length === 0) return null
  return segments.join('/')
}

/** 从文本中提取工作区内的文档产物（task/execute 返回文本的兜底识别） */
export function extractDocArtifactsFromText(
  text: string,
  baseDir?: string,
  workspaceId?: string | null
): DocArtifactFile[] {
  const out: DocArtifactFile[] = []
  const seen = new Set<string>()
  if (!text) return out
  for (const match of text.matchAll(DOC_PATH_CANDIDATE_RE)) {
    const raw = match[0]
    const relPath = normalizeWorkspaceRelPath(raw, baseDir)
    if (!relPath || seen.has(relPath)) continue
    const ext = extOf(relPath)
    if (!isDocExt(ext)) continue
    const name = relPath.split('/').pop() ?? relPath
    seen.add(relPath)
    out.push({ name, relPath, ext, workspaceId: workspaceId ?? null })
  }
  return out
}

/** write_file/edit_file 工具 input 中的文档产物（内容随流式事件展示） */
export function docArtifactFromWriteInput(
  filePath: string,
  workspaceId: string | null
): { artifact: DocArtifactFile; relPath: string } | null {
  const relPath = normalizeWorkspaceRelPath(filePath)
  if (!relPath) return null
  const ext = extOf(relPath)
  if (!isDocExt(ext)) return null
  const name = relPath.split('/').pop() ?? relPath
  return { artifact: { name, relPath, ext, workspaceId }, relPath }
}

/** 构造推送渲染层的产物元信息（chunk/end 事件共用 artifactId 关联） */
export function buildArtifactMeta(
  artifactId: string,
  artifact: DocArtifactFile
): AgentArtifactMeta {
  return {
    artifactId,
    name: artifact.name,
    relPath: artifact.relPath,
    workspaceId: artifact.workspaceId ?? null,
    ext: artifact.ext,
    preview: artifactPreviewKind(artifact.ext)
  }
}
