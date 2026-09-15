import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // 组件渲染测试用（tests/unit/components 下通过 @vue/server-renderer 做 SSR 断言）
  plugins: [vue()],
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
