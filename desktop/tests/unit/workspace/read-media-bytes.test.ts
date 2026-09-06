import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceService } from '../../../src/main/workspace/WorkspaceService'

function cleanupTree(dir: string): void {
  if (!existsSync(dir)) return
  rmSync(dir, { recursive: true, force: true })
}

describe('WorkspaceService.readMediaBytes（工作区视频字节读取）', () => {
  let baseDir: string
  let service: WorkspaceService

  beforeEach(() => {
    baseDir = join(
      tmpdir(),
      'ke-work-media-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
    )
    mkdirSync(baseDir, { recursive: true })
    const fakeRepo = {
      getById: vi.fn((id: string) => ({
        id,
        name: '媒体测试',
        path: baseDir,
        source: 'created',
        userId: 'u1',
        createdAt: 1
      }))
    }
    service = new WorkspaceService(fakeRepo as never, baseDir)
  })

  afterEach(() => cleanupTree(baseDir))

  it('读取与文章同目录的视频原始字节', async () => {
    mkdirSync(join(baseDir, '正弦余弦函数'))
    writeFileSync(join(baseDir, '正弦余弦函数', '成片-1.mp4'), Buffer.from([0, 1, 2, 3]))
    const result = await service.readMediaBytes('ws-1', 'u1', '正弦余弦函数/成片-1.mp4')
    expect(result.ext).toBe('mp4')
    expect(Array.from(result.bytes)).toEqual([0, 1, 2, 3])
  })

  it('非白名单扩展名拒绝', async () => {
    writeFileSync(join(baseDir, 'clip.avi'), Buffer.from([1]))
    await expect(service.readMediaBytes('ws-1', 'u1', 'clip.avi')).rejects.toThrow(
      /仅支持读取工作区视频文件/
    )
  })

  it('越界路径拒绝', async () => {
    await expect(service.readMediaBytes('ws-1', 'u1', '../outside.mp4')).rejects.toThrow(/越界/)
  })
})
