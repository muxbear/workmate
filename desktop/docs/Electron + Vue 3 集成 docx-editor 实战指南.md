# Electron + Vue 3 集成 docx-editor 实战指南

> 适用版本：Electron 39 + Vue 3.5 + TypeScript 5.9 + electron-vite 5 + Vite 7  
> docx-editor 版本：2.2.1（`@docx-editor.dev/react` / `@docx-editor.dev/core` / `@docx-editor.dev/i18n` / `@docx-editor.dev/fonts`）  

---

## 1. 结论先说

在当前阶段，**不要安装 `@docx-editor.dev/vue`**。官方 Vue 适配器虽然已经在 GitHub 仓库中，但 npm 上仍是占位包，仓库 README 也明确标注它只挂载到契约 stub，尚不可用。

推荐的落地方式是把官方已发布的 React 适配器封装成一个 Vue 组件：

```text
Vue 组件
  -> createRoot() 挂载 React 树
  -> <DocxEditor>（官方完整编辑器 UI）
  -> @docx-editor.dev/core（框架无关引擎）
```

这样业务层只依赖 Vue 组件暴露出来的 `save / focus / exec` 接口，后续官方发布 Vue 适配器后，只需替换桥接组件内部实现。

---

## 2. 安装依赖

```bash
npm install @docx-editor.dev/react @docx-editor.dev/core @docx-editor.dev/i18n @docx-editor.dev/fonts react react-dom
npm install -D @types/react @types/react-dom
```

对应 `package.json` 关键依赖：

```jsonc
{
  "dependencies": {
    "@docx-editor.dev/core": "^2.2.1",
    "@docx-editor.dev/fonts": "^2.2.1",
    "@docx-editor.dev/i18n": "^2.2.1",
    "@docx-editor.dev/react": "^2.2.1",
    "react": "^19.2.8",
    "react-dom": "^19.2.8"
  },
  "devDependencies": {
    "@types/react": "^19.2.18",
    "@types/react-dom": "^19.2.4"
  }
}
```

注意：

- `@docx-editor.dev/react` 的 peer 依赖支持 `react ^18 || ^19`。
- 当前项目使用 React 19；Vue 与 React 双框架共存是短期代价，但 React 只出现在桥接组件内部，业务层不需要写 React。
- 不要安装 `@docx-editor.dev/vue`。

---

## 3. 落地文件清单

| 文件 | 作用 |
| --- | --- |
| `src/renderer/src/editor/DocxEditorBridge.vue` | Vue ↔ React 桥接组件，核心文件 |
| `src/renderer/src/main.ts` | 引入 `@docx-editor.dev/core/styles/editor.css` |
| `src/renderer/src/App.vue` | 提供真实高度的工作区容器并挂载桥接组件 |
| `src/renderer/src/assets/main.css` | 全屏布局，修复 `body { display: flex }` 导致的黑屏 |
| `src/renderer/index.html` | CSP 放行 WebAssembly 与 blob 资源 |
| `electron.vite.config.ts` | `optimizeDeps.exclude` 修复字体与 harfbuzz wasm 加载 |

---

## 4. 核心实现

### 4.1 引入编辑器样式

在渲染进程入口一次性引入：

```ts
// src/renderer/src/main.ts
import './assets/main.css'
import '@docx-editor.dev/core/styles/editor.css'

import { createApp } from 'vue'
import App from './App.vue'

createApp(App).mount('#app')
```

### 4.2 提供有真实高度的容器

```vue
<!-- src/renderer/src/App.vue -->
<script setup lang="ts">
import DocxEditorBridge from './editor/DocxEditorBridge.vue'
</script>

<template>
  <div class="workspace">
    <DocxEditorBridge
      title="新建文档.docx"
      @ready="console.log('[DocxEditorBridge] ready')"
      @change="console.log('[DocxEditorBridge] change')"
      @font-error="(error) => console.warn('[DocxEditorBridge] font error', error)"
    />
  </div>
</template>

<style scoped>
.workspace {
  height: 100vh;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
```

