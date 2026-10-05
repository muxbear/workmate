import type Database from 'better-sqlite3'

/**
 * 索引库元信息仓储（R5：KnowledgeStore 拆 Repository 第六刀，纯搬移）。
 *
 * kb_meta 键值（fts5_ready / vector_backend / vector_version / communities_error:* 等）。
 * KnowledgeStore 保留同名方法作为委托门面（签名/行为不变）。
 */
export class MetaStore {
  constructor(private readonly getDb: () => Database.Database) {}

  getMeta(key: string): string | null {
    const row = this.getDb()
      .prepare('SELECT value FROM kb_meta WHERE key = ?')
      .get(key) as { value: string } | undefined
    return row ? row.value : null
  }

  setMeta(key: string, value: string): void {
    this.getDb()
      .prepare(
        "INSERT INTO kb_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(key, value)
  }
}
