import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  downloadAssetToWorkspace,
  normalizeAssetRelPath,
} from '../../../src/main/agent/tools/ArtifactAssetService'

const BACKSLASH = String.fromCharCode(92)

/** 极简 PNG 魔数样本（内容无需真正可解码） */
function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
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

  it('拒绝非 http(s)、越界路径与非图片内容', async () => {
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
    ).rejects.toThrow(/非图片/)
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