关键点：`DocxEditor` 会填满父容器，所以父容器必须有真实高度。`100vh` 配合 `min-height: 0`，避免被 flex 子项压缩。

### 4.3 Vue 桥接组件

```vue
<!-- src/renderer/src/editor/DocxEditorBridge.vue -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch, type PropType } from 'vue'
import { createElement, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DocxEditor, type DocxEditorRef } from '@docx-editor.dev/react'
import { zhCN } from '@docx-editor.dev/i18n'
import { loadDefaultFonts, type DefaultFontsFragment } from '@docx-editor.dev/fonts'
import type { EditorCommand } from '@docx-editor.dev/core/contracts/editor'
import { blankDocumentBytes } from '@docx-editor.dev/core/editor'

type DocumentSource = Uint8Array | ArrayBuffer

const props = defineProps({
  /** DOCX 字节（打开文件后由主进程经 IPC 传入）。切换 identity 会触发编辑器重挂载。 */
  document: {
    type: [Uint8Array, ArrayBuffer] as unknown as PropType<DocumentSource | undefined>,
    default: undefined
  },
  /** 编辑模式：'edit'（默认）或 'view'（只读）。仅在挂载时生效。 */
  mode: {
    type: String as PropType<'edit' | 'view'>,
    default: 'edit'
  },
  /** 文档语言（引擎排版用），默认简体中文。 */
  locale: {
    type: String,
    default: 'zh-CN'
  },
  /** 标题栏显示的文件名。 */
  title: {
    type: String,
    default: '未命名文档'
  }
})

const emit = defineEmits<{
  ready: []
  change: []
  fontError: [error: unknown]
}>()

const host = ref<HTMLDivElement | null>(null)
const editorRef = ref<DocxEditorRef | null>(null)
const fonts = ref<DefaultFontsFragment | null>(null)

// 引擎在未显式传入 document 时不会绘制任何页面（M0 实测）。
// 因此始终提供一个稳定的空白文档字节作为默认文档。
const blankDocument = blankDocumentBytes()
let root: Root | null = null

const renderReact = (): void => {
  if (!host.value) return

  const reactRef: RefObject<DocxEditorRef | null> = { current: null }
  editorRef.value = null

  const element = createElement(DocxEditor, {
    document: props.document ?? blankDocument,
    mode: props.mode,
    locale: props.locale,
    i18n: zhCN,
    title: props.title,
    fonts: fonts.value ?? undefined,
    ref: reactRef,
    onReady: () => {
      editorRef.value = reactRef.current
      emit('ready')
    },
    onChange: () => emit('change'),
    onFontError: (error: unknown) => emit('fontError', error)
  })

  if (root) root.unmount()
  root = createRoot(host.value)
  root.render(element)
}

const loadFonts = async (): Promise<void> => {
  try {
    fonts.value = await loadDefaultFonts()
    renderReact()
  } catch (error) {
    // 字体加载失败时降级：引擎改用固定度量估算排版，仍可正常编辑。
    emit('fontError', error)
  }
}

/** 序列化当前文档；未就绪时返回 null。 */
const save = async (): Promise<ArrayBuffer | null> => editorRef.value?.save() ?? null

/** 聚焦编辑器（原生菜单/快捷键兜底）。 */
const focus = (): void => editorRef.value?.focus()

/** 执行引擎命令（如 text.bold / history.undo），未就绪时返回 null。 */
const exec = (command: EditorCommand) =>
  editorRef.value ? editorRef.value.exec(command) : null

defineExpose({ save, focus, exec })

onMounted(() => {
  renderReact()
  void loadFonts()
})

watch(
  () => props.document,
  () => renderReact()
)

onBeforeUnmount(() => {
  root?.unmount()
  root = null
})
</script>

<template>
  <div ref="host" class="docx-editor-host" />
</template>

<style scoped>
.docx-editor-host {
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
</style>
```

要点：

