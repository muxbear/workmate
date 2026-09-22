import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceService } from '../../../src/main/workspace/WorkspaceService'
import type { WorkspaceRepository } from '../../../src/main/workspace/WorkspaceRepository'

/** 清理临时目录：非 ASCII 名先转 ASCII，规避 Windows 递归删除问题 */
function cleanupTree(dir: string): void {
  if (!existsSync(dir)) return
  for (const child of readdirSync(dir)) {
    try {
      renameSync(join(dir, child), join(dir, `tmp-${child.codePointAt(0)}`))
    } catch {
      // 已是 ASCII 名或重命名失败，交给 rmSync 兜底
    }
  }
  rmSync(dir, { recursive: true, force: true })
}

/** 仅实现 getById 的仓储替身（避免依赖 better-sqlite3 原生绑定） */
function fakeRepo(workDir: string): WorkspaceRepository {
  return {
    getById: (id: string) =>
      id === 'w1'
        ? ({ id: 'w1', name: '测试空间', path: workDir, source: 'created', userId: 'u1' } as never)
        : undefined,
  } as unknown as WorkspaceRepository
}

describe('WorkspaceService.exportZip（打包下载）', () => {
  let workDir: string
  let service: WorkspaceService

  beforeEach(() => {
    workDir = join(
      tmpdir(),
      `ke-work-zip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    )
    mkdirSync(workDir, { recursive: true })
    service = new WorkspaceService(fakeRepo(workDir), workDir)
  })

  afterEach(() => {
    cleanupTree(workDir)
  })

  it('文章 + 同名配图目录一起打包，保留目录结构', async () => {
    writeFileSync(join(workDir, '文章.md'), '# 标题', 'utf8')
    mkdirSync(join(workDir, '文章'), { recursive: true })
    writeFileSync(join(workDir, '文章', 'figure-1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const result = await service.exportZip('w1', 'u1', ['文章.md', '文章'])
    expect(result.relPath).toBe('文章.zip')
    expect(result.entries).toBe(2)
    expect(existsSync(result.absPath)).toBe(true)

    const files = unzipSync(readFileSync(result.absPath))
    expect(Object.keys(files).sort()).toEqual(['文章.md', '文章/figure-1.png'])
    expect(files['文章/figure-1.png'].length).toBe(4)
  })

  it('目录递归打包，跳过隐藏目录', async () => {
    mkdirSync(join(workDir, '交付', '.git'), { recursive: true })
    mkdirSync(join(workDir, '交付', '文章'), { recursive: true })
    writeFileSync(join(workDir, '交付', '文章.md'), 'x', 'utf8')
    writeFileSync(join(workDir, '交付', '文章', 'f.png'), 'y', 'utf8')
    writeFileSync(join(workDir, '交付', '.git', 'config'), 'z', 'utf8')

    const result = await service.exportZip('w1', 'u1', ['交付'])
    const files = unzipSync(readFileSync(result.absPath))
    expect(Object.keys(files).sort()).toEqual(['交付/文章.md', '交付/文章/f.png'])
  })

  it('指定「另存为」路径时导出到该路径（relPath 为空）', async () => {
    writeFileSync(join(workDir, '报告.md'), 'x', 'utf8')
    const dest = join(workDir, '..', `ke-work-zip-dest-${Date.now()}.zip`)

    const result = await service.exportZip('w1', 'u1', ['报告.md'], undefined, dest)
    expect(result.absPath).toBe(resolve(dest))
    expect(result.relPath).toBe('')
    expect(existsSync(dest)).toBe(true)

    const files = unzipSync(readFileSync(result.absPath))
    expect(Object.keys(files)).toEqual(['报告.md'])
    rmSync(dest, { force: true })
  })

  it('建议文件名：文章 + 同名目录 → 文章.zip', async () => {
    writeFileSync(join(workDir, '文章.md'), 'x', 'utf8')
    expect(service.suggestZipName(['文章.md', '文章'])).toBe('文章.zip')
    expect(service.suggestZipName(['文章.md'], '自定义')).toBe('自定义.zip')
  })

  it('同名导出自动追加序号；越界与空内容报错', async () => {
    writeFileSync(join(workDir, '报告.md'), 'x', 'utf8')
    const first = await service.exportZip('w1', 'u1', ['报告.md'])
    const second = await service.exportZip('w1', 'u1', ['报告.md'])
    expect(first.relPath).toBe('报告.zip')
    expect(second.relPath).toBe('报告-1.zip')

    await expect(service.exportZip('w1', 'u1', ['../escape.md'])).rejects.toThrow()
    await expect(service.exportZip('w1', 'u1', ['missing.md'])).rejects.toThrow(/没有可打包/)
  })
})
