import { describe, expect, it } from 'vitest'
import { DEFAULT_VERSION, bumpMinorVersion, bumpPatchVersion, isValidVersion } from '@/utils/version'

describe('bumpMinorVersion（定时模板每次编辑默认递增的次版本号）', () => {
  it('递增次版本号，修订号归零', () => {
    expect(bumpMinorVersion('1.2.3')).toBe('1.3.0')
    expect(bumpMinorVersion('1.0.0')).toBe('1.1.0')
    expect(bumpMinorVersion('0.0.1')).toBe('0.1.0')
    expect(bumpMinorVersion('2.9.9')).toBe('2.10.0')
  })

  it('预发布标识与构建元数据在递增后丢弃', () => {
    expect(bumpMinorVersion('1.2.3-beta.1')).toBe('1.3.0')
    expect(bumpMinorVersion('1.2.3+build7')).toBe('1.3.0')
  })

  it('缺失或非法输入回退到 1.0.0', () => {
    expect(bumpMinorVersion(undefined)).toBe(DEFAULT_VERSION)
    expect(bumpMinorVersion(null)).toBe(DEFAULT_VERSION)
    expect(bumpMinorVersion('')).toBe(DEFAULT_VERSION)
    expect(bumpMinorVersion('abc')).toBe(DEFAULT_VERSION)
    expect(bumpMinorVersion('1.2')).toBe(DEFAULT_VERSION)
  })

  it('连续递增不回退（编辑弹窗每次都在上一次结果上再递增）', () => {
    let version = DEFAULT_VERSION
    for (let i = 0; i < 4; i += 1) version = bumpMinorVersion(version)
    expect(version).toBe('1.4.0')
  })
})

describe('bumpPatchVersion（每次编辑递增的修订号）', () => {
  it('递增修订号，主版本与次版本保持不变', () => {
    expect(bumpPatchVersion('1.0.0')).toBe('1.0.1')
    expect(bumpPatchVersion('1.2.3')).toBe('1.2.4')
    expect(bumpPatchVersion('2.10.99')).toBe('2.10.100')
  })

  it('修订号进位不受位数限制（非 0-9 循环）', () => {
    expect(bumpPatchVersion('1.0.9')).toBe('1.0.10')
  })

  it('预发布标识与构建元数据在递增后丢弃', () => {
    expect(bumpPatchVersion('1.2.3-beta.1')).toBe('1.2.4')
    expect(bumpPatchVersion('1.2.3+build')).toBe('1.2.4')
  })

  it('缺失或非法输入回退到 1.0.0', () => {
    expect(bumpPatchVersion(undefined)).toBe(DEFAULT_VERSION)
    expect(bumpPatchVersion(null)).toBe(DEFAULT_VERSION)
    expect(bumpPatchVersion('')).toBe(DEFAULT_VERSION)
    expect(bumpPatchVersion('abc')).toBe(DEFAULT_VERSION)
    expect(bumpPatchVersion('1.2')).toBe(DEFAULT_VERSION)
  })
})

describe('isValidVersion（与后端 Schema 的校验保持一致）', () => {
  it('接受标准语义化版本号', () => {
    expect(isValidVersion('1.0.0')).toBe(true)
    expect(isValidVersion('10.20.30')).toBe(true)
    expect(isValidVersion('1.2.3-beta.1')).toBe(true)
    expect(isValidVersion('1.2.3+build')).toBe(true)
  })

  it('拒绝缺段、非数字段与空串', () => {
    expect(isValidVersion('')).toBe(false)
    expect(isValidVersion('1.2')).toBe(false)
    expect(isValidVersion('1.2.3.4')).toBe(false)
    expect(isValidVersion('v1.2.3')).toBe(false)
    expect(isValidVersion('a.b.c')).toBe(false)
  })
})
