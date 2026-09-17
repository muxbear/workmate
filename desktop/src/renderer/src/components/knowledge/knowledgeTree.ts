/**
 * 知识库文件树的纯函数变换
 *
 * 上传文件夹后文件列表需要保留原始目录结构，因此列表数据从「扁平文件数组」升级为
 * 「文件夹 / 文件」树。这里集中放树相关的纯函数（合并上传、排序、展开、增删改查），
 * 页面只做状态编排，便于复用与单测。
 *
 * 当前文件列表仍是页面内的 mock 数据（无 store、无 IPC）；等知识库引擎落地、
 * 文件列表改由主进程提供时，这些变换可原样复用或替换为 IPC 结果。
 */

/** 列表里的三套文件图标 */
export type KnowledgeFileIcon = 'file-text' | 'file-type-2' | 'file-spreadsheet'
/** 文件建立索引的方式（undefined = 页面初始数据，按「已建立索引」展示） */
export type KnowledgeFileIndexState = 'default' | 'custom' | 'none'
/** 文件列表的排序键 */
export type KnowledgeSortKey = 'name' | 'size' | 'updated'

/** 文件元信息（文件夹节点没有这部分） */
export interface KnowledgeFileMeta {
  name: string
  type: string
  /** 展示用大小文案（如 4.8 MB） */
  size: string
  /**
   * 文件字节数（主进程文档列表提供）。
   * 有值时「大小」排序按数值比较，避免 '4.8 MB' 与 '126 KB' 按字符串比较出错。
   */
  sizeBytes?: number
  updated: string
  icon: KnowledgeFileIcon
  tint: string
  indexState?: KnowledgeFileIndexState
}

/** 列表节点：文件夹或文件 */
export interface KnowledgeNode {
  /** 唯一键：根级为名称，子级为「父路径/名称」，与树中的位置一一对应 */
  key: string
  name: string
  kind: 'folder' | 'file'
  /** 文件元信息（kind === 'file' 时存在） */
  file?: KnowledgeFileMeta
  /** 子节点（kind === 'folder' 时存在，可为空数组） */
  children?: KnowledgeNode[]
}

/** 上传条目：目录层级 + 文件元信息 */
export interface KnowledgeUploadEntry {
  /** 文件所在目录（根目录为空数组，如 ['设计规范', '组件']） */
  dirs: readonly string[]
  file: KnowledgeFileMeta
}

/** 展开后的可见行 */
export interface KnowledgeRow {
  node: KnowledgeNode
  depth: number
}

/** 子节点 key：父 key 为空（根级）时就是名称本身 */
export function childKey(parentKey: string, name: string): string {
  return parentKey ? `${parentKey}/${name}` : name
}

/** 父级 key（根级返回空字符串） */
export function parentKeyOf(key: string): string {
  const index = key.lastIndexOf('/')
  return index < 0 ? '' : key.slice(0, index)
}

/** 文件节点 */
export function fileNode(dirs: readonly string[], file: KnowledgeFileMeta): KnowledgeNode {
  const key = [...dirs, file.name].join('/')
  return { key, name: file.name, kind: 'file', file }
}

/** 文件夹节点 */
export function folderNode(
  key: string,
  name: string,
  children: KnowledgeNode[] = []
): KnowledgeNode {
  return { key, name, kind: 'folder', children }
}

/** 深度优先收集全部文件节点（不含文件夹） */
export function collectFileNodes(nodes: readonly KnowledgeNode[]): KnowledgeNode[] {
  const result: KnowledgeNode[] = []
  for (const node of nodes) {
    if (node.kind === 'file') {
      result.push(node)
      continue
    }
    result.push(...collectFileNodes(node.children ?? []))
  }
  return result
}

/** 按 key 查找节点（找不到返回 null） */
export function findNode(nodes: readonly KnowledgeNode[], key: string): KnowledgeNode | null {
  for (const node of nodes) {
    if (node.key === key) return node
    if (node.kind === 'folder' && key.startsWith(`${node.key}/`)) {
      const hit = findNode(node.children ?? [], key)
      if (hit) return hit
    }
  }
  return null
}

/**
 * 合并上传：按 dirs 逐级创建/复用文件夹，同名文件覆盖。
 * 不可变替换：未受影响的节点保持原引用。
 */
export function mergeUploads(
  nodes: readonly KnowledgeNode[],
  entries: readonly KnowledgeUploadEntry[]
): KnowledgeNode[] {
  let result: KnowledgeNode[] = [...nodes]
  for (const entry of entries) result = mergeAt('', result, entry.dirs, entry.file)
  return result
}

