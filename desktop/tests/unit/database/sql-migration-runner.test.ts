import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MIGRATIONS } from '../../../src/main/database/local/migrations'
import {
  formatMigrationFile,
  migrationFileName,
  runSqlMigrations,
  seedMigrationFiles
} from '../../../src/main/database/local/SqlMigrationRunner'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ke-mig-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function createDb(): Database.Database {
  return new Database(':memory:')
}

describe('迁移文件格式', () => {
  it('formatMigrationFile：多语句以 --> statement-breakpoint 分隔（对齐 WorkBuddy）', () => {
    const formatted = formatMigrationFile('CREATE TABLE a (x INTEGER);\n\nCREATE INDEX i ON a(x);')
    expect(formatted).toContain('--> statement-breakpoint')
    expect(formatted.split('--> statement-breakpoint')).toHaveLength(2)
  })

  it('migrationFileName：NNNN_名称.sql（序号 0 起对应版本 1）', () => {
    expect(migrationFileName(1, 'ke_work_baseline')).toBe('0000_ke_work_baseline.sql')
    expect(migrationFileName(7, 'conversation_workspaces')).toBe('0006_conversation_workspaces.sql')
  })
})

describe('seedMigrationFiles', () => {
  it('种子全量落盘：0000 起、以最新内置迁移结尾', () => {
    seedMigrationFiles(dir)
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    const last = MIGRATIONS[MIGRATIONS.length - 1]
    expect(files).toHaveLength(MIGRATIONS.length)
    expect(files[0]).toBe('0000_ke_work_baseline.sql')
    expect(files[files.length - 1]).toBe(migrationFileName(last.version, last.name))
  })

  it('不覆盖磁盘已有文件（用户手动追加/修改优先）', () => {
    seedMigrationFiles(dir)
    const target = join(dir, '0000_ke_work_baseline.sql')
    writeFileSync(target, '-- user modified', 'utf-8')
    seedMigrationFiles(dir) // 再次种子
    expect(readFileSync(target, 'utf-8')).toBe('-- user modified')
  })

  it('手动追加的迁移文件不被种子覆盖', () => {
    writeFileSync(join(dir, '0007_custom_migration.sql'), 'CREATE TABLE custom (id INTEGER);', 'utf-8')
    seedMigrationFiles(dir)
    expect(existsSync(join(dir, '0007_custom_migration.sql'))).toBe(true)
  })
})

describe('runSqlMigrations', () => {
  /** 最新内置迁移版本（内置 12 版 → user_version=12） */
  const lastVersion = (): number => MIGRATIONS[MIGRATIONS.length - 1].version

  it('种子后全量应用：user_version=最新版本 且表存在', () => {
    const db = createDb()
    runSqlMigrations(db, dir)
    expect(db.pragma('user_version', { simple: true })).toBe(lastVersion())
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get()).toBeTruthy()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'").get()).toBeTruthy()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_workspaces'").get()).toBeTruthy()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='oauth2_sessions'").get()).toBeTruthy()
    db.close()
  })

  it('已应用的跳过：重复运行不报错、version 不变', () => {
    const db = createDb()
    runSqlMigrations(db, dir)
    runSqlMigrations(db, dir)
    expect(db.pragma('user_version', { simple: true })).toBe(lastVersion())
    db.close()
  })

  it('增量追加：新增下一序号迁移文件 → 应用后 version 推进', () => {
    const db = createDb()
    runSqlMigrations(db, dir)
    const next = lastVersion() + 1
    writeFileSync(
      join(dir, migrationFileName(next, 'ke_work_extra')),
      'CREATE TABLE IF NOT EXISTS extra_table (id INTEGER);',
      'utf-8'
    )
    runSqlMigrations(db, dir)
    expect(db.pragma('user_version', { simple: true })).toBe(next)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='extra_table'").get()).toBeTruthy()
    db.close()
  })

  it('旧库推进：v8 旧库升级后补齐后续迁移', () => {
    // 模拟旧版本库：手工应用 v1-v8（不经 runSqlMigrations，避免其补种行为）
    const db = createDb()
    const OLD_VERSION = 8
    for (const m of MIGRATIONS.filter((x) => x.version <= OLD_VERSION)) {
      db.exec(m.sql)
    }
    db.pragma(`user_version = ${OLD_VERSION}`)
    // 新版本启动：从 v9 补齐到最新
    runSqlMigrations(db, dir)
    expect(db.pragma('user_version', { simple: true })).toBe(lastVersion())
    db.close()
  })

  it('同序号多文件：按文件名顺序全部执行，不静默丢弃（用户追加 + 内置版本共存）', () => {
    const db = createDb()
    runSqlMigrations(db, dir)
    const next = lastVersion() + 1
    writeFileSync(
      join(dir, migrationFileName(next, 'multi_a')),
      'CREATE TABLE IF NOT EXISTS multi_a (id INTEGER);',
      'utf-8'
    )
    writeFileSync(
      join(dir, migrationFileName(next, 'multi_b')),
      'CREATE TABLE IF NOT EXISTS multi_b (id INTEGER);',
      'utf-8'
    )
    runSqlMigrations(db, dir)
    expect(db.pragma('user_version', { simple: true })).toBe(next)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='multi_a'").get()).toBeTruthy()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='multi_b'").get()).toBeTruthy()
    db.close()
  })

  it('迁移文件含 statement-breakpoint 时按段执行（语义等价整体执行）', () => {
    const db = createDb()
    const formatted = formatMigrationFile(MIGRATIONS[0].sql)
    writeFileSync(join(dir, '0000_ke_work_baseline.sql'), formatted, 'utf-8')
    runSqlMigrations(db, dir)
    expect(db.pragma('user_version', { simple: true })).toBe(lastVersion())
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_logs'").get()).toBeTruthy()
    db.close()
  })

  it('目录不存在时自动种子', () => {
    const db = createDb()
    const missingDir = join(dir, 'nested', 'missing')
    runSqlMigrations(db, missingDir)
    expect(db.pragma('user_version', { simple: true })).toBe(lastVersion())
    expect(existsSync(missingDir)).toBe(true)
    db.close()
  })
})
