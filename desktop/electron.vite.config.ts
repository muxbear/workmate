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
