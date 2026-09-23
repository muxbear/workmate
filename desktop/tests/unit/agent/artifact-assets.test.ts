import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  downloadAssetToWorkspace,
  normalizeAssetRelPath,
  sniffMediaMime,
  sniffVideoMime,
} from '../../../src/main/agent/tools/ArtifactAssetService'

const BACKSLASH = String.fromCharCode(92)

/** 极简 PNG 魔数样本（内容无需真正可解码） */
function pngBytes(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
}

/** ISO BMFF（mp4）魔数样本：4 字节长度 + 'ftyp' + brand */
function mp4Bytes(): Buffer {
  const bytes = Buffer.alloc(16)
  bytes.write('ftyp', 4, 'latin1')
  bytes.write('isom', 8, 'latin1')
  return bytes
}

/** EBML（webm）魔数样本 */
function webmBytes(): Buffer {
  const bytes = Buffer.alloc(16)
  bytes.set([0x1a, 0x45, 0xdf, 0xa3], 0)
  return bytes
}

/** QuickTime（mov）魔数样本：brand = 'qt  ' */
function movBytes(): Buffer {
  const bytes = Buffer.alloc(16)
  bytes.write('ftyp', 4, 'latin1')
  bytes.write('qt  ', 8, 'latin1')
  return bytes
}

/** 构造最小 fetch 替身 */
function fakeFetch(bytes: Uint8Array, contentType = 'image/png', status = 200) {
  return async () => ({
    ok: status < 400,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
    },
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  })
}

describe('downloadAssetToWorkspace（桌面版 download_asset）', () => {
  const dirs: string[] = []

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ke-work-asset-'))
    dirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('下载图片到交付目录并返回路径、大小与类型', async () => {
    const dir = tempDir()
    const result = await downloadAssetToWorkspace({
      url: 'https://cdn.example.com/a.png',
      relPath: '文章标题/figure-1.png',
      workspaceDir: dir,
      fetchImpl: fakeFetch(pngBytes()),
    })

    expect(result.mime).toBe('image/png')
    expect(result.size).toBe(9)
    expect(result.relPath).toBe('文章标题/figure-1.png')
    expect(result.absPath).toBe(join(dir, '文章标题', 'figure-1.png'))
    expect(readFileSync(result.absPath).length).toBe(9)
  })

  it('下载视频成片到交付目录并返回与 Web 端对齐的字段', async () => {
    const dir = tempDir()
    const result = await downloadAssetToWorkspace({
      url: 'https://cdn.example.com/a.mp4',
      relPath: '视频标题/成片-1.mp4',
      workspaceDir: dir,
      fetchImpl: fakeFetch(mp4Bytes(), 'video/mp4'),
    })

    expect(result.mime).toBe('video/mp4')
    expect(result.path).toBe('视频标题/成片-1.mp4')
    expect(result.mime_type).toBe('video/mp4')
    expect(readFileSync(result.absPath).length).toBe(mp4Bytes().length)
  })

  it('拒绝非 http(s)、越界路径与不支持的素材类型', async () => {
    const dir = tempDir()

    await expect(
      downloadAssetToWorkspace({ url: 'file:///d:/a.png', relPath: 'a.png', workspaceDir: dir }),
    ).rejects.toThrow(/http/)

    await expect(
      downloadAssetToWorkspace({
        url: 'https://x/a.png',
        relPath: '../escape.png',
        workspaceDir: dir,
      }),
    ).rejects.toThrow(/非法/)

    await expect(
      downloadAssetToWorkspace({
        url: 'https://x/a.html',
        relPath: 'a.html',
        workspaceDir: dir,
        fetchImpl: fakeFetch(new Uint8Array([1, 2, 3]), 'text/html'),
      }),
    ).rejects.toThrow(/不支持的素材类型/)
  })

  it('图片仍按图片上限校验（不因视频上限放宽而失效）', async () => {
    const dir = tempDir()
    await expect(
      downloadAssetToWorkspace({
        url: 'https://x/a.png',
        relPath: 'a.png',
        workspaceDir: dir,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => 'image/png' },
          arrayBuffer: async () => {
            const bytes = new Uint8Array(21 * 1024 * 1024)
            bytes.set(pngBytes(), 0)
            return bytes.buffer
          },
        }),
      }),
    ).rejects.toThrow(/图片超过大小上限/)
  })

  it('sniffMediaMime 识别常见视频容器', () => {
    expect(sniffVideoMime(mp4Bytes())).toBe('video/mp4')
    expect(sniffVideoMime(webmBytes())).toBe('video/webm')
    expect(sniffVideoMime(movBytes())).toBe('video/quicktime')
    expect(sniffMediaMime(pngBytes())).toBe('image/png')
    expect(sniffMediaMime(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull()
  })

  it('HTTP 失败与超过大小上限都拒绝', async () => {
    const dir = tempDir()

    await expect(
      downloadAssetToWorkspace({
        url: 'https://x/a.png',
        relPath: 'a.png',
        workspaceDir: dir,
        fetchImpl: fakeFetch(pngBytes(), 'image/png', 500),
      }),
    ).rejects.toThrow(/HTTP 500/)

    await expect(
      downloadAssetToWorkspace({
        url: 'https://x/a.png',
        relPath: 'a.png',
        workspaceDir: dir,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => 'image/png' },
          arrayBuffer: async () => new ArrayBuffer(21 * 1024 * 1024),
        }),
      }),
    ).rejects.toThrow(/大小上限/)
  })

  it('normalizeAssetRelPath 统一斜杠并拒绝越界', () => {
    expect(normalizeAssetRelPath('文章' + BACKSLASH + 'figure-1.png')).toBe(
      '文章/figure-1.png',
    )
    expect(() => normalizeAssetRelPath('..')).toThrow()
    expect(() => normalizeAssetRelPath('')).toThrow()
  })
})
