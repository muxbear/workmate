/**
 * 上传前的路径过滤（上传弹窗与拖拽/文件夹选择共用）。
 *
 * 从文件夹纳入待上传队列时跳过常见非文档目录（含其整个子树），
 * 名单对齐主进程 `src/main/workspace/path-guard.ts` 的 HIDDEN_NAMES
 * （另含 .venv）；渲染层不跨层导入主进程模块，故本地维护。
 */

/** 命中任一名称的路径段即跳过整个子树 */
export const EXCLUDED_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.venv',
  '.idea',
  '.vscode',
  '.DS_Store'
])

/** 相对路径是否落在排除目录内（`\` 与 `/` 均按分隔处理，任一命中即跳过） */
export function isExcludedRelPath(relPath: string): boolean {
  return relPath
    .split(/[/\\]+/)
    .some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment))
}
