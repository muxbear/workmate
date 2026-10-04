import { resolve } from 'path'
import { existsSync } from 'fs'
import { defineConfig } from 'vitest/config'

// 与 vitest.config.ts 相同：e2e 用例自身读 checkpoint 库时也走 Node ABI 副本
// （应用进程仍用 Electron ABI 的原包，互不影响）
const nodeSqliteDir = resolve('node_modules/better-sqlite3-node')
const betterSqliteAlias: Record<string, string> = existsSync(nodeSqliteDir)
  ? { 'better-sqlite3': nodeSqliteDir }
  : {}

// 无 .env 的环境（如 CI / 纯净 checkout）给占位模型凭据：
// agent 初始化需要 key；LangGraph 在调用模型前就会写入输入 checkpoint，
// E2E-05 只断言消息落库，模型调用失败不影响。存在 .env 时完全不注入（开发机行为不变）。
const hasEnvFile = existsSync(resolve('.env'))
const placeholderModelEnv = hasEnvFile
  ? {}
  : {
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'sk-e2e-placeholder',
      DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL ?? 'http://127.0.0.1:9'
    }

export default defineConfig({
  resolve: {
    alias: betterSqliteAlias
  },
  test: {
    include: ['tests/e2e/**/*.e2e.ts'],
    environment: 'node',
    env: placeholderModelEnv,
    testTimeout: 90_000,
    hookTimeout: 90_000
  }
})
