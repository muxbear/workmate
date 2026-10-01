/**
 * 「系统设置 → 系统标识」（LOGO + 系统名称）草稿规则
 *
 * 与桌面版 `desktop/src/renderer/src/components/settings/brandIdentityDraft.ts`
 * 逐字对齐（含中文错误文案），只把「已存 LOGO」的类型从 data-URL 换成 URL：
 * Web 端的 LOGO 由后端接口提供，不读本地文件。
 *
 * 页面只做装配：选中文件 / 恢复默认 / 改名称都只改本地草稿，点「保存」才发请求。
 * 纯规则抽出来单测钉住 —— 尤其是「点保存前不落盘」的边界：计划为空即不写。
 */

/** LOGO 草稿：keep = 沿用后端已存；file = 待上传的新文件；reset = 待恢复内置默认 */
export type LogoDraft =
  | { kind: 'keep' }
  | { kind: 'file'; file: File; url: string }
  | { kind: 'reset' }

/** 保存计划：名称是否需写库 + LOGO 要执行的动作（null = 该项不动） */
export interface BrandIdentitySavePlan {
  /** 待写入的系统名称（trim 后）；null = 与已保存值相同，无需写入 */
  name: string | null
  /** LOGO 动作：upload = 上传草稿文件；reset = 恢复内置默认；null = 不动 */
  logo: 'upload' | 'reset' | null
}

/** 系统名称上限（与后端 service 的 SYSTEM_NAME_MAX_LENGTH 对齐；单测钉住一致性） */
export const SYSTEM_NAME_MAX_LENGTH = 24

/**
 * LOGO 预览地址：file 用本地 objectURL，reset 回内置兜底（返回 null），
 * keep 跟随后端已存的自定义 LOGO（null 同样表示走内置兜底）。
 */
export function logoPreviewSrc(draft: LogoDraft, storedLogoUrl: string | null): string | null {
  switch (draft.kind) {
    case 'file':
      return draft.url
    case 'reset':
      return null
    default:
      return storedLogoUrl
  }
}

/**
 * 是否显示「恢复默认」：选了新文件时显示（可撤回选择），
 * 已置为 reset 时隐藏（已是默认态），否则跟随「当前是否已自定义 LOGO」。
 */
export function showsResetLogo(draft: LogoDraft, storedHasCustomLogo: boolean): boolean {
  if (draft.kind === 'file') return true
  if (draft.kind === 'reset') return false
  return storedHasCustomLogo
}

/**
 * 系统名称前置校验：规则与后端 `validate_system_name` 对齐（trim 后非空、不超上限、
 * 无控制字符），由单测做等价性钉住 —— 前端拦下来的，后端也一定拒绝，
 * 避免"转圈后报错"的往返。
 *
 * @returns 错误文案；合法返回 null
 */
export function validateSystemNameDraft(draftName: string): string | null {
  const name = draftName.trim()
  if (!name) return '系统名称不能为空'
  if (name.length > SYSTEM_NAME_MAX_LENGTH) {
    return '系统名称不能超过 ' + SYSTEM_NAME_MAX_LENGTH + ' 个字符'
  }
  // 控制字符（含换行/制表）会破坏浏览器标题与单行展示，与后端同样逐码点拒绝
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return '系统名称不能包含换行或制表等控制字符'
  }
  return null
}

/**
 * 组装保存计划：名称 trim 后与已保存值相同则不入计划（不产生多余写入），
 * LOGO 按草稿决定动作 —— 已置 reset 但当前本来就没有自定义 LOGO 时同样视为无动作。
 */
export function buildSavePlan(
  draft: LogoDraft,
  draftName: string,
  storedName: string,
  storedHasCustomLogo: boolean,
): BrandIdentitySavePlan {
  const name = draftName.trim()
  return {
    name: name === storedName ? null : name,
    logo:
      draft.kind === 'file'
        ? 'upload'
        : draft.kind === 'reset' && storedHasCustomLogo
          ? 'reset'
          : null,
  }
}