function mergeAt(
  parentKey: string,
  nodes: readonly KnowledgeNode[],
  dirs: readonly string[],
  file: KnowledgeFileMeta
): KnowledgeNode[] {
  if (dirs.length === 0) {
    const node: KnowledgeNode = {
      key: childKey(parentKey, file.name),
      name: file.name,
      kind: 'file',
      file
    }
    const exists = nodes.some((item) => item.key === node.key)
    return exists ? nodes.map((item) => (item.key === node.key ? node : item)) : [...nodes, node]
  }

  const [head, ...rest] = dirs
  const key = childKey(parentKey, head)
  const folder = nodes.find((item) => item.kind === 'folder' && item.key === key)
  const children = mergeAt(key, folder?.children ?? [], rest, file)
  const next = folderNode(key, head, children)
  return folder ? nodes.map((item) => (item.key === key ? next : item)) : [...nodes, next]
}

/** 重命名节点：文件同步元信息里的名称，文件夹连同子孙节点重写 key */
export function renameNode(
  nodes: readonly KnowledgeNode[],
  key: string,
  name: string
): KnowledgeNode[] {
  return nodes.map((node) => {
    if (node.key === key) return rewriteNode(node, parentKeyOf(key), name)
    if (node.kind === 'folder' && key.startsWith(`${node.key}/`)) {
      return { ...node, children: renameNode(node.children ?? [], key, name) }
    }
    return node
  })
}

function rewriteNode(node: KnowledgeNode, parentKey: string, name: string): KnowledgeNode {
  const key = childKey(parentKey, name)
  if (node.kind === 'file') {
    return { key, name, kind: 'file', file: node.file ? { ...node.file, name } : undefined }
  }
  const children = (node.children ?? []).map((child) => rewriteNode(child, key, child.name))
  return folderNode(key, name, children)
}

/** 删除节点（文件夹连同其子孙一起删除） */
export function removeNode(nodes: readonly KnowledgeNode[], key: string): KnowledgeNode[] {
  const result: KnowledgeNode[] = []
  for (const node of nodes) {
    if (node.key === key) continue
    if (node.kind === 'folder' && key.startsWith(`${node.key}/`)) {
      result.push({ ...node, children: removeNode(node.children ?? [], key) })
      continue
    }
    result.push(node)
  }
  return result
}

/** 更新文件元信息（找不到目标时结构不变） */
export function patchFile(
  nodes: readonly KnowledgeNode[],
  key: string,
  patch: Partial<KnowledgeFileMeta>
): KnowledgeNode[] {
  return nodes.map((node) => {
    if (node.key === key) {
      return node.kind === 'file' && node.file
        ? { ...node, name: patch.name ?? node.name, file: { ...node.file, ...patch } }
        : node
    }
    if (node.kind === 'folder') {
      return { ...node, children: patchFile(node.children ?? [], key, patch) }
    }
    return node
  })
}

/** 排序：文件夹恒按名称排在文件前，文件按 sortKey 排序（各层级同理） */
export function sortTree(
  nodes: readonly KnowledgeNode[],
  sortKey: KnowledgeSortKey,
  ascending: boolean
): KnowledgeNode[] {
  const direction = ascending ? 1 : -1
  return nodes
    .map((node) =>
      node.kind === 'folder'
        ? { ...node, children: sortTree(node.children ?? [], sortKey, ascending) }
        : node
    )
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1
      if (left.kind === 'folder') return left.name.localeCompare(right.name, 'zh-CN')
      if (sortKey === 'size') {
        const leftBytes = left.file?.sizeBytes
        const rightBytes = right.file?.sizeBytes
        if (typeof leftBytes === 'number' && typeof rightBytes === 'number') {
          return (leftBytes - rightBytes) * direction
        }
      }
      const a = `${left.file?.[sortKey] ?? ''}`
      const b = `${right.file?.[sortKey] ?? ''}`
      return a.localeCompare(b, 'zh-CN') * direction
    })
}

/** 展开可见行：文件夹折叠时跳过其子节点 */
export function flattenVisible(
  nodes: readonly KnowledgeNode[],
  isExpanded: (key: string) => boolean,
  depth = 0
): KnowledgeRow[] {
  const rows: KnowledgeRow[] = []
  for (const node of nodes) {
    rows.push({ node, depth })
    if (node.kind === 'folder' && isExpanded(node.key)) {
      rows.push(...flattenVisible(node.children ?? [], isExpanded, depth + 1))
    }
  }
  return rows
}

/**
 * 重命名后换算新 key：命中节点自身返回 newKey，子孙节点按前缀改写，
 * 其它 key 原样返回（用于同步已打开的标签页）。
 */
export function remapKey(key: string, oldKey: string, newKey: string): string {
  if (key === oldKey) return newKey
  return key.startsWith(`${oldKey}/`) ? newKey + key.slice(oldKey.length) : key
}
