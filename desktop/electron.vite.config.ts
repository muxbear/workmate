import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { viteStaticCopy } from 'vite-plugin-static-copy'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@router': resolve('src/renderder/src/router'),
        '@store': resolve('src/renderer/src/store'),
        '@views': resolve('src/renderer/views'),
        '@components': resolve('src/renderer/src/components')
      }
    },
    plugins: [
      vue(),
      viteStaticCopy({
        targets: [
          {
            src: resolve('node_modules/pdfjs-dist/cmaps/*').replace(/\\/g, '/'),
            dest: 'assets/pdfjs/cmaps',
            rename: { stripBase: true }
          }
        ]
      })
    ],
    optimizeDeps: {
      exclude: ['@docx-editor.dev/fonts', 'harfbuzzjs']
    },
    server: {
      // 桌面端 dev 用独立端口，避免与 Web 前端授权页（http://localhost:5173）
      // 冲突；授权 URL 由后端按 OAUTH2_FRONTEND_URL 指向 5173
      port: 5174,
      strictPort: true,
      // 配置代理
      proxy: {
        '/api': {
          target: 'http://localhost:3000',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, '')
        }
      }
    }
  }
})
