/**
 * 单元测试：专家版本号比对
 * - 核心三段按数值比较（1.0.10 > 1.0.9，而非字符串比较）
 * - 预发布标识低于同核心的正式版
 * - 构建元数据不参与比较
 * - 缺失 / 非法版本按 0.0.0 处理
 * - shouldUpdateExpert：本地无版本一律更新，其余仅服务端更高才更新
 */
import { describe, expect, it } from 'vitest'
import { compareExpertVersion, shouldUpdateExpert } from '../../../src/main/experts/expertVersion'

describe('compareExpertVersion', () => {
  it('EV-01: 核心三段按数值比较', () => {
    expect(compareExpertVersion('1.0.10', '1.0.9')).toBe(1)
    expect(compareExpertVersion('1.0.9', '1.0.10')).toBe(-1)
    expect(compareExpertVersion('2.0.0', '1.99.99')).toBe(1)
    expect(compareExpertVersion('1.2.0', '1.10.0')).toBe(-1)
  })

  it('EV-02: 版本相同返回 0', () => {
    expect(compareExpertVersion('1.2.3', '1.2.3')).toBe(0)
    expect(compareExpertVersion('1.2.3+build.1', '1.2.3+build.2')).toBe(0)
  })

  it('EV-03: 预发布标识低于同核心正式版', () => {
    expect(compareExpertVersion('1.0.0-beta', '1.0.0')).toBe(-1)
    expect(compareExpertVersion('1.0.0', '1.0.0-beta')).toBe(1)
    expect(compareExpertVersion('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1)
    expect(compareExpertVersion('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
  })

  it('EV-04: 构建元数据忽略，只按核心与预发布比较', () => {
    expect(compareExpertVersion('1.2.3+build.5', '1.2.4')).toBe(-1)
    expect(compareExpertVersion('1.2.3-rc.1+build.5', '1.2.3')).toBe(-1)
  })

  it('EV-05: 缺失或非法版本按 0.0.0 处理（任何合法版本都更高）', () => {
    for (const invalid of [undefined, null, '', '  ', 'abc', '1.2', 'v1.2.3', '1.2.3.4']) {
      expect(compareExpertVersion(invalid, '0.0.1')).toBe(-1)
      expect(compareExpertVersion('0.0.1', invalid)).toBe(1)
      expect(compareExpertVersion(invalid, undefined)).toBe(0)
    }
  })

  it('EV-06: 去掉首尾空格后仍可比较', () => {
    expect(compareExpertVersion(' 1.0.1 ', '1.0.0')).toBe(1)
  })
})

describe('shouldUpdateExpert', () => {
  it('EV-07: 本地无版本（本次改动前的 experts.json）→ 需要更新', () => {
    expect(shouldUpdateExpert(undefined, '1.0.0')).toBe(true)
    expect(shouldUpdateExpert(null, '1.0.0')).toBe(true)
    expect(shouldUpdateExpert('', '1.0.0')).toBe(true)
  })

  it('EV-08: 服务端版本更高 → 需要更新', () => {
    expect(shouldUpdateExpert('1.0.0', '1.0.1')).toBe(true)
    expect(shouldUpdateExpert('1.0.0', '2.0.0')).toBe(true)
    expect(shouldUpdateExpert('1.0.0-beta', '1.0.0')).toBe(true)
  })

  it('EV-09: 本地版本更高或相同 → 保留本地', () => {
    expect(shouldUpdateExpert('1.0.1', '1.0.0')).toBe(false)
    expect(shouldUpdateExpert('1.0.0', '1.0.0')).toBe(false)
    expect(shouldUpdateExpert('9.9.9', '1.0.0')).toBe(false)
    expect(shouldUpdateExpert('2.0.0', '2.0.0-beta')).toBe(false)
  })

  it('EV-10: 服务端版本非法（老服务端不返回版本）→ 保留本地', () => {
    expect(shouldUpdateExpert('1.0.0', undefined)).toBe(false)
    expect(shouldUpdateExpert('1.0.0', '')).toBe(false)
  })
})
