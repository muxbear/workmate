import { isAbsolute, resolve, sep } from 'path'

/**
 * 工作空间路径防线（R8-7）：containment 校验的单一实现。
 *
 * 原为 WorkspaceService 的私有 resolveInside；本模块先服务工作空间域，
 * 后续刀将收编其余 containment 守卫（doc-artifacts / PreviewServer /
 * ArtifactAssetService —— 根因 E「安全策略四处审计」）。
 */

/** 列表/预览与打包时忽略的隐藏与依赖目录（单一真源） */
export const HIDDEN_NAMES = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.idea',
  '.vscode',
  '.DS_Store'
])

/**
 * 解析工作空间内相对路径并做 containment 校验（防路径穿越）。
 * @throws 绝对路径 / 越界时抛错（文案保持原样，渲染层可见）
 */
export function resolveInside(root: string, relPath: string): string {
  if (isAbsolute(relPath)) throw new Error('路径越界')
  const rootResolved = resolve(root)
  const target = resolve(rootResolved, relPath)
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
    throw new Error('路径越界')
  }
  return target
}
