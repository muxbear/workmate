import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Database } from 'better-sqlite3'
import { MIGRATIONS } from './migrations'

/** 迁移目录名（基础目录内，对齐 WorkBuddy .workbuddy-sqlite-migrations） */
export const MIGRATIONS_DIR = '.ke-work-sqlite-migrations'

/** 迁移文件内多语句分隔符（对齐 WorkBuddy 迁移文件格式） */
const STATEMENT_BREAKPOINT = '--> statement-breakpoint'

/** 迁移文件命名：NNNN_名称.sql（序号 0 起，对应 user_version 1 起） */
export function migrationFileName(version: number, name: string): string {
  return `${String(version - 1).padStart(4, '0')}_${name}.sql`
}

/** 将内置迁移 SQL（分号多语句）格式化为 WorkBuddy 风格：语句间以 --> statement-breakpoint 分隔 */
export function formatMigrationFile(sql: string): string {
  const statements = sql
    .split(/;\s*(?=\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean)
  return statements.map((s) => (s.endsWith(';') ? s : `${s};`)).join(`\n${STATEMENT_BREAKPOINT}\n`) + '\n'
}

/**
 * 内置迁移种子：将 MIGRATIONS 常量写入迁移目录（不存在才写，不覆盖磁盘已有文件）。
 * 磁盘目录即迁移源（可查看、可手动追加），解决打包分发问题。
 */
export function seedMigrationFiles(dir: string): void {
  mkdirSync(dir, { recursive: true })
  for (const m of MIGRATIONS) {
    const file = join(dir, migrationFileName(m.version, m.name))
    if (!existsSync(file)) {
      writeFileSync(file, formatMigrationFile(m.sql), 'utf-8')
      console.log(`[sql-migrations] seeded: ${file}`)
    }
  }
}

/**
 * 从迁移目录应用未执行的迁移：
 * - 按 NNNN 序号排序，文件序号 NNNN 对应 user_version = NNNN + 1
 * - 同一序号下的多个文件属于同一次升级（例如用户手动追加的文件与内置同名版本共存），
 *   按文件名顺序全部执行后才推进 user_version —— 旧实现逐文件「版本已到则跳过」，
 *   排序靠后的同序号文件会被静默丢弃（升级迁移丢失）
 * - 跳过 user_version 已应用的部分；文件内按 --> statement-breakpoint 拆句执行
 */
export function runSqlMigrations(db: Database, dir: string): void {
  // 无条件补种缺失迁移文件（幂等：不存在才写，不覆盖磁盘已有文件）
  seedMigrationFiles(dir)
  const current = db.pragma('user_version', { simple: true }) as number
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_[\w-]+\.sql$/.test(f))
    .sort()
  // 按 user_version 分组（文件序号 = version - 1）
  const groups = new Map<number, string[]>()
  for (const file of files) {
    const version = Number(file.slice(0, 4)) + 1
    const group = groups.get(version)
    if (group) group.push(file)
    else groups.set(version, [file])
  }
  for (const [version, group] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (version <= current) continue
    if (group.length > 1) {
      console.warn(
        `[sql-migrations] 序号 ${String(version - 1).padStart(4, '0')} 下有多个迁移文件，按文件名顺序全部执行: ${group.join(', ')}`
      )
    }
    for (const file of group) {
      const sql = readFileSync(join(dir, file), 'utf-8')
      const statements = sql
        .split(STATEMENT_BREAKPOINT)
        .map((s) => s.trim())
        .filter(Boolean)
      for (const stmt of statements) {
        db.exec(stmt)
      }
    }
    db.pragma(`user_version = ${version}`)
    console.log(`[sql-migrations] applied: ${group.join(', ')} (user_version=${version})`)
  }
}
