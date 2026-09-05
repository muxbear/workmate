import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDataSource } from '../../../src/main/database/local/LocalDataSource'
import { WorkspaceRepository } from '../../../src/main/workspace/WorkspaceRepository'
import { WorkspaceService } from '../../../src/main/workspace/WorkspaceService'
import { makeDocx } from './file-fixtures'

/**
 * 清理测试临时目录树。
 * 注：Node 24 + Windows 的 rimraf 递归删除含非 ASCII（中文）名的目录树会失败/崩溃
 * （vitest fork worker 中表现为静默失败或 Worker exited），先对第一层中文子项
 * 重命名为 ASCII 再删除，绕开该环境问题。
 */
function cleanupTree(dir: string): void {
  if (!existsSync(dir)) return
  for (const child of readdirSync(dir)) {
    const p = join(dir, child)
    try {
      const ascii = join(dir, `tmp-${child.codePointAt(0)}`)
      renameSync(p, ascii)
    } catch {
      // 已是 ASCII 名或删除失败，交给 rmSync 兜底
    }
  }
  rmSync(dir, { recursive: true, force: true })
}

describe('WorkspaceService', () => {
  let ds: LocalDataSource
  let repo: WorkspaceRepository
  let baseDir: string
  let service: WorkspaceService

  beforeEach(() => {
    ds = new LocalDataSource(':memory:')
    repo = new WorkspaceRepository(ds.getDb())
    baseDir = join(
      tmpdir(),
      `ke-work-ws-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    )
    mkdirSync(baseDir, { recursive: true })
    service = new WorkspaceService(repo, baseDir)
  })

  afterEach(() => {
    ds.close()
    cleanupTree(baseDir)
  })

  describe('sanitizeName', () => {
    it('合法名 trim 后通过', () => {
      expect(service.sanitizeName('  项目A  ')).toBe('项目A')
    })

    it.each(['', '   '])('空名（"%s"）拒绝', (name) => {
      expect(() => service.sanitizeName(name)).toThrow(/不能为空/)
    })

    it('超长名（51 字符）拒绝', () => {
      expect(() => service.sanitizeName('a'.repeat(51))).toThrow(/长度/)
    })

    it.each(['../x', 'a/b', 'a\\b', 'a:b', 'a<b'])('路径字符（"%s"）拒绝', (name) => {
      expect(() => service.sanitizeName(name)).toThrow(/不能包含/)
    })

    it('点/点点 拒绝', () => {
      expect(() => service.sanitizeName('.')).toThrow()
      expect(() => service.sanitizeName('..')).toThrow()
    })

    it('首尾点/空格拒绝（首尾空格经 trim 处理为合法）', () => {
      expect(() => service.sanitizeName('.hidden')).toThrow(/开头\/结尾/)
      expect(() => service.sanitizeName('a.')).toThrow(/开头\/结尾/)
      expect(service.sanitizeName(' a ')).toBe('a')
    })

    it.each(['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'lpt9'])('保留名（"%s"）拒绝', (name) => {
      expect(() => service.sanitizeName(name)).toThrow(/保留名/)
    })
  })

  describe('list（用户隔离 + 默认空间）', () => {
    it('恒含默认空间（记录与目录自动创建）', async () => {
      const rows = await service.list('u1')
      expect(rows.map((r) => r.name)).toContain('默认工作空间')
      expect(existsSync(baseDir)).toBe(true)
    })

    it('只返回当前用户的工作空间', async () => {
      service.createWorkspace('u1项目', 'u1')
      service.createWorkspace('u2项目', 'u2')
      const names = (await service.list('u1')).map((r) => r.name)
      expect(names).toHaveLength(2)
      expect(names).toContain('u1项目')
      expect(names).not.toContain('u2项目')
    })
  })

  describe('ensureDefaultWorkspace', () => {
    it('默认工作空间目录即配置路径本身（source: default、user_id 为 null）', async () => {
      const ws = await service.ensureDefaultWorkspace()
      expect(ws.source).toBe('default')
      expect(ws.name).toBe('默认工作空间')
      expect(ws.userId).toBeNull()
      expect(ws.path).toBe(baseDir)
      expect(existsSync(ws.path)).toBe(true)
    })

    it('重复调用幂等（返回同一条记录）', async () => {
      const a = await service.ensureDefaultWorkspace()
      const b = await service.ensureDefaultWorkspace()
      expect(a.id).toBe(b.id)
      expect(await service.list('u1')).toHaveLength(1)
    })

    it('记录存在但目录被删除时自动重建', async () => {
      const ws = await service.ensureDefaultWorkspace()
      rmSync(ws.path, { recursive: true, force: true })
      const again = await service.ensureDefaultWorkspace()
      expect(again.id).toBe(ws.id)
      expect(existsSync(ws.path)).toBe(true)
    })

    it('旧布局（配置值/DefaultWorkspace）自动迁移到配置路径本身', async () => {
      const legacyDir = join(baseDir, 'DefaultWorkspace')
      mkdirSync(legacyDir, { recursive: true })
      writeFileSync(join(legacyDir, 'a.txt'), 'legacy')
      const legacy = repo.create({
        name: '默认工作空间',
        path: legacyDir,
        source: 'default',
        userId: null
      })
      const ws = await service.ensureDefaultWorkspace()
      expect(ws.id).toBe(legacy.id)
      expect(ws.path).toBe(baseDir)
      expect(existsSync(join(baseDir, 'a.txt'))).toBe(true)
      expect(existsSync(legacyDir)).toBe(false)
    })

    it('存量两条默认记录时收敛为一条', async () => {
      const def = await service.ensureDefaultWorkspace()
      const legacy = repo.create({
        name: '默认工作空间',
        path: join(baseDir, 'legacy', 'DefaultWorkspace'),
        source: 'default',
        userId: null
      })
      const rows = await service.list('u1')
      const defaults = rows.filter((r) => r.source === 'default')
      expect(defaults).toHaveLength(1)
      expect(defaults[0].id).toBe(def.id)
      expect(rows.map((r) => r.id)).not.toContain(legacy.id)
    })

    it('修改默认工作空间目录：迁移文件与嵌套工作空间并更新记录', async () => {
      const oldWs = await service.ensureDefaultWorkspace()
      writeFileSync(join(baseDir, 'a.txt'), 'a')
      const created = service.createWorkspace('子空间', 'u1')
      const migrateDir = join(
        tmpdir(),
        'ke-work-ws-migrate-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
      )
      const moves = await service.changeDefaultWorkspaceDir(migrateDir)
      expect(moves.map((m) => m.workspaceId)).toContain(oldWs.id)
      const rows = await service.list('u1')
      const def = rows.find((r) => r.source === 'default')
      expect(def?.id).toBe(oldWs.id)
      expect(def?.path).toBe(migrateDir)
      expect(existsSync(join(migrateDir, 'a.txt'))).toBe(true)
      expect(existsSync(join(migrateDir, '子空间'))).toBe(true)
      expect(existsSync(join(baseDir, 'a.txt'))).toBe(false)
      const resolvedCreated = service.resolveWorkspace(created.id, 'u1')
      expect(resolvedCreated?.dir).toBe(join(migrateDir, '子空间'))
      rmSync(migrateDir, { recursive: true, force: true })
    })
  })

  describe('createWorkspace', () => {
    it('创建目录并入库（目录落在默认工作空间目录下，归属当前用户）', async () => {
      const ws = service.createWorkspace('测试项目', 'u1')
      expect(ws.source).toBe('created')
      expect(ws.userId).toBe('u1')
      expect(ws.path).toBe(join(baseDir, '测试项目'))
      expect(existsSync(ws.path)).toBe(true)
      expect(await service.list('u1')).toHaveLength(2) // 测试项目 + 默认空间
    })

    it('同名已存在拒绝（默认空间不再是同名子目录）', async () => {
      service.createWorkspace('重复', 'u1')
      expect(() => service.createWorkspace('重复', 'u1')).toThrow(/已存在/)
      // 默认工作空间即配置目录本身，DefaultWorkspace 子目录不再占用默认空间目录
      await service.ensureDefaultWorkspace()
      expect(() => service.createWorkspace('DefaultWorkspace', 'u1')).not.toThrow()
    })

    it('非法名透传 sanitize 错误', async () => {
      expect(() => service.createWorkspace('a/b', 'u1')).toThrow()
      expect(await service.list('u1')).toHaveLength(1) // 仅默认空间
    })
  })

  describe('selectExternalDir', () => {
    it('用户取消返回 null', async () => {
      const svc = new WorkspaceService(repo, baseDir, {
        selectDir: vi.fn().mockResolvedValue(null)
      })
      expect(await svc.selectExternalDir('u1')).toBeNull()
      expect(await service.list('u1')).toHaveLength(1) // 仅默认空间
    })

    it('选中目录入库（source: external）且不重复', async () => {
      const external = join(baseDir, '外部目录')
      mkdirSync(external, { recursive: true })
      const svc = new WorkspaceService(repo, baseDir, {
        selectDir: vi.fn().mockResolvedValue(external)
      })
      const a = await svc.selectExternalDir('u1')
      const b = await svc.selectExternalDir('u1')
      expect(a!.source).toBe('external')
      expect(a!.path).toBe(external)
      expect(b!.id).toBe(a!.id)
      expect(await service.list('u1')).toHaveLength(2) // 默认空间 + external
    })

    it('他人已登记目录拒绝', async () => {
      const external = join(baseDir, '他人目录')
      mkdirSync(external, { recursive: true })
      const svc = new WorkspaceService(repo, baseDir, {
        selectDir: vi.fn().mockResolvedValue(external)
      })
      await svc.selectExternalDir('u1')
      await expect(svc.selectExternalDir('u2')).rejects.toThrow(/已被其他用户/)
    })

    it('无主记录接管（NULL 旧记录归属当前用户）', async () => {
      const external = join(baseDir, '无主目录')
      mkdirSync(external, { recursive: true })
      repo.create({ name: '无主目录', path: external, source: 'external', userId: null })
      const svc = new WorkspaceService(repo, baseDir, {
        selectDir: vi.fn().mockResolvedValue(external)
      })
      const ws = await svc.selectExternalDir('u1')
      expect(ws!.userId).toBe('u1')
    })
  })

  describe('deleteWorkspace', () => {
    it('删除本人记录（磁盘目录保留）', async () => {
      const ws = service.createWorkspace('可删', 'u1')
      service.deleteWorkspace(ws.id, 'u1')
      expect((await service.list('u1')).map((r) => r.id)).not.toContain(ws.id)
      expect(existsSync(ws.path)).toBe(true)
    })

    it('默认空间不可删除', async () => {
      const def = await service.ensureDefaultWorkspace()
      expect(() => service.deleteWorkspace(def.id, 'u1')).toThrow(/默认工作空间不可删除/)
    })

    it('他人空间（不可见）删除抛错', () => {
      const ws = service.createWorkspace('他人', 'u2')
      expect(() => service.deleteWorkspace(ws.id, 'u1')).toThrow(/不存在/)
    })
  })

  describe('resolveWorkspace', () => {
    it('目录存在返回运行参数', () => {
      const ws = service.createWorkspace('解析', 'u1')
      const resolved = service.resolveWorkspace(ws.id, 'u1')
      expect(resolved).toEqual({ id: ws.id, name: '解析', dir: ws.path })
    })

    it('默认空间可解析（目录存在）', async () => {
      const def = await service.ensureDefaultWorkspace()
      const resolved = service.resolveWorkspace(def.id, 'u1')
      expect(resolved).toEqual({ id: def.id, name: '默认工作空间', dir: def.path })
    })

    it('id 不存在返回 null', () => {
      expect(service.resolveWorkspace('nope', 'u1')).toBeNull()
    })

    it('他人空间（不可见）返回 null', () => {
      const ws = service.createWorkspace('他人', 'u2')
      expect(service.resolveWorkspace(ws.id, 'u1')).toBeNull()
    })

    it('目录被删除返回 null', () => {
      const ws = service.createWorkspace('将被删', 'u1')
      // 模拟目录从原位置消失（rename 而非 rm，绕开中文路径删除的环境问题）
      renameSync(ws.path, join(baseDir, 'moved-away'))
      expect(service.resolveWorkspace(ws.id, 'u1')).toBeNull()
    })
  })

  describe('listFiles', () => {
    it('空目录返回空数组', () => {
      const ws = service.createWorkspace('empty-dir', 'u1')
      expect(service.listFiles(ws.id, 'u1')).toEqual([])
    })

    it('目录优先 + 字母序排序', () => {
      const ws = service.createWorkspace('sorted', 'u1')
      writeFileSync(join(ws.path, 'b.txt'), 'b')
      writeFileSync(join(ws.path, 'a.txt'), 'a')
      mkdirSync(join(ws.path, 'z-dir'))
      mkdirSync(join(ws.path, 'a-dir'))
      const entries = service.listFiles(ws.id, 'u1')
      expect(entries.map((e) => e.name)).toEqual(['a-dir', 'z-dir', 'a.txt', 'b.txt'])
      expect(entries.map((e) => e.type)).toEqual(['dir', 'dir', 'file', 'file'])
      expect(entries[0].relPath).toBe('a-dir')
    })

    it('隐藏名过滤（.git/node_modules/.DS_Store）', () => {
      const ws = service.createWorkspace('hidden', 'u1')
      mkdirSync(join(ws.path, '.git'))
      mkdirSync(join(ws.path, 'node_modules'))
      writeFileSync(join(ws.path, '.DS_Store'), 'x')
      writeFileSync(join(ws.path, 'visible.txt'), 'x')
      const entries = service.listFiles(ws.id, 'u1')
      expect(entries.map((e) => e.name)).toEqual(['visible.txt'])
    })

    it('relPath 子目录遍历（返回嵌套相对路径）', () => {
      const ws = service.createWorkspace('nested', 'u1')
      mkdirSync(join(ws.path, 'src', 'lib'), { recursive: true })
      writeFileSync(join(ws.path, 'src', 'main.ts'), 'x')
      const entries = service.listFiles(ws.id, 'u1', 'src')
      expect(entries.map((e) => e.relPath)).toEqual(['src/lib', 'src/main.ts'])
    })

    it('工作空间 id 不存在抛错', () => {
      expect(() => service.listFiles('nope', 'u1')).toThrow(/不存在/)
    })

    it('越界路径（../）与绝对路径拒绝', () => {
      const ws = service.createWorkspace('secure', 'u1')
      expect(() => service.listFiles(ws.id, 'u1', '../')).toThrow(/越界/)
      expect(() => service.listFiles(ws.id, 'u1', '../../etc')).toThrow(/越界/)
      expect(() => service.listFiles(ws.id, 'u1', join(tmpdir(), 'x'))).toThrow(/越界/)
    })

    it('relPath 指向文件抛错', () => {
      const ws = service.createWorkspace('file-target', 'u1')
      writeFileSync(join(ws.path, 'a.txt'), 'x')
      expect(() => service.listFiles(ws.id, 'u1', 'a.txt')).toThrow(/不是目录/)
    })

    it('超过 200 条截断', () => {
      const ws = service.createWorkspace('many', 'u1')
      for (let i = 0; i < 250; i++) {
        writeFileSync(join(ws.path, `f${String(i).padStart(3, '0')}.txt`), 'x')
      }
      const entries = service.listFiles(ws.id, 'u1')
      expect(entries.length).toBe(200)
    })
  })

  describe('readFile', () => {
    it('读取文本内容', async () => {
      const ws = service.createWorkspace('read-ok', 'u1')
      writeFileSync(join(ws.path, 'hello.txt'), '你好，ke-work', 'utf-8')
      const result = await service.readFile(ws.id, 'u1', 'hello.txt')
      expect(result.content).toBe('你好，ke-work')
      expect(result.truncated).toBe(false)
    })

    it('含 NUL 的二进制文件拒绝', async () => {
      const ws = service.createWorkspace('binary', 'u1')
      writeFileSync(join(ws.path, 'img.bin'), Buffer.from([0x89, 0x50, 0x00, 0x0a, 0x01]))
      await expect(service.readFile(ws.id, 'u1', 'img.bin')).rejects.toThrow(/二进制/)
    })

    it('docx 走专用加载器提取文本', async () => {
      const ws = service.createWorkspace('docx', 'u1')
      writeFileSync(join(ws.path, 'a.docx'), makeDocx('来自 docx 的正文'))
      const result = await service.readFile(ws.id, 'u1', 'a.docx')
      expect(result.content).toContain('来自 docx 的正文')
      expect(result.truncated).toBe(false)
    })

    it('超过 200KB 截断并置 truncated', async () => {
      const ws = service.createWorkspace('large', 'u1')
      writeFileSync(join(ws.path, 'big.log'), 'a'.repeat(250 * 1024))
      const result = await service.readFile(ws.id, 'u1', 'big.log')
      expect(result.truncated).toBe(true)
      expect(result.content.length).toBeLessThanOrEqual(200 * 1024)
    })

    it('越界路径拒绝', async () => {
      const ws = service.createWorkspace('read-secure', 'u1')
      await expect(service.readFile(ws.id, 'u1', '../secret.txt')).rejects.toThrow(/越界/)
      await expect(service.readFile(ws.id, 'u1', join(tmpdir(), 'secret.txt'))).rejects.toThrow(
        /越界/
      )
    })

    it('文件不存在 / 指向目录抛错', async () => {
      const ws = service.createWorkspace('read-missing', 'u1')
      await expect(service.readFile(ws.id, 'u1', 'nope.txt')).rejects.toThrow(/ENOENT|不存在/)
      mkdirSync(join(ws.path, 'dir'))
      await expect(service.readFile(ws.id, 'u1', 'dir')).rejects.toThrow(/不是文件/)
    })
  })

  describe('openWorkspace', () => {
    it('打开目录调用 openPath', async () => {
      const openPath = vi.fn().mockResolvedValue(undefined)
      const svc = new WorkspaceService(repo, baseDir, { openPath })
      const ws = svc.createWorkspace('打开', 'u1')
      await svc.openWorkspace(ws.id, 'u1')
      expect(openPath).toHaveBeenCalledWith(ws.path)
    })

    it('默认空间打开配置路径本身（与设置值一致）', async () => {
      const openPath = vi.fn().mockResolvedValue(undefined)
      const svc = new WorkspaceService(repo, baseDir, { openPath })
      const def = await svc.ensureDefaultWorkspace()
      await svc.openWorkspace(def.id, 'u1')
      expect(openPath).toHaveBeenCalledWith(baseDir)
    })

    it('修改默认空间目录后打开新目录（跟随设置配置值）', async () => {
      const openPath = vi.fn().mockResolvedValue(undefined)
      const svc = new WorkspaceService(repo, baseDir, { openPath })
      await svc.ensureDefaultWorkspace()
      const newDir = join(
        tmpdir(),
        'ke-work-ws-open-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
      )
      await svc.changeDefaultWorkspaceDir(newDir)
      const def = await svc.ensureDefaultWorkspace()
      await svc.openWorkspace(def.id, 'u1')
      expect(openPath).toHaveBeenCalledWith(newDir)
      rmSync(newDir, { recursive: true, force: true })
    })

    it('id 不存在抛错', async () => {
      await expect(service.openWorkspace('nope', 'u1')).rejects.toThrow(/不存在/)
    })

    it('他人空间不可打开', async () => {
      const ws = service.createWorkspace('他人', 'u2')
      await expect(service.openWorkspace(ws.id, 'u1')).rejects.toThrow(/不存在/)
    })
  })
})
