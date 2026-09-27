/**
 * 知识库目录路径的纯函数工具。
 *
 * 目录在前后端都是「`/` 分隔的相对路径」，`''` 表示根目录（后端存 `NULL`）。这些判断
 * 散落在组件里最容易出的错是**把根目录当成"没选目录"**——于是根视图变成了全库视图，
 * 而界面看起来仍然"正常工作"。收在一处、配单测，比在三个组件里各写一遍可靠。
 */

/** 路径拼接：`('a/b', 'c/d')` → `'a/b/c/d'`；任一侧为空则取另一侧 */
export function joinFolder(base: string, sub: string): string {
  const left = normalizePath(base)
  const right = normalizePath(sub)
  if (!left) return right
  if (!right) return left
  return `${left}/${right}`
}

/** 上一级目录（`'a/b'` → `'a'`；`'a'` 与 `''` → `''`） */
export function parentFolder(path: string): string {
  const clean = normalizePath(path)
  const index = clean.lastIndexOf('/')
  return index < 0 ? '' : clean.slice(0, index)
}

/** 面包屑：`'a/b'` → `[{ name: 'a', path: 'a' }, { name: 'b', path: 'a/b' }]` */
export function crumbsOf(path: string): { name: string; path: string }[] {
  const clean = normalizePath(path)
  if (!clean) return []
  const parts = clean.split('/')
  return parts.map((name, index) => ({
    name,
    path: parts.slice(0, index + 1).join('/'),
  }))
}

/**
 * 某个文件的上传落点：`基础目录 + 文件自身的相对目录`。
 *
 * `webkitRelativePath`（`选择文件夹` 时浏览器给的全路径，形如 `资料/2024/报告.pdf`）
 * 的目录部分保留下来，于是整目录上传后目录结构原样落在知识库里；普通单文件选择没有
 * 这个字段，就落在当前浏览的目录里（与"在哪个文件夹里上传就进哪个文件夹"一致）。
 *
 * 注意拖拽上传：`DataTransfer.files` 不带相对路径，拖进来的目录树会被拍平到当前目录。
 */
export function folderForFile(base: string, webkitRelativePath: string | undefined): string {
  const relative = normalizePath(webkitRelativePath ?? '')
  if (!relative) return normalizePath(base)
  const index = relative.lastIndexOf('/')
  // 没有目录成分（单文件选择，或浏览器没给相对路径）→ 直接落在基础目录
  if (index < 0) return normalizePath(base)
  return joinFolder(base, relative.slice(0, index))
}

/** 归一去首尾斜杠与空白；`\` 一律当分隔符（Windows 客户端会上报反斜杠） */
function normalizePath(raw: string): string {
  return (raw ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/')
}
