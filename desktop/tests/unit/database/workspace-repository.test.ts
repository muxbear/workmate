import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDataSource } from '../../../src/main/database/local/LocalDataSource'
import { MIGRATIONS } from '../../../src/main/database/local/migrations'
import { WorkspaceRepository } from '../../../src/main/workspace/WorkspaceRepository'
import type { WorkspaceRow } from '../../../src/main/workspace/types'

describe('WorkspaceRepository（workspaces 表）', () => {
  let ds: LocalDataSource
  let repo: WorkspaceRepository

  beforeEach(() => {
    ds = new LocalDataSource(':memory:')
    repo = new WorkspaceRepository(ds.getDb())
  })

  afterEach(() => {
    ds.close()
  })

  it('WSR-01: migration 全量生效（user_version=最新版本，workspaces 含 user_id 列）', () => {
    expect(ds.getDb().pragma('user_version', { simple: true })).toBe(
      MIGRATIONS[MIGRATIONS.length - 1].version
    )
    const titles = ds
      .getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_titles'")
      .get()
    expect(titles).toBeTruthy()
    const wsBindings = ds
      .getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_workspaces'")
      .get()
    expect(wsBindings).toBeTruthy()
    const cols = ds
      .getDb()
      .prepare('PRAGMA table_info(workspaces)')
      .all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('user_id')
  })

  it('WSR-02: create + getById 往返一致（含 userId）', () => {
    const ws = repo.create({ name: '项目A', path: '/tmp/ke/项目A', source: 'created', userId: 'u1' })
    const got = repo.getById(ws.id, 'u1')
    expect(got).toEqual(ws)
    expect(got?.userId).toBe('u1')
  })

  it('WSR-03: findByPath 命中/未命中（全局无用户过滤）', () => {
    repo.create({ name: '外部', path: '/data/external', source: 'external', userId: 'u1' })
    expect(repo.findByPath('/data/external')?.name).toBe('外部')
    expect(repo.findByPath('/nope')).toBeUndefined()
  })

  it('WSR-04: listForUser 按创建时间降序', () => {
    const a = repo.create({ name: 'A', path: '/tmp/a', source: 'created', userId: 'u1' })
    const b = repo.create({ name: 'B', path: '/tmp/b', source: 'created', userId: 'u1' })
    const rows = repo.listForUser('u1')
    expect(rows.map((r) => r.id)).toEqual([b.id, a.id])
  })

  it('WSR-05: path 唯一约束（重复路径抛错）', () => {
    repo.create({ name: 'A', path: '/tmp/same', source: 'created', userId: 'u1' })
    expect(() =>
      repo.create({ name: 'B', path: '/tmp/same', source: 'timestamp', userId: 'u2' })
    ).toThrow()
  })

  it('WSR-06: delete 删除本人记录', () => {
    const ws = repo.create({ name: 'A', path: '/tmp/a', source: 'created', userId: 'u1' })
    expect(repo.delete(ws.id, 'u1')).toBe(1)
    expect(repo.getById(ws.id, 'u1')).toBeUndefined()
  })

  it('WSR-07: listForUser 只返回本用户记录（用户隔离）', () => {
    repo.create({ name: 'u1-A', path: '/tmp/u1a', source: 'created', userId: 'u1' })
    repo.create({ name: 'u2-A', path: '/tmp/u2a', source: 'created', userId: 'u2' })
    const rows = repo.listForUser('u1')
    expect(rows.map((r) => r.name)).toEqual(['u1-A'])
  })

  it('WSR-08: 无主记录由显式认领接管（幂等，默认空间除外）；listForUser 为纯查询', () => {
    // 预置无主旧数据（user_id NULL）与默认空间记录
    const orphan = repo.create({ name: '旧数据', path: '/tmp/old', source: 'created', userId: null })
    const def = repo.create({
      name: '默认工作空间',
      path: '/tmp/DefaultWorkspace',
      source: 'default',
      userId: null
    })
    // CQS：listForUser 不再夹带写——认领前无主记录对任何用户不可见，且归属不变
    expect(repo.listForUser('u1').map((r) => r.id)).toEqual([def.id])
    expect(repo.findByPath('/tmp/old')?.userId).toBeNull()
    // 显式认领：NULL 非 default 记录归属首个调用用户；default 保持共享
    repo.adoptOrphanWorkspaces('u1')
    const rowsU1 = repo.listForUser('u1')
    expect(rowsU1.map((r) => r.id)).toEqual(expect.arrayContaining([orphan.id, def.id]))
    const orphanNow = repo.findByPath('/tmp/old')
    expect(orphanNow?.userId).toBe('u1')
    const defNow = repo.findByPath('/tmp/DefaultWorkspace')
    expect(defNow?.userId).toBeNull()
    // 幂等：u2 认领不到已归属 u1 的记录
    repo.adoptOrphanWorkspaces('u2')
    const rowsU2 = repo.listForUser('u2')
    expect(rowsU2.map((r) => r.id)).toEqual([def.id])
    expect(repo.findByPath('/tmp/old')?.userId).toBe('u1')
  })

  it('WSR-09: 默认空间记录对任意用户可见（机器级共享）', () => {
    const def = repo.create({
      name: '默认工作空间',
      path: '/tmp/DefaultWorkspace',
      source: 'default',
      userId: null
    })
    expect(repo.listForUser('u1').map((r) => r.id)).toContain(def.id)
    expect(repo.listForUser('u2').map((r) => r.id)).toContain(def.id)
    expect(repo.getById(def.id, 'u1')?.source).toBe('default')
  })

  it('WSR-10: 跨用户 delete 不生效（changes=0）', () => {
    const ws = repo.create({ name: 'A', path: '/tmp/a', source: 'created', userId: 'u1' })
    expect(repo.delete(ws.id, 'u2')).toBe(0)
    expect(repo.getById(ws.id, 'u1')).toBeDefined()
  })

  it('WSR-11: adoptByPath 定向接管无主记录', () => {
    repo.create({ name: '外部', path: '/data/shared', source: 'external', userId: null })
    repo.adoptByPath('/data/shared', 'u1')
    expect(repo.findByPath('/data/shared')?.userId).toBe('u1')
    // 已归属后幂等（不覆盖）
    repo.adoptByPath('/data/shared', 'u2')
    expect((repo.findByPath('/data/shared') as WorkspaceRow).userId).toBe('u1')
  })

  it('WSR-12: 迁移后 workspaces 含 sort_order 列', () => {
    const cols = ds.getDb().prepare('PRAGMA table_info(workspaces)').all() as Array<{
      name: string
      notnull: number
    }>
    const sortColumn = cols.find((c) => c.name === 'sort_order')
    expect(sortColumn).toBeTruthy()
    expect(sortColumn?.notnull).toBe(1)
  })

  it('WSR-13: create 把新空间放在可排序区最前（sort_order 递减），默认空间恒为 0', () => {
    const def = repo.create({
      name: '默认工作空间',
      path: '/tmp/DefaultWorkspace',
      source: 'default',
      userId: null
    })
    const a = repo.create({ name: 'A', path: '/tmp/a', source: 'created', userId: 'u1' })
    const b = repo.create({ name: 'B', path: '/tmp/b', source: 'created', userId: 'u1' })
    expect(def.sortOrder).toBe(0)
    expect(a.sortOrder).toBe(-1)
    expect(b.sortOrder).toBe(-2)
    // 默认空间置顶，其余按 sort_order（新的在前）
    expect(repo.listForUser('u1').map((r) => r.name)).toEqual(['默认工作空间', 'B', 'A'])
  })

  it('WSR-14: reorder 按传入顺序回写；默认空间与他人行不被改写', () => {
    repo.create({ name: '默认工作空间', path: '/tmp/DefaultWorkspace', source: 'default', userId: null })
    const a = repo.create({ name: 'A', path: '/tmp/a', source: 'created', userId: 'u1' })
    const b = repo.create({ name: 'B', path: '/tmp/b', source: 'created', userId: 'u1' })
    const c = repo.create({ name: 'C', path: '/tmp/c', source: 'created', userId: 'u1' })
    const other = repo.create({ name: 'X', path: '/tmp/x', source: 'created', userId: 'u2' })

    // 只允许本人行：混入默认空间 id 与他人 id 时它们不被改写（changes 只数真实命中）
    const defId = repo.findByPath('/tmp/DefaultWorkspace')!.id
    const changed = repo.reorder('u1', [c.id, a.id, b.id, defId, other.id])
    expect(changed).toBe(3)
    expect(repo.listForUser('u1').map((r) => r.name)).toEqual(['默认工作空间', 'C', 'A', 'B'])
    expect(repo.getById(other.id, 'u2')?.sortOrder).toBe(other.sortOrder) // 他人行保持 create 时的初值
  })

  it('WSR-15: 列表顺序 = 默认空间置顶 → sort_order → 创建时间降序（存量行全 0 退化为旧顺序）', () => {
    // 直接插入存量行（sort_order 默认 0）模拟迁移前的历史数据
    const db = ds.getDb()
    db.prepare(
      'INSERT INTO workspaces (id, name, path, source, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('old-1', '旧1', '/tmp/old1', 'created', 'u1', 1000)
    db.prepare(
      'INSERT INTO workspaces (id, name, path, source, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('old-2', '旧2', '/tmp/old2', 'created', 'u1', 2000)
    const def = repo.create({
      name: '默认工作空间',
      path: '/tmp/DefaultWorkspace',
      source: 'default',
      userId: null
    })
    // 存量行 sort_order 全 0 → created_at DESC 兜底（旧2 晚于 旧1）
    expect(repo.listForUser('u1').map((r) => r.id)).toEqual([def.id, 'old-2', 'old-1'])
  })

  it('WSR-16: rename 只改展示名（path / sort_order / userId 均不变）', () => {
    const ws = repo.create({ name: '旧名', path: '/tmp/a', source: 'created', userId: 'u1' })
    expect(repo.rename(ws.id, '新名')).toBe(1)
    const got = repo.getById(ws.id, 'u1')
    expect(got?.name).toBe('新名')
    expect(got?.path).toBe(ws.path)
    expect(got?.sortOrder).toBe(ws.sortOrder)
    expect(got?.userId).toBe('u1')
    // 不存在的 id：changes=0
    expect(repo.rename('nope', 'X')).toBe(0)
  })

  it('WSR-17: findByName 用户隔离 + 排除自身', () => {
    const a = repo.create({ name: '项目A', path: '/tmp/a', source: 'created', userId: 'u1' })
    repo.create({ name: '项目B', path: '/tmp/b', source: 'created', userId: 'u2' })
    const def = repo.create({
      name: '默认工作空间',
      path: '/tmp/DefaultWorkspace',
      source: 'default',
      userId: null
    })
    expect(repo.findByName('项目A', 'u1', 'other')?.id).toBe(a.id)
    // 排除自身 → 不命中
    expect(repo.findByName('项目A', 'u1', a.id)).toBeUndefined()
    // 他人记录不可见；默认空间可见（与 listForUser 同域）
    expect(repo.findByName('项目B', 'u1', 'other')).toBeUndefined()
    expect(repo.findByName('默认工作空间', 'u1', 'other')?.id).toBe(def.id)
  })
})
