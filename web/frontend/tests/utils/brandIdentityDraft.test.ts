import { describe, expect, it } from 'vitest'
import {
  SYSTEM_NAME_MAX_LENGTH,
  buildSavePlan,
  logoPreviewSrc,
  showsResetLogo,
  validateSystemNameDraft,
  type LogoDraft,
} from '@/utils/brandIdentityDraft'

/**
 * 系统标识草稿规则。
 *
 * 这些文案与桌面版 `brandIdentityDraft.ts` 逐字一致，测试按规格钉死中文字面量——
 * 改成断言含关键字就挡不住两端漂移了。
 */

const keep: LogoDraft = { kind: 'keep' }
const file: LogoDraft = { kind: 'file', file: new File(['x'], 'a.png'), url: 'blob:preview' }
const reset: LogoDraft = { kind: 'reset' }

describe('validateSystemNameDraft', () => {
  it('空与纯空白都报「不能为空」', () => {
    expect(validateSystemNameDraft('')).toBe('系统名称不能为空')
    expect(validateSystemNameDraft('   ')).toBe('系统名称不能为空')
  })

  it('超过 24 字报超长，恰好 24 字通过', () => {
    expect(validateSystemNameDraft('x'.repeat(SYSTEM_NAME_MAX_LENGTH))).toBeNull()
    expect(validateSystemNameDraft('x'.repeat(SYSTEM_NAME_MAX_LENGTH + 1))).toBe(
      '系统名称不能超过 24 个字符',
    )
  })

  it('长度按 trim 后计算', () => {
    expect(validateSystemNameDraft(' ' + 'y'.repeat(24) + ' ')).toBeNull()
  })

  it('换行、制表、DEL 都报控制字符', () => {
    const message = '系统名称不能包含换行或制表等控制字符'
    expect(validateSystemNameDraft('a\nb')).toBe(message)
    expect(validateSystemNameDraft('a\tb')).toBe(message)
    // 用 fromCharCode 而不是源码里的裸控制字节：后者会被编辑器/格式化工具悄悄吃掉
    expect(validateSystemNameDraft('a' + String.fromCharCode(0x7f) + 'b')).toBe(message)
  })

  it('正常名称通过', () => {
    expect(validateSystemNameDraft('  我的工作台  ')).toBeNull()
  })
})

describe('buildSavePlan', () => {
  it('什么都没改时不产生写入', () => {
    expect(buildSavePlan(keep, 'Ke-Work', 'Ke-Work', false)).toEqual({
      name: null,
      logo: null,
    })
  })

  it('只有两侧空白差异也算没改', () => {
    expect(buildSavePlan(keep, '  Ke-Work  ', 'Ke-Work', false).name).toBeNull()
  })

  it('名称变化时给出 trim 后的值', () => {
    expect(buildSavePlan(keep, '  新名字  ', 'Ke-Work', false).name).toBe('新名字')
  })

  it('选中新文件时计划上传，即使名称没变', () => {
    expect(buildSavePlan(file, 'Ke-Work', 'Ke-Work', false)).toEqual({
      name: null,
      logo: 'upload',
    })
  })

  it('置为恢复默认且当前确实有自定义 LOGO 时才计划 reset', () => {
    expect(buildSavePlan(reset, 'Ke-Work', 'Ke-Work', true).logo).toBe('reset')
    // 本来就是默认态，reset 是无动作——否则会多发一个没有意义的请求
    expect(buildSavePlan(reset, 'Ke-Work', 'Ke-Work', false).logo).toBeNull()
  })
})

describe('showsResetLogo', () => {
  it('选中新文件时显示（可撤回选择）', () => {
    expect(showsResetLogo(file, false)).toBe(true)
    expect(showsResetLogo(file, true)).toBe(true)
  })

  it('已置为默认态时隐藏', () => {
    expect(showsResetLogo(reset, true)).toBe(false)
  })

  it('未动过草稿时跟随「当前是否有自定义 LOGO」', () => {
    expect(showsResetLogo(keep, true)).toBe(true)
    expect(showsResetLogo(keep, false)).toBe(false)
  })
})

describe('logoPreviewSrc', () => {
  it('file 用本地 objectURL', () => {
    expect(logoPreviewSrc(file, 'https://x/logo.png')).toBe('blob:preview')
  })

  it('reset 回内置兜底（null）', () => {
    expect(logoPreviewSrc(reset, 'https://x/logo.png')).toBeNull()
  })

  it('keep 跟随后端已存值；后端没有时为 null', () => {
    expect(logoPreviewSrc(keep, 'https://x/logo.png')).toBe('https://x/logo.png')
    expect(logoPreviewSrc(keep, null)).toBeNull()
  })
})
