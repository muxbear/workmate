import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import { MIGRATIONS } from '../../../src/main/knowledge/KnowledgeStore'

/**
 * 迁移表的结构与效果。
 *
 * 这里用 Node 内置的 `node:sqlite` 直接跑迁移 SQL——`KnowledgeStore` 本体走
 * better-sqlite3（按 Electron ABI 编译），在 vitest 的 Node 环境里加载不了，
 * 于是迁移这块一直是"没人跑过"的盲区。
 */

/** 应用 version > after 的迁移（与 `KnowledgeStore.runMigrations` 同一增量语义） */
function applyAfter(db: DatabaseSync, after = 0, upTo = maxVersion()): void {
  for (const migration of MIGRATIONS) {
    if (migration.version <= after || migration.version > upTo) continue
    db.exec(migration.sql)
  }
}

function maxVersion(): number {
  return MIGRATIONS.reduce((max, item) => Math.max(max, item.version), 0)
}

describe('知识库索引库迁移', () => {
  it('版本号严格递增且不重复', () => {
    const versions = MIGRATIONS.map((item) => item.version)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('全部迁移可在空库上顺序执行（含 v1 建表）', () => {
    const db = new DatabaseSync(':memory:')
    expect(() => applyAfter(db)).not.toThrow()
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
    expect(tables.map((row) => row.name)).toEqual(
      expect.arrayContaining(['knowledge_bases', 'knowledge_base_documents', 'knowledge_shares'])
    )
    db.close()
  })

  it('退役云端分组：历史 kind=cloud 的库被归一为 local（否则会从侧栏消失）', () => {
    const db = new DatabaseSync(':memory:')
    // 先建到 v2：模拟升级前的老库
    applyAfter(db, 0, 2)
    const insert = db.prepare(
      `INSERT INTO knowledge_bases (id, user_id, name, description, kind, status, docs_count, size_bytes, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, 'ready', 0, 0, 1, 1)`
    )
    insert.run('kb-cloud', 'u1', '老云端分组里建的库', 'cloud')
    insert.run('kb-local', 'u1', '本地库', 'local')
    insert.run('kb-shared', 'u1', '共享库', 'shared')

    applyAfter(db, 2)

    const rows = db.prepare('SELECT id, kind FROM knowledge_bases ORDER BY id').all() as Array<{
      id: string
      kind: string
    }>
    expect(rows).toEqual([
      { id: 'kb-cloud', kind: 'local' },
      { id: 'kb-local', kind: 'local' },
      { id: 'kb-shared', kind: 'shared' }
    ])
    db.close()
  })

  it('归一后重名约束仍成立：同名的旧云端库与本地库不会再撞唯一键', () => {
    const db = new DatabaseSync(':memory:')
    applyAfter(db, 0, 2)
    const insert = db.prepare(
      `INSERT INTO knowledge_bases (id, user_id, name, description, kind, status, docs_count, size_bytes, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, 'ready', 0, 0, 1, 1)`
    )
    insert.run('kb-a', 'u1', '资料', 'cloud')
    applyAfter(db, 2)

    // 归一只是改 kind，不改名；同名再插入仍应被唯一索引挡住（语义未变）
    expect(() => insert.run('kb-b', 'u1', '资料', 'local')).toThrow()
    db.close()
  })
})
