import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  RemoteImageService,
  fromLocalImageUrl,
  isHttpImageUrl,
  sniffImageMime,
  toLocalImageUrl
} from '../../../src/main/images/RemoteImageService'

/** 极简 PNG 魔数样本（内容无需真正可解码） */
function pngBytes(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00])
}

function createFakeFetch(opts?: { mime?: string; status?: number; body?: Buffer }) {
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const status = opts?.status ?? 200
    if (status >= 400) {
      return new Response('err', { status })
    }
    return new Response(new Uint8Array(opts?.body ?? pngBytes()), {
      status,
      headers: { 'content-type': opts?.mime ?? 'image/png' }
    })
  })
}

describe('RemoteImageService（远程图片下载 + 落盘缓存）', () => {
  it('本地协议地址编解码往返（含查询参数/百分号/中文）', () => {
    const url =
      'https://dashscope-7c2c.oss-accelerate.aliyuncs.com/1/2.png?Expires=1788399224&Signature=%E6%98%A5%3D&name=春天.png'
    const local = toLocalImageUrl(url)
    expect(local.startsWith('ke-img://img/')).toBe(true)
    expect(fromLocalImageUrl(local)).toBe(url)
    expect(fromLocalImageUrl('ke-img://other/x')).toBeNull()
    expect(fromLocalImageUrl('https://x.com/a.png')).toBeNull()
  })

  it('isHttpImageUrl 仅放行 http(s)', () => {
    expect(isHttpImageUrl('https://a.com/1.png')).toBe(true)
    expect(isHttpImageUrl('http://a.com/1.png')).toBe(true)
    expect(isHttpImageUrl('data:image/png;base64,xx')).toBe(false)
    expect(isHttpImageUrl('file:///C:/a.png')).toBe(false)
    expect(isHttpImageUrl('')).toBe(false)
  })

  it('sniffImageMime 识别常见图片格式', () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png'
    )
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageMime(Buffer.from('GIF89a'))).toBe('image/gif')
    expect(sniffImageMime(Buffer.from('RIFFxxxxWEBP'))).toBe('image/webp')
    expect(sniffImageMime(Buffer.from(' <svg xmlns="http://www.w3.org/2000/svg">'))).toBe(
      'image/svg+xml'
    )
    expect(sniffImageMime(Buffer.from('plain text'))).toBeNull()
  })

  it('下载远程图片并落盘缓存，二次解析不再下载', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kw-img-'))
    const fetchImpl = createFakeFetch()
    const service = new RemoteImageService(dir, fetchImpl)
    const url = 'https://example.com/a.png?x=1&y=2'

    const local = await service.resolveRemoteImage(url)
    expect(fromLocalImageUrl(local)).toBe(url)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const files = readdirSync(dir)
    expect(files.some((f) => f.endsWith('.img'))).toBe(true)
    expect(files.some((f) => f.endsWith('.meta.json'))).toBe(true)

    const local2 = await service.resolveRemoteImage(url)
    expect(local2).toBe(local)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('并发解析同一 URL 只下载一次', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kw-img-'))
    const fetchImpl = createFakeFetch()
    const service = new RemoteImageService(dir, fetchImpl)
    const url = 'https://example.com/b.png'

    const [a, b] = await Promise.all([
      service.resolveRemoteImage(url),
      service.resolveRemoteImage(url)
    ])
    expect(a).toBe(b)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('拒绝非 http(s) 地址', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kw-img-'))
    const service = new RemoteImageService(dir, createFakeFetch())
    await expect(service.resolveRemoteImage('file:///C:/a.png')).rejects.toThrow(/仅支持/)
  })

  it('拒绝非图片内容', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kw-img-'))
    const service = new RemoteImageService(dir, createFakeFetch({ mime: 'text/html' }))
    await expect(service.resolveRemoteImage('https://example.com/page')).rejects.toThrow(
      /非图片内容/
    )
  })

  it('下载失败（HTTP 错误）返回错误', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kw-img-'))
    const service = new RemoteImageService(dir, createFakeFetch({ status: 500 }))
    await expect(service.resolveRemoteImage('https://example.com/err.png')).rejects.toThrow(
      /HTTP 500/
    )
  })
})
