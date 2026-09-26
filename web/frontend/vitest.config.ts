import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

export default mergeConfig(viteConfig, defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    css: true,
    // 默认 5s 在整轮并行跑时不够：挂载带 Element Plus 的组件（KbDetail 这类）
    // 单次就要 2~3s，文件一多就会偶发超时，而单独跑同一用例是绿的——
    // 那种"随机红一条"的失败最消耗排查时间，这里给它留出余量。
    testTimeout: 20000,
    server: {
      deps: {
        inline: ['element-plus'],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/composables/**', 'src/stores/**', 'src/components/**'],
    },
  },
}))
