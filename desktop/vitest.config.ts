import { resolve } from 'path'
import { existsSync } from 'fs'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// Node 测试专用 better-sqlite3 副本（scripts/setup-node-sqlite.mjs 生成，npm test 前自动准备）：
// 存在时把 `better-sqlite3` 别名到副本（Node ABI），避免 Electron ABI 的 binding 在 Node 下加载失败
const nodeSqliteDir = resolve('node_modules/better-sqlite3-node')
const betterSqliteAlias: Record<string, string> = existsSync(nodeSqliteDir)
  ? { 'better-sqlite3': nodeSqliteDir }
  : {}

export default defineConfig({
  // 组件渲染测试用（tests/unit/components 下通过 @vue/server-renderer 做 SSR 断言）
  plugins: [vue()],
  // 渲染层源码里的 @store / @components / @renderer 别名与 electron.vite.config.ts 保持一致，
  // 否则 SSR 测试无法加载带别名的页面组件（只能测纯相对路径导入的组件）
  resolve: {
    alias: {
      ...betterSqliteAlias,
      '@renderer': resolve('src/renderer/src'),
      '@store': resolve('src/renderer/src/store'),
      '@components': resolve('src/renderer/src/components')
    }
  },
  test: {
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/security/**/*.test.ts'
    ],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: [
        'src/main/mode/**',
        'src/main/database/**',
        'src/main/security/**',
        'src/main/services/**'
      ]
    }
  }
})
