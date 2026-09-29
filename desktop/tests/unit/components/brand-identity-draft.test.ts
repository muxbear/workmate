import { describe, expect, it } from 'vitest'
import {
  buildSavePlan,
  logoPreviewSrc,
  showsResetLogo,
  validateSystemNameDraft,
  SYSTEM_NAME_MAX_LENGTH,
  type LogoDraft
} from '../../../src/renderer/src/components/settings/brandIdentityDraft'
import {
  isValidSystemName,
  SYSTEM_NAME_MAX_LENGTH as MAIN_SYSTEM_NAME_MAX_LENGTH
} from '../../../src/main/settings/schema'

/**
 * 「设置 → 系统设置 → 系统标识」草稿规则
 *
 * 这是「点保存前不写主进程」的结构性证据：本模块不接触任何 IPC / store，
 * 写库意图只能由 buildSavePlan 的返回值表达 —— 计划为空即代表没有写入。
 * 「输入 / 选文件确实不落盘」的交互语义由 e2e 用例在真主进程上验证。
 */

/** 已选中新文件的草稿 */
const FILE_DRAFT: LogoDraft = {
  kind: 'file',
  file: new File([new Uint8Array([1])], 'logo.png'),
  url: 'blob:preview'
}

describe('logoPreviewSrc（LOGO 预览地址）', () => {
  it('keep 跟随已存快照，file 用本地预览地址，reset 回内置兜底', () => {
    expect(logoPreviewSrc({ kind: 'keep' }, 'data:stored')).toBe('data:stored')
    expect(logoPreviewSrc(FILE_DRAFT, 'data:stored')).toBe('blob:preview')
    expect(logoPreviewSrc({ kind: 'reset' }, 'data:stored')).toBe('')
  })

  it('未自定义 LOGO 时 keep 返回空串（走内置兜底）', () => {
    expect(logoPreviewSrc({ kind: 'keep' }, '')).toBe('')
  })
})

describe('showsResetLogo（「恢复默认」可见性）', () => {
  it('keep 跟随是否已自定义；file 始终显示（可退回默认）；reset 隐藏', () => {
    expect(showsResetLogo({ kind: 'keep' }, false)).toBe(false)
    expect(showsResetLogo({ kind: 'keep' }, true)).toBe(true)
    expect(showsResetLogo(FILE_DRAFT, false)).toBe(true)
    expect(showsResetLogo(FILE_DRAFT, true)).toBe(true)
    expect(showsResetLogo({ kind: 'reset' }, true)).toBe(false)
  })
})

describe('validateSystemNameDraft（与主进程 isValidSystemName 等价）', () => {
  const CASES = [
    '',
    '   ',
    'Ke-Work',
    '我的工作台',
    'a'.repeat(SYSTEM_NAME_MAX_LENGTH),
    'a'.repeat(SYSTEM_NAME_MAX_LENGTH + 1),
    'a\nb',
    'a\tb',
    'a' + String.fromCharCode(0x7f) + 'b',
    '带 emoji 😀 的名字'
  ]

  it.each(CASES)('名称 %j 的判定与主进程一致', (raw) => {
    expect(validateSystemNameDraft(raw) === null).toBe(isValidSystemName(raw))
  })

  it('长度上限与主进程常量一致', () => {
    expect(SYSTEM_NAME_MAX_LENGTH).toBe(MAIN_SYSTEM_NAME_MAX_LENGTH)
  })

  it('返回可展示的错误文案', () => {
    expect(validateSystemNameDraft('  ')).toContain('不能为空')
    expect(validateSystemNameDraft('a'.repeat(99))).toContain(String(SYSTEM_NAME_MAX_LENGTH))
  })
})

describe('buildSavePlan（保存计划）', () => {
  it('无改动时计划为空（不产生任何写入）', () => {
    expect(buildSavePlan({ kind: 'keep' }, 'Ke-Work', 'Ke-Work', false)).toEqual({
      name: null,
      logo: null
    })
  })

  it('仅名称变化：写入 trim 后的值', () => {
    expect(buildSavePlan({ kind: 'keep' }, '  我的工作台  ', 'Ke-Work', false)).toEqual({
      name: '我的工作台',
      logo: null
    })
  })

  it('仅空白差异不算变化', () => {
    expect(buildSavePlan({ kind: 'keep' }, ' Ke-Work ', 'Ke-Work', false).name).toBeNull()
  })

  it('选了新文件：计划里带上传动作（名称未变则只做 LOGO）', () => {
    expect(buildSavePlan(FILE_DRAFT, 'Ke-Work', 'Ke-Work', true)).toEqual({
      name: null,
      logo: 'upload'
    })
  })

  it('恢复默认：已存自定义 LOGO 时才删除，本来就没有则视为无动作', () => {
    expect(buildSavePlan({ kind: 'reset' }, 'Ke-Work', 'Ke-Work', true).logo).toBe('reset')
    expect(buildSavePlan({ kind: 'reset' }, 'Ke-Work', 'Ke-Work', false).logo).toBeNull()
  })

  it('名称与 LOGO 同时改动：两项齐备（名称先写）', () => {
    expect(buildSavePlan(FILE_DRAFT, '新名字', '旧名字', false)).toEqual({
      name: '新名字',
      logo: 'upload'
    })
  })
})