- 始终传 `blankDocumentBytes()`，否则未传 `document` 时编辑区没有页面。
- `zhCN` 保持模块常量导入，不要写成 inline 对象，否则会导致 React 内部频繁重渲染。
- `document`、`mode` 在 DocxEditor 中是挂载时生效的，切换文档用 `watch` 重挂载。
- `onChange` 只表示文档发生了 revision/identity 变化，不是 docx 字节；保存时要调用 `editorRef.value.save()`。
- 字体异步加载后重挂载一次，因此启动时 `ready` 会触发两次，这是当前实现的已知行为。

### 4.4 全屏布局修复

`src/renderer/src/assets/main.css` 至少需要：

```css
html,
body {
  height: 100%;
  margin: 0;
}

body {
  overflow: hidden;
}

#app {
  height: 100%;
  display: flex;
  flex-direction: column;
}
```

这个项目的脚手架原本保留了 `body { display: flex }`，会导致 `#app` 作为 flex 子项被压缩到内容宽度，编辑器右侧露出深色背景。移除 `body` 的 flex 后，编辑器才能全宽显示。

### 4.5 electron-vite 配置

```ts
// electron.vite.config.ts
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [vue()],
    optimizeDeps: {
      // 不要预打包 @docx-editor.dev/fonts 和 harfbuzzjs。
      exclude: ['@docx-editor.dev/fonts', 'harfbuzzjs']
    }
  }
})
```

解释：

- `@docx-editor.dev/fonts` 使用 `new URL('../assets/...', import.meta.url)` 定位字体文件。如果被 Vite 预打包，URL 会被改写到 `.vite/deps/assets/`，导致 20 个字体 404，并出现 `deps/undefined` 警告。
- `harfbuzzjs` 的 Emscripten 胶水代码会请求 `harfbuzz.wasm`。预打包后 URL 解析到 `.vite/deps/`，dev server 返回 SPA 兜底 HTML，WebAssembly 实例化时报 `expected magic word ..., found <!do`。
- 不要把 `@docx-editor.dev/react` 也加入 exclude，否则它的 `@radix-ui/*` 依赖会以裸 ESM 加载 CJS React，报 `does not provide an export named 'jsx'`。

### 4.6 CSP 配置

```html
<!-- src/renderer/index.html -->
<meta
  http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:"
/>
```

说明：

- `'wasm-unsafe-eval'` 放行 harfbuzz WebAssembly 实例化。
- `img-src ... blob:` 为图片对象 URL 预留。
- `font-src ... data: blob:` 为内嵌字体/字体资源预留。
- 不要放开通用 `unsafe-eval`，保持最低权限。

---

## 5. 文件打开/保存建议

当前仓库 M0 已完成编辑器渲染，文件 IPC 是 M1 的目标。完整集成时，不要使用编辑器内置的“下载式保存兜底”，建议通过 `editorRef.value.save()` 拿字节，再走 Electron 主进程写盘。

### 5.1 preload 类型

```ts
// src/preload/index.d.ts
export interface EditorAPI {
  openFile: () => Promise<{ canceled: boolean; path?: string; data?: Uint8Array }>
  saveFile: (path: string | undefined, data: Uint8Array) => Promise<{ canceled: boolean; path?: string }>
  saveFileAs: (data: Uint8Array) => Promise<{ canceled: boolean; path?: string }>
}

declare global {
  interface Window {
    editorAPI: EditorAPI
  }
}
```

### 5.2 渲染进程调用

```ts
const bridgeRef = ref<InstanceType<typeof DocxEditorBridge> | null>(null)

const open = async () => {
  const result = await window.editorAPI.openFile()
  if (!result.canceled && result.data) {
    // 通过 props.document 传入 bridge，触发重挂载
    currentDocument.value = result.data
    currentPath.value = result.path
  }
}

const save = async () => {
  const bytes = await bridgeRef.value?.save()
  if (bytes) {
    const result = await window.editorAPI.saveFile(currentPath.value, bytes)
    if (!result.canceled) currentPath.value = result.path
  }
}
```

