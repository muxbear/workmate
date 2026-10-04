/**
 * 知识库命名规则（Create / Edit / Rename 弹窗共用的单一来源）。
 *
 * 文件树以「/」分层，名称含斜杠（或反斜杠）会破坏目录结构，一律不允许；
 * 长度上限与主进程 KnowledgeService 校验保持一致。
 * 历史问题：三份弹窗各自实现且已行为漂移（只有 Rename 校验斜杠）。
 */
export const KB_NAME_MAX = 60
export const KB_DESC_MAX = 120

/** 命名校验核心：空值 / 长度 / 斜杠；返回错误文案，通过返回 null */
export function validateName(
  raw: string,
  options: { emptyMessage?: string; max?: number } = {}
): string | null {
  const { emptyMessage = '名称不能为空', max = KB_NAME_MAX } = options
  const name = raw.trim()
  if (!name) return emptyMessage
  if (name.length > max) return `名称不能超过 ${max} 个字符`
  if (name.includes('/') || name.includes('\\')) return '名称不能包含斜杠'
  return null
}

/** 知识库名称校验（Create / Edit 弹窗口径） */
export function validateKbName(raw: string): string | null {
  return validateName(raw, { emptyMessage: '知识库名称不能为空' })
}

/** 知识库描述校验；返回错误文案，通过返回 null */
export function validateKbDesc(raw: string): string | null {
  return raw.trim().length > KB_DESC_MAX ? `描述不能超过 ${KB_DESC_MAX} 个字符` : null
}
