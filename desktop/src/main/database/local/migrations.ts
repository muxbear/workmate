import type { Database } from 'better-sqlite3'

/** 版本化迁移：每项为 { version, name, sql }，按 user_version 增量应用；name 用于磁盘迁移文件名 */
export const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: 'ke_work_baseline',
    sql: `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT,
  mobile        TEXT UNIQUE,
  wechat_openid TEXT UNIQUE,
  avatar        TEXT,
  work_mode     TEXT NOT NULL DEFAULT 'local',
  token_hash    TEXT,
  token_expire  INTEGER,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  action     TEXT NOT NULL,
  detail     TEXT,
  ip_address TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_log_user ON audit_logs(user_id, created_at DESC);
`
  },
  {
    version: 2,
    name: 'sms_codes',
    sql: `
CREATE TABLE IF NOT EXISTS sms_codes (
  mobile     TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`
  },
  {
    // 会话数据迁移至 LangGraph checkpointer（长短期记忆统一走 LangChain 方案），删除废弃表
    version: 3,
    name: 'drop_legacy_conversations',
    sql: `
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS conversations;
`
  },
  {
    // 工作空间：为任务指定工作目录（path UNIQUE 保证外部/时间戳目录重复选择幂等）
    version: 4,
    name: 'workspaces',
    sql: `
CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL UNIQUE,
  source     TEXT NOT NULL DEFAULT 'created',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspaces_created ON workspaces(created_at DESC);
`
  },
  {
    // 会话自定义标题（重命名覆盖；列表读取时优先于此表，未覆盖时用首条消息派生标题）
    version: 5,
    name: 'conversation_titles',
    sql: `
CREATE TABLE IF NOT EXISTS conversation_titles (
  user_id         TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  title           TEXT NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, conversation_id)
);
`
  },
  {
    // 工作空间归属用户：NULL = 无主旧数据（首次加载时接管）或机器级共享的默认空间记录
    version: 6,
    name: 'workspaces_user_id',
    sql: `
ALTER TABLE workspaces ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_workspaces_user ON workspaces(user_id, created_at DESC);
`
  },
  {
    // 会话→工作空间绑定（业务表显式存储；LangGraph checkpoint metadata 不可靠，仅作历史 fallback）
    version: 7,
    name: 'conversation_workspaces',
    sql: `
CREATE TABLE IF NOT EXISTS conversation_workspaces (
  user_id         TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  workspace_id    TEXT NOT NULL,
  workspace_name  TEXT,
  workspace_dir   TEXT,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, conversation_id)
);
`
  },
  {
    // OAuth2 Web 账号绑定：users 增加 web 身份字段 + oauth2_sessions 会话索引表
    // SQLite ADD COLUMN 不支持 UNIQUE 约束，用独立唯一索引保证 1:1 绑定
    version: 8,
    name: 'oauth2_web_account',
    sql: `
ALTER TABLE users ADD COLUMN web_account_id TEXT;
ALTER TABLE users ADD COLUMN web_nickname TEXT;
ALTER TABLE users ADD COLUMN web_avatar TEXT;
ALTER TABLE users ADD COLUMN web_linked_at INTEGER;
ALTER TABLE users ADD COLUMN is_web_only INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_web_account ON users(web_account_id);

CREATE TABLE IF NOT EXISTS oauth2_sessions (
  id              TEXT PRIMARY KEY,
  local_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  web_account_id  TEXT NOT NULL,
  scope           TEXT NOT NULL DEFAULT '',
  expires_at      INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth2_sessions_user ON oauth2_sessions(local_user_id);
CREATE INDEX IF NOT EXISTS idx_oauth2_sessions_web ON oauth2_sessions(web_account_id);
`
  },
  {
    // AI 轮次展示元信息（实时发送结束补写，历史回显恢复 model/createdAt/durationMs）
    version: 9,
    name: 'conversation_turn_meta_and_artifacts',
    sql: `
CREATE TABLE IF NOT EXISTS conversation_turn_meta (
  user_id         TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  turn_index      INTEGER NOT NULL,
  model           TEXT,
  created_at_ms   INTEGER,
  duration_ms     INTEGER,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, conversation_id, turn_index)
);

CREATE TABLE IF NOT EXISTS conversation_doc_artifacts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  turn_index      INTEGER NOT NULL,
  name            TEXT NOT NULL,
  rel_path        TEXT NOT NULL,
  ext             TEXT NOT NULL,
  workspace_id    TEXT,
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_doc_artifacts_uniq
  ON conversation_doc_artifacts(user_id, conversation_id, turn_index, rel_path);
`
  }
]

/** 应用所有未执行的迁移 */
export function runMigrations(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    db.exec(migration.sql)
    db.pragma(`user_version = ${migration.version}`)
  }
}
