import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // 组件渲染测试用（tests/unit/components 下通过 @vue/server-renderer 做 SSR 断言）
  plugins: [vue()],
  // 渲染层源码里的 @store / @components / @renderer 别名与 electron.vite.config.ts 保持一致，
  // 否则 SSR 测试无法加载带别名的页面组件（只能测纯相对路径导入的组件）
  resolve: {
    alias: {
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
