# Ke-Work 前端

Vue 3 + TypeScript + Vite + Element Plus 的 Web 前端。

## 技术栈

Vue 3（Composition API）+ TypeScript 5.5 + Vite 5 + Element Plus 2（unplugin-vue-components 自动按需导入）+ Pinia + Vue Router 4（history 模式）+ Axios + SSE + vue-i18n + SCSS + ECharts 6 + Vitest。

## 常用命令

在 `web/frontend/` 目录下执行：

```bash
npm install
npm run dev          # localhost:5173
npm run build        # 生产构建
npm run type-check   # vue-tsc --build
npm run lint         # ESLint
npm run format       # Prettier
npm test             # Vitest
```

## 目录结构

`src/` 下：`views/`（页面）、`components/`（通用组件）、`composables/`（`useXxx.ts`）、`stores/`（Pinia）、`services/`（API 层）、`router/`、`types/`、`locales/`（i18n）。

## 规范

- 组件文件 PascalCase，使用 `<script setup lang="ts">`。
- Composable 文件命名 `useXxx.ts`，驼峰命名。
- API 统一走 `src/services/request.ts` 导出的 axios 实例，响应格式 `ApiResponse<T>`。
- Token 存 `auth_tokens`（localStorage/sessionStorage），由 request 拦截器自动读取。
- 测试文件在 `tests/`，命名 `*.test.ts`。

## 环境变量

- `VITE_API_BASE_URL`：API 基础路径（默认 `/api`）。
- `VITE_ALLOW_PASTE_PASSWORD`：是否允许粘贴密码。