主进程只负责原生文件对话框和 `fs` 写盘；路径由主进程产生，不信任渲染进程传入的任意路径。

---

## 6. 踩坑清单

| 问题 | 根因 | 修复/建议 |
| --- | --- | --- |
| 右半屏黑屏 | 脚手架 `main.css` 残留 `body { display: flex }`，`#app` 宽度被压缩到内容宽度 | 移除 `body` 的 flex；`#app` 设 `height: 100%` + 纵向 flex |
| 编辑区没有页面 | 未显式传 `document` 时引擎不绘制任何页面 | 始终传 `blankDocumentBytes()` 生成的空白文档 |
| WebAssembly 被 CSP 拦截 | `script-src 'self'` 不允许 `WebAssembly.instantiate` | CSP 增加 `'wasm-unsafe-eval'` |
| dev 下 harfbuzz wasm 加载失败 | Vite 预打包 harfbuzzjs 后 wasm URL 指向 `.vite/deps/`，dev server 返回 HTML | `optimizeDeps.exclude` 增加 `harfbuzzjs` |
| 默认字体全部 404 / `deps/undefined` | 字体包被预打包后 `import.meta.url` 被改写 | `optimizeDeps.exclude` 增加 `@docx-editor.dev/fonts` |
| `does not provide an export named 'jsx'` | 把 `@docx-editor.dev/react` 也一起 exclude，导致 Radix 依赖用裸 ESM 加载 CJS React | 不要 exclude `@docx-editor.dev/react` |
| 启动时 `ready` 触发两次 | 首渲染一次 + `loadDefaultFonts()` 完成后重挂载一次 | 当前可接受；若在意，可改为先加载字体再首渲染 |
| 误以为 `onChange` 能拿 docx 字节 | `onChange` 只是 revision/identity 变化 | 保存时调用 `editorRef.value.save()` |
| 使用内置 File → Save 直接下载 | 未传 `onSave` 时编辑器会回退到浏览器下载 | 在 Electron 中接入 `onSave` 或用 ref 的 `save()` 走 IPC |
| `mode` 或 `document` 变化不生效 | DocxEditor 的 `mode`/`document` 是挂载时生效 | 切换文档/模式时重挂载 bridge 或内部 `root.render` |

---

## 7. 验证步骤

1. 运行 `npm run dev`，确认编辑区为浅灰工作区 + 居中白色 A4 页面，无黑屏、无 `deps/undefined`、无 wasm 错误。
2. 打开控制台，确认 `ready` 触发两次、编辑内容能触发 `change`、无字体错误。
3. 用真实 Word 样张做“打开 → 编辑 → 保存 → Word 再打开”往返，重点检查样式、表格、图片、页眉页脚、分节和域。
4. 执行 `npm run build`，确认类型检查与生产构建通过。
5. 关注包体：渲染进程 JS 约 3 MB，另有 harfbuzz wasm 约 390 KB、默认字体约 8.3 MB（按需 fetch）。后续建议做路由级动态导入。

---

## 8. 后续注意事项

- **中文字体**：`@docx-editor.dev/fonts` 只覆盖 Word 默认拉丁字体，不包含中文。中文排版需要注册系统 CJK 字体（如 SimSun、微软雅黑）并做分页对拍。
- **代码分割**：编辑器较重，建议将 Word 编辑器路由做成动态导入，首屏不加载。
- **安全基线**：保持 `contextIsolation: true`，不开启 `nodeIntegration`；`.docx` 本质是不可信输入，文档数据不要直接拼进 HTML 或 URL。
- **许可边界**：基础编辑为 Apache-2.0；跟踪更改、批注、文档自动化等 Pro 能力需商业授权。
- **升级监控**：关注 `@docx-editor.dev/vue` 的正式发布。迁移时只替换 `DocxEditorBridge.vue` 内部实现，保持业务层接口不变。
