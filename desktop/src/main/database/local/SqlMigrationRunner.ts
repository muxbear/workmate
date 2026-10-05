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

const MIGRATION_FILE_RE = /^\d{4}_[\w-]+\.sql$/

/** 将内置迁移 SQL（分号多语句）格式化为 WorkBuddy 风格：语句间以 --> statement-breakpoint 分隔 */
export function formatMigrationFile(sql: string): string {
  const statements = sql
    .split(/;\s*(?=\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean)
  return statements.map((s) => (s.endsWith(';') ? s : `${s};`)).join(`\n${STATEMENT_BREAKPOINT}\n`) + '\n'
}

/** 一次执行的核心单元（磁盘文件与内置常量都归一到这个形态，见 applyMigrationFiles） */
export interface MigrationFileEntry {
  /** 序号（对应 user_version = version，文件序号 NNNN = version - 1） */
  version: number
  /** 来源标识（日志/告警用：磁盘为文件名） */
  label: string
  /** 迁移内容（已 formatMigrationFile 格式，含 statement-breakpoint） */
  sql: string
}

/**
 * 内置迁移序号冲突校验：同一 version 出现多个内置条目属于开发期错误
 * （磁盘上用户追加的同序号文件是设计允许的，见 applyMigrationFiles；内置重复不是）——
 * 立即抛错，由 CI 单测兜住，避免靠「静默执行两个互相矛盾的迁移」蒙混过关。
 */
export function assertNoVersionConflicts(
  migrations: ReadonlyArray<{ version: number; name: string }> = MIGRATIONS
): void {
  const seen = new Map<number, string>()
  for (const m of migrations) {
    const prev = seen.get(m.version)
    if (prev) {
      throw new Error(
        `[sql-migrations] 内置迁移序号冲突: version ${m.version} 同时存在 ${prev} 与 ${m.name}`
      )
    }
    seen.set(m.version, m.name)
  }
}

/**
 * 内置迁移种子：将 MIGRATIONS 常量写入迁移目录（不存在才写，不覆盖磁盘已有文件）。
 * 磁盘目录即迁移源（可查看、可手动追加），解决打包分发问题。
 *
 * 同名文件内容与内置版本不一致时**告警但不覆盖也不抛错**：磁盘优先是被设计允许的场景
 * （用户手动修改；测试钉死），抛错会阻断启动；同样也不能静默 —— 内置迁移在后续版本
 * 被修正而旧副本仍在磁盘时，这里是最早的发现点。
 */
export function seedMigrationFiles(dir: string): void {
  assertNoVersionConflicts()
  mkdirSync(dir, { recursive: true })
  for (const m of MIGRATIONS) {
    const file = join(dir, migrationFileName(m.version, m.name))
    const formatted = formatMigrationFile(m.sql)
    if (!existsSync(file)) {
      writeFileSync(file, formatted, 'utf-8')
      console.log(`[sql-migrations] seeded: ${file}`)
      continue
    }
    // 换行归一后再比对，避免编辑器仅改 EOL（CRLF）触发误报
    const disk = readFileSync(file, 'utf-8').replace(/\r\n/g, '\n')
    if (disk !== formatted) {
      console.warn(
        `[sql-migrations] 磁盘迁移与内置版本内容不一致，保留磁盘版本（手动修改属预期场景；若为内置修正需另行处理）: ${file}`
      )
    }
  }
}

/** 列出目录内的迁移文件；不符合命名约定的 .sql 文件告警列出（不静默忽略） */
function listMigrationFiles(dir: string): string[] {
  const sqlFiles = readdirSync(dir).filter((f) => f.endsWith('.sql'))
  const recognized = sqlFiles.filter((f) => MIGRATION_FILE_RE.test(f)).sort()
  const ignored = sqlFiles.filter((f) => !MIGRATION_FILE_RE.test(f))
  if (ignored.length > 0) {
    console.warn(
      `[sql-migrations] 目录内存在未按 NNNN_名称.sql 命名的 .sql 文件，不会被执行: ${ignored.join(', ')}`
    )
  }
  return recognized
}

/**
 * 执行核心（磁盘轨与内置轨共用，保证两轨语义一致）：
 * - 按 version 分组排序，文件序号 NNNN 对应 user_version = NNNN + 1；
 * - 同一序号下的多个文件属于同一次升级（用户手动追加的文件与内置版本共存是设计场景），
 *   按文件名顺序**全部执行**后才推进 user_version —— 旧实现逐文件「版本已到则跳过」，
 *   排序靠后的同序号文件会被静默丢弃（升级迁移丢失）；
 * - 跳过 user_version 已应用的部分；文件内按 --> statement-breakpoint 拆句执行。
 */
function applyMigrationFiles(db: Database, entries: MigrationFileEntry[]): void {
  const current = db.pragma('user_version', { simple: true }) as number
  const groups = new Map<number, MigrationFileEntry[]>()
  for (const entry of entries) {
    const group = groups.get(entry.version)
    if (group) group.push(entry)
    else groups.set(entry.version, [entry])
  }
  for (const [version, group] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (version <= current) continue
    if (group.length > 1) {
      console.warn(
        `[sql-migrations] 序号 ${String(version - 1).padStart(4, '0')} 下有多个迁移文件，按文件名顺序全部执行: ${group.map((e) => e.label).join(', ')}`
      )
    }
    for (const entry of group) {
      const statements = entry.sql
        .split(STATEMENT_BREAKPOINT)
        .map((s) => s.trim())
        .filter(Boolean)
      for (const stmt of statements) {
        db.exec(stmt)
      }
    }
    db.pragma(`user_version = ${version}`)
    console.log(`[sql-migrations] applied: ${group.map((e) => e.label).join(', ')} (user_version=${version})`)
  }
}

/** 磁盘轨：补种缺失文件 → 从目录读取 → 走执行核心 */
export function runSqlMigrations(db: Database, dir: string): void {
  // 无条件补种缺失迁移文件（幂等：不存在才写，不覆盖磁盘已有文件）
  seedMigrationFiles(dir)
  const entries: MigrationFileEntry[] = listMigrationFiles(dir).map((file) => ({
    version: Number(file.slice(0, 4)) + 1,
    label: file,
    sql: readFileSync(join(dir, file), 'utf-8')
  }))
  applyMigrationFiles(db, entries)
}

/**
 * 内置轨（无磁盘目录场景：`:memory:` 测试 / 未配置迁移目录）：
 * 内置常量按同一 formatMigrationFile 格式化后走**同一执行核心** ——
 * 与磁盘轨语义一致（分组全执行、拆句执行、user_version 推进时机相同），
 * 历史实现在 migrations.ts 里单独一份「逐条 exec」实现，与磁盘轨分歧（同序号静默跳过）。
 */
export function runBuiltInMigrations(db: Database): void {
  assertNoVersionConflicts()
  const entries: MigrationFileEntry[] = MIGRATIONS.map((m) => ({
    version: m.version,
    label: migrationFileName(m.version, m.name),
    sql: formatMigrationFile(m.sql)
  }))
  applyMigrationFiles(db, entries)
}
