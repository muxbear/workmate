import { describe, expect, it } from 'vitest'
import {
  resolveAvatarInitial,
  resolveDisplayName
} from '../../../src/renderer/src/util/user-display'

describe('resolveDisplayName（账号显示名优先级）', () => {
  it('昵称优先于用户名与手机号', () => {
    expect(resolveDisplayName({ nickname: '老王', username: 'wangke', mobile: '138' }, 'KE')).toBe(
      '老王'
    )
  })

  it('昵称空白视为未设置，回退用户名', () => {
    expect(resolveDisplayName({ nickname: '   ', username: 'wangke', mobile: '138' }, 'KE')).toBe(
      'wangke'
    )
  })

  it('无用户名回退手机号，再回退系统名兜底文案', () => {
    expect(resolveDisplayName({ mobile: '138' }, 'KE')).toBe('138')
    expect(resolveDisplayName({}, 'KE')).toBe('KE用户')
    expect(resolveDisplayName(null, 'KE')).toBe('KE用户')
    expect(resolveDisplayName(undefined, 'KE')).toBe('KE用户')
  })
})

describe('resolveAvatarInitial（头像首字）', () => {
  it('中文取首字符；空/纯空白回退 K', () => {
    expect(resolveAvatarInitial('老王')).toBe('老')
    expect(resolveAvatarInitial('')).toBe('K')
    expect(resolveAvatarInitial('   ')).toBe('K')
  })
})
