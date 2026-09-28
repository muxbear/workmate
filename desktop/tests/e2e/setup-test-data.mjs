/**
 * E2E 测试数据预置脚本
 * 在指定 KE_WORK_HOME 下创建 ke-work.db 并插入测试用户
 * 用法: node tests/e2e/setup-test-data.mjs <dataHome>
 */
import bcrypt from 'bcryptjs'
import { mkdirSync } from 'fs'
import { join } from 'path'

// better-sqlite3 的绑定是按 Electron ABI 编译的（见桌面版 CLAUDE.md「已知坑」）：
// 直接在纯 Node 下跑本脚本（vitest e2e、手动预置数据）会因为 ABI 不匹配加载失败。
// node:sqlite 的 DatabaseSync 在本脚本用到的 API（exec / prepare().run / close）上等价，
// 因此先试 better-sqlite3，用不了就回退——避免"想跑 e2e 得先 npm rebuild 一次、
// 跑完应用又坏了"的来回折腾。
//
// 注意：原生绑定是在**构造**时才 dlopen 的，import 成功不代表能用，
// 所以 try 必须包住 `new`。
async function openDatabase(path) {
  try {
    const { default: BetterSqlite } = await import('better-sqlite3')
    return new BetterSqlite(path)
  } catch (err) {
    console.warn('[e2e] better-sqlite3 不可用，回退到 node:sqlite：', err.message)
    const { DatabaseSync } = await import('node:sqlite')
    return new DatabaseSync(path)
  }
}

const dataHome = process.argv[2]
if (!dataHome) {
  console.error('usage: node tests/e2e/setup-test-data.mjs <dataHome>')
  process.exit(1)
}

mkdirSync(join(dataHome, 'config'), { recursive: true })
mkdirSync(join(dataHome, 'logs'), { recursive: true })
mkdirSync(join(dataHome, 'cache'), { recursive: true })
mkdirSync(join(dataHome, 'workspace'), { recursive: true })

const db = await openDatabase(join(dataHome, 'ke-work.db'))
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT,
  mobile TEXT UNIQUE,
  wechat_openid TEXT UNIQUE,
  avatar TEXT,
  work_mode TEXT NOT NULL DEFAULT 'local',
  token_hash TEXT,
  token_expire INTEGER,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  ip_address TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS sms_codes (
  mobile TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`)

const hash = bcrypt.hashSync('Secret123!', 10)
const now = Date.now()
db.prepare(
  'INSERT OR REPLACE INTO users (id, username, password_hash, mobile, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
).run('e2e-user', 'e2euser', hash, '13800138000', now, now)

db.close()
console.log(`[e2e] test data ready at ${join(dataHome, 'ke-work.db')}`)
