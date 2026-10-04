import { describe, expect, it } from 'vitest'
import { extractWeChatCode } from '../../../src/main/services/wechatAuthWindow'

describe('extractWeChatCode（微信授权回跳解析）', () => {
  const redirect = 'https://example.com/desktop-callback'

  it('回跳地址一致且带 code：返回 code（微信追加的 state 等参数不影响）', () => {
    expect(extractWeChatCode(`${redirect}?code=abc123&state=desktop`, redirect)).toBe('abc123')
  })

  it('参数顺序不同：仍按 origin+path 判定', () => {
    expect(extractWeChatCode(`https://example.com/desktop-callback?state=desktop&code=ok`, redirect)).toBe('ok')
  })

  it('origin 不一致：不匹配（防其他域名伪造回跳）', () => {
    expect(extractWeChatCode('https://evil.com/desktop-callback?code=x', redirect)).toBeNull()
  })

  it('path 不一致：不匹配', () => {
    expect(extractWeChatCode('https://example.com/other?code=x', redirect)).toBeNull()
  })

  it('无 code（例如授权被拒回跳带 error 参数）：返回 null', () => {
    expect(extractWeChatCode(`${redirect}?error=access_denied`, redirect)).toBeNull()
  })

  it('无法解析的 URL：返回 null', () => {
    expect(extractWeChatCode('not-a-url', redirect)).toBeNull()
    expect(extractWeChatCode(`${redirect}?code=x`, 'also-not-a-url')).toBeNull()
  })
})
