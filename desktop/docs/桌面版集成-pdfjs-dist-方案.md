# 桌面版集成 pdfjs-dist 方案

> 目标：将 WorkMate 桌面版工作空间文件预览与 Agent 附件读取中的 PDF 加载器，从 `pdf-parse` 替换为官方 `pdfjs-dist`，同时保留当前 20MB / 200KB 的加载与截断约定。
>
> 落地基线：本次以“主进程文本加载器替换”为必做项；若产品需要右侧栏展示 PDF 页面而非抽取文本，再按本文第 7 章扩展渲染层 `PdfPreview.vue`。

## 1. 现状分析

### 1.1 当前技术栈

| 层 | 实际版本 |
| --- | --- |
| Electron | 39.8.10 |
| Vue | 3.5.25 |
| TypeScript | 5.9.3 |
| electron-vite | 5.0.0 |
| Vite | 7.2.6 |
| 状态管理 | Pinia 4.0.2 |
| 当前 PDF 文本解析 | pdf-parse 1.1.1 |
| 当前 pdf-parse 内置 PDF.js | 1.10.100 |

当前 `package.json` 中直接依赖：

```jsonc
{
  "dependencies": {
    "pdf-parse": "^1.1.1"
  },
  "devDependencies": {
    "@types/pdf-parse": "^1.1.5"
  }
}
```

### 1.2 当前 PDF 加载链路

登录进入主页面后，右侧栏由 `ChatSidePanel.vue` 承载；在“工作空间文件”视图点击 PDF 文件时，当前链路为：

```text
ChatSidePanel
  -> FileList 选择文件
  -> openFile()
  -> workspaceStore.readFile()
  -> window.api.readWorkspaceFile()
  -> IPC: workspace:read-file
  -> WorkspaceService.readFile()
  -> FileLoaders.loadFileText(filePath, 'pdf')
  -> loadPdf()
  -> pdf-parse 抽取文本
  -> 返回 { content: string, truncated: boolean }
  -> FilePreview 渲染文本
```

同时，Agent 发送附件时也复用 `FileLoaders.loadFileText`：

```text
agent:send
  -> expandFileParts()
  -> classifyPath('...pdf') === 'pdf'
  -> loadFileText(path, 'pdf')
  -> 生成文本 content block 发送给模型
```

### 1.3 当前 PDF 加载器实现位置

文件：[FileLoaders.ts](D:/work/vscodeProjects/workmate/desktop/src/main/workspace/FileLoaders.ts)

关键逻辑：

```ts
const pdfParse = createRequire(import.meta.url)('pdf-parse') as typeof import('pdf-parse')

async function loadPdf(filePath: string): Promise<LoadedText> {
  const u8 = new Uint8Array(readBytes(filePath))
  const data = await pdfParse(u8 as unknown as Buffer)
  return truncateText(data.text)
}
```

现状问题：

- `pdf-parse@1.1.1` 自带 `pdf.js 1.10.100`，版本很旧，安全问题、兼容性和维护性都较差。
- `pdf-parse` 的 `index.js` 有 `module.parent` 调试分支，项目里已用 `createRequire` 走 Node 原生 require 规避；替换后这段历史 workaround 可以删除。
- `pdf-parse` 仅输出整篇文本，不能直接复用 `pdfjs-dist` 的页面渲染、文本定位、注释、结构信息等能力。
- 当前右侧栏只是“抽取文本后的纯文本预览”，并不是 PDF 页面级可视化预览。

## 2. 设计目标

1. 用官方 `pdfjs-dist` 替换 `pdf-parse`，作为桌面版唯一 PDF 加载器。
2. 第一阶段保持现有 `LoadedText` 返回结构和右侧栏文本预览行为不变，避免 UI 回归。
3. 保留 20MB 原始文件上限、200KB 文本截断、`truncated` 标记。
4. Agent 附件中的 PDF 抽取文本继续走 `FileLoaders.loadFileText`，主进程仍为文件权威来源。
5. 第二阶段可在渲染层新增 `PdfPreview.vue`，用 `pdfjs-dist` 渲染页面级预览，并复用既有 IPC 字节读取链路。
6. 不引入 CDN、不放开通用 `unsafe-eval`，worker 和 CMaps 等资源尽量走本地打包。

## 3. 技术选型

### 3.1 依赖版本

建议采用：

```jsonc
{
  "dependencies": {
    "pdfjs-dist": "^5.4.624",
    "dommatrix": "^1.0.3"
  }
}
```

说明：

- `pdfjs-dist@5.4.624` 要求 Node `>=20.16.0 || >=22.3.0`，Electron 39 内置 Node 为 22.22.1，满足要求。
- `pdfjs-dist@6.2.108` 也可用，但 engines 提高为 `>=22.13.0 || >=24`，并且 optional 依赖包含 `@napi-rs/canvas`。本项目只在渲染层使用 DOM Canvas、在主进程做文本抽取，不需要 Node Canvas，建议先停在 5.x，避免额外原生依赖。
- `dommatrix` 用于主进程 Node 环境补齐 `DOMMatrix`。渲染层浏览器环境已有原生 `DOMMatrix`，不需要额外处理。

安装命令：

```bash
npm uninstall pdf-parse @types/pdf-parse
npm install pdfjs-dist@5.4.624 dommatrix@1.0.3
```

如果安装过程中 `@napi-rs/canvas` 这类 optional 依赖触发不必要的原生构建，可显式跳过：

```bash
npm install pdfjs-dist@5.4.624 dommatrix@1.0.3 --no-optional
```

### 3.2 主进程与渲染层分工

| 位置 | 用途 | 说明 |
| --- | --- | --- |
| 主进程 `FileLoaders.ts` | PDF 文本抽取 | 替代 `pdf-parse`，为右侧栏文本预览和 Agent 附件提供文本 |
| 渲染层 `PdfPreview.vue` | 可选 PDF 页面渲染 | 使用 `pdfjs-dist` + Canvas 渲染页面，提供缩放/分页 |

第一阶段只改主进程；第二阶段新增渲染层组件，两者共用同一个 `pdfjs-dist` 依赖。

## 4. 总体架构

### 4.1 第一阶段：最小替换

```text
FilePreview.vue
  ↑ content/truncated
ChatSidePanel / Agent file-parts
  ↑ readFile()
WorkspaceService.readFile()
  ↑ loadFileText(path, 'pdf')
FileLoaders.loadPdf()
  ├─ pdfjs-dist/legacy/build/pdf.mjs
  ├─ getDocument({ data, cMapUrl, cMapPacked, standardFontDataUrl })
  └─ 逐页 getTextContent() -> truncateText()
```

### 4.2 第二阶段：页面级 PDF 预览

```text
ChatSidePanel
  └─ activeTab.kind === 'pdf'
      └─ PdfPreview.vue
          ├─ pdfjs-dist
          ├─ Canvas 渲染每页
          ├─ 页码 / 缩放 / 加载态
          └─ 本地 worker + 本地 CMaps

WorkspaceService.readFileBytes()
  -> 允许读取 pdf 字节
  -> 返回 { name, ext: 'pdf', bytes }
```

## 5. 依赖与配置文件变更

`desktop/package.json`：

- 移除 `pdf-parse`、`@types/pdf-parse`。
- 新增 `pdfjs-dist`、`dommatrix`。

`desktop/src/main/workspace/FileLoaders.ts`：

- 删除 `pdf-parse` 相关 `createRequire` 调试 workaround。
- 新增 pdfjs-dist 文本抽取实现。

如实施第二阶段，还需：

- `desktop/src/renderer/src/components/PdfPreview.vue`。
- `desktop/src/renderer/src/components/ChatSidePanel.vue`。
- `desktop/src/main/workspace/WorkspaceService.ts`。
- `desktop/electron.vite.config.ts`。
- `desktop/src/renderer/index.html`。

## 6. 主进程 `loadPdf` 替换方案

### 6.1 建议代码骨架

在 `FileLoaders.ts` 中保留现有 `LoadedText`、`MAX_BINARY_BYTES`、`MAX_TEXT_CHARS`、`readBytes`、`truncateText`，仅替换 `loadPdf`：

```ts
import { createRequire } from 'module'
import { dirname, join, sep } from 'path'
import DOMMatrix from 'dommatrix'

const require = createRequire(import.meta.url)
const PDFJS_DIST_ROOT = dirname(dirname(require.resolve('pdfjs-dist/package.json')))

const PDF_CMAP_URL = join(PDFJS_DIST_ROOT, 'cmaps') + sep
const PDF_STANDARD_FONT_DATA_URL = join(PDFJS_DIST_ROOT, 'standard_fonts') + sep

async function loadPdf(filePath: string): Promise<LoadedText> {
  const globalScope = globalThis as typeof globalThis & { DOMMatrix?: typeof DOMMatrix }
  if (!globalScope.DOMMatrix) {
    globalScope.DOMMatrix = DOMMatrix
  }

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(readBytes(filePath))
  const loadingTask = pdfjs.getDocument({
    data,
    cMapUrl: PDF_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: PDF_STANDARD_FONT_DATA_URL
  })

  try {
    const document = await loadingTask.promise
    const pages: string[] = []
    let totalLength = 0

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const textContent = await page.getTextContent()
      let pageText = ''

      for (const rawItem of textContent.items) {
        const item = rawItem as { str?: string; hasEOL?: boolean }
        if (typeof item.str !== 'string') continue
        pageText += item.str
        if (item.hasEOL) pageText += '\n'
      }

      page.cleanup()
      pages.push(pageText)
      totalLength += pageText.length + 2

      if (totalLength >= MAX_TEXT_CHARS) break
    }

    return truncateText(pages.join('\n\n'))
  } finally {
    await loadingTask.destroy()
  }
}
```

说明：

- 必须先补齐 `globalThis.DOMMatrix`，再动态 import `pdfjs-dist/legacy/build/pdf.mjs`。因为部分 pdfjs-dist 版本会在模块顶层创建 `DOMMatrix`。
- `require.resolve('pdfjs-dist/package.json')` 用于定位包根目录下的 `cmaps/` 和 `standard_fonts/`，不依赖 `process.cwd()`，打包进 asar 后更稳定。
- `cMapPacked: true` 配合本地 `cmaps/` 目录，保证中文、日文、韩文等非嵌入字体 PDF 的文本抽取。
- `standardFontDataUrl` 保证 Helvetica 等标准字体 PDF 不丢文本。
- 用 `loadingTask.destroy()` 释放 PDF.js 文档对象，避免长驻主进程内存泄漏。

### 6.2 与现有约定保持一致

- `readBytes(filePath)` 仍然执行 `statSync` 的 20MB 上限检查。
- `truncateText` 仍然按 200KB 字符截断并返回 `truncated`。
- `loadFileText` 的 `case 'pdf'` 不需要改，仍调用 `loadPdf`。
- `agent/file-parts.ts` 仍通过 `loadFileText(path, 'pdf')` 获得文本，不需要修改。

### 6.3 打包验证要点

`loadPdf` 使用动态 `import()`，electron-vite/Rollup 可能把 `pdfjs-dist` 拆成单独 chunk。验证：

```bash
npm run build
Get-ChildItem out\main
```

确认 `out/main/index.js` 和其 chunk 中能加载 `pdfjs-dist/legacy/build/pdf.mjs`，并确认 electron-builder 将动态 chunk 一并打进 asar。

## 7. 第二阶段：渲染层 PDF 页面预览

如果需求目标是“右侧栏展示 PDF 页面”，在第一阶段完成后新增 `PdfPreview.vue`。

### 7.1 组件定位

建议位置：

```text
desktop/src/renderer/src/components/PdfPreview.vue
```

与 `FilePreview.vue`、`WordEditor.vue` 平级，只负责 PDF 页面渲染。

### 7.2 Props / 状态

```ts
defineProps<{
  /** 主进程读取并返回的 pdf 字节 */
  document: Uint8Array | ArrayBuffer
  /** 文件名称，用于错误提示 */
  name: string
}>()
```

内部状态建议：

```ts
const loading = ref(true)
const error = ref('')
const totalPages = ref(0)
const scale = ref(1)
const canvases = ref<HTMLCanvasElement[]>([])
```

### 7.3 Worker 初始化

渲染层建议通过 Vite `?url` 显式引入本地 worker 文件：

```ts
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl
```

这样 worker 由 Vite 拷贝到 renderer 产物目录，避免运行时去找 CDN 或 `node_modules` 路径。

### 7.4 页面渲染

```ts
async function loadPdf(): Promise<void> {
  loading.value = true
  error.value = ''

  try {
    const data = toUint8Array(props.document)
    const task = pdfjsLib.getDocument({
      data,
      cMapUrl: cmapBaseUrl,
      cMapPacked: true
    })

    pdfTask.value = task
    const pdf = await task.promise
    totalPages.value = pdf.numPages

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const viewport = page.getViewport({ scale: scale.value })
      const canvas = document.createElement('canvas')
      canvas.width = viewport.width
      canvas.height = viewport.height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('无法创建 Canvas 上下文')

      await page.render({ canvasContext: context, viewport }).promise
      canvases.value.push(canvas)
      page.cleanup()
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'PDF 预览失败'
  } finally {
    loading.value = false
  }
}
```

模板可渲染：

```vue
<div class="pdf-preview">
  <div class="pdf-preview-toolbar">
    <span>{{ name }}</span>
    <button @click="zoomOut">缩小</button>
    <button @click="zoomIn">放大</button>
  </div>

  <div class="pdf-preview-scroll">
    <p v-if="loading">加载中…</p>
    <p v-else-if="error">{{ error }}</p>
    <template v-else>
      <div v-for="(canvas, index) in canvases" :key="index" class="pdf-preview-page">
        <span>{{ index + 1 }} / {{ totalPages }}</span>
        <canvas ref="pageCanvases" />
      </div>
    </template>
  </div>
</div>
```

### 7.5 复用主进程字节读取链路

`WorkspaceService.readFileBytes` 当前只允许 `doc/docx`，建议扩展为同时允许 `pdf`：

```ts
async readFileBytes(
  id: string,
  userId: string,
  relPath: string
): Promise<WorkspaceFileBinary> {
  const target = this.resolveFilePath(id, userId, relPath)
  const ext = extname(target).toLowerCase().replace(/^\./, '')
  const name = basename(target)

  if (ext === 'docx' || ext === 'doc') {
    const bytes = await this.wordConversionService.toDocxForPreview(target)
    return { name, ext: 'docx', bytes }
  }

  if (ext === 'pdf') {
    const buffer = await readFile(target)
    if (buffer.byteLength > MAX_BINARY_BYTES) {
      throw new Error('文件过大，暂不支持预览')
    }
    return { name, ext: 'pdf', bytes: new Uint8Array(buffer) }
  }

  throw new Error('仅支持 doc/docx/pdf 文件的字节预览')
}
```

`WorkspaceService` 需补充：

- 从 `fs/promises` 引入 `readFile`（当前文件只引入了同步 fs 方法）。
- 从 `FileLoaders` 引入 `MAX_BINARY_BYTES`，避免与 20MB 限制漂移。

### 7.6 `ChatSidePanel.vue` 分流

`FileTab` 扩展：

```ts
interface FileTab {
  key: string
  entry: WorkspaceFileEntry
  kind: 'text' | 'word' | 'pdf'
  content: string
  truncated: boolean
  document?: Uint8Array
  wordMode: 'view' | 'edit'
  loading: boolean
  error: string
}
```

打开文件时新增 PDF 分支：

```ts
if (ext === 'doc' || ext === 'docx') {
  const result = await workspaceStore.readFileBytes(panelWorkspaceId.value!, entry.relPath)
  tab.kind = 'word'
  tab.document = result.bytes
} else if (ext === 'pdf') {
  const result = await workspaceStore.readFileBytes(panelWorkspaceId.value!, entry.relPath)
  tab.kind = 'pdf'
  tab.document = result.bytes
} else {
  const result = await workspaceStore.readFile(panelWorkspaceId.value!, entry.relPath)
  tab.content = result.content
  tab.truncated = result.truncated
}
```

模板新增：

```vue
<PdfPreview
  v-else-if="activeTab.kind === 'pdf' && activeTab.document"
  :document="activeTab.document"
  :name="activeTab.entry.name"
/>
```

`PdfPreview` 使用异步组件，避免登录页和普通文件加载 PDF.js：

```ts
const PdfPreview = defineAsyncComponent(() => import('./PdfPreview.vue'))
```

### 7.7 preload 类型说明更新

`preload/index.d.ts` 中的 `WorkspaceFileBinary` 和 `readWorkspaceFileBytes` 注释从“Word 文件字节”更新为“Word/PDF 文件字节”，类型本身无需变化：

```ts
/** 工作空间 Word/PDF 文件原始字节（doc 会被主进程转换为 docx 后返回）。 */
export interface WorkspaceFileBinary {
  name: string
  ext: string
  bytes: Uint8Array
}
```

## 8. 工程配置调整

### 8.1 CSP

`desktop/src/renderer/index.html` 当前 CSP：

```html
<meta
  http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data: blob:; img-src 'self' data: blob:"
/>
```

如实施第二阶段，需要为本地 worker 放开最小权限：

```html
content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data: blob:; img-src 'self' data: blob:; connect-src 'self' data: blob:"
```

不要放开通用 `unsafe-eval`。

### 8.2 本地 CMaps 资源

为支持中文 PDF，建议把 pdfjs-dist 的 CMaps 拷贝到 renderer 输出目录。

方案一：新增 `vite-plugin-static-copy`：

```bash
npm install -D vite-plugin-static-copy
```

`electron.vite.config.ts`：

```ts
import { viteStaticCopy } from 'vite-plugin-static-copy'

renderer: {
  plugins: [
    vue(),
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/pdfjs-dist/cmaps/*',
          dest: 'assets/pdfjs/cmaps'
        }
      ]
    })
  ]
}
```

`PdfPreview.vue` 中根据实际输出路径设置：

```ts
const cmapBaseUrl = new URL('assets/pdfjs/cmaps/', document.baseURI).toString()
```

若 MVP 只处理字体已内嵌的 PDF，可暂不引入 CMaps 拷贝，但中文 PDF 兼容性会下降，不建议生产环境省略。

## 9. 安全边界

- 渲染层只传 `workspaceId + relPath`，不传绝对路径。
- 主进程继续执行 `session.requireUserId()` 和 `resolveInside()` containment 校验。
- PDF 原始文件大小由主进程统一校验，避免 IPC 传输异常大的字节。
- 不开启 `nodeIntegration`；`pdfjs-dist` 在 renderer 或主进程按职责运行。
- 不通过 CDN 加载 worker、CMaps 或字体，避免外部请求和供应链风险。
- 主进程 Node 环境只补齐 `DOMMatrix`，不引入 `canvas`、不执行任意脚本。
- CSP 仅新增 `worker-src`、`connect-src` 等最小来源，不放开 `unsafe-eval`。

## 10. 测试与验收

### 10.1 单元测试

`tests/unit/workspace/FileLoaders.test.ts` 现有 `pdf 提取文本` 用例继续保留，但不再依赖 `pdf-parse` 行为：

- 使用 `makePdf('Hello PDF')` 验证 pdfjs-dist 抽取文本包含 `Hello PDF`。
- 增加 `MAX_BINARY_BYTES + 1` 的 PDF 报“文件过大”。
- 增加超长 PDF 文本超过 200KB 时 `truncated === true` 且长度受限。
- 增加错误/损坏 PDF 返回可读错误，不泄漏底层堆栈。

`tests/unit/agent/file-parts.test.ts` 不需要改，因为 PDF 用例已 mock `loadFileText`。

### 10.2 第二阶段组件/端到端验证

如新增 `PdfPreview.vue`：

- 在“工作空间文件”中选择 PDF，右侧渲染 Canvas 页面。
- 页码、缩放、加载态正常。
- 中文 PDF 不出现缺字。
- 关闭标签或切换文件时销毁 `PDFDocumentLoadingTask`，无残留 Canvas/内存泄漏。
- 普通 `.txt`、`.md`、`.docx` 仍走原组件。

可新增：

```text
tests/e2e/pdf-preview.e2e.ts
```

### 10.3 构建验证

至少执行：

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

并检查：

- `out/main` 中 pdfjs-dist 动态 chunk 可正常加载。
- `out/renderer/assets` 中存在 `pdf.worker.min.mjs`。
- 如启用 CMaps 拷贝，确认 `out/renderer/assets/pdfjs/cmaps` 存在且数量正确。
- `npm run build:unpack` 后实际启动，打开 PDF 无黑屏、无 `DOMMatrix is not defined`、无 `No GlobalWorkerOptions.workerSrc` 报错。

## 11. 风险与应对

| 风险 | 应对 |
| --- | --- |
| pdfjs-dist 在主进程以 ESM 形式加载，electron-vite CJS 产物兼容性未知 | 先用 `legacy/build/pdf.mjs` 动态 import；构建后检查 `out/main` 产物与运行时日志 |
| Node 主进程缺少 `DOMMatrix` | import pdfjs-dist 前安装并设置 `globalThis.DOMMatrix = DOMMatrix` |
| CMaps / standard_fonts 路径错误导致中文或标准字体 PDF 抽不到文本 | 通过 `require.resolve('pdfjs-dist/package.json')` 定位包根目录，并加本地 PDF 回归用例 |
| pdfjs-dist 5.x optional 依赖引入不必要的 Node Canvas | 安装时可按需 `--no-optional`；生产代码不调用 Node Canvas |
| 大 PDF 逐页抽取阻塞主进程 | 保留 20MB 上限；抽到 200KB 即提前停止；后续如出现卡顿再迁移到 `worker_threads` |
| 文本抽取结果与 pdf-parse 存在差异 | 用同一组真实 PDF 做文本结果对比，必要时调整换行与空格归一化 |
| 第二阶段 worker/CSP 配置错误导致 PDF 页面不显示 | 采用 `?url` 显式指定本地 worker，CSP 最小放开 `worker-src`，并在 build:unpack 产物上手工验证 |
| 中文 PDF 缺字 | 本地打包 CMaps，并将 `cMapUrl` 指向正确输出目录 |
| 页面级渲染大 PDF 内存占用高 | MVP 先顺序渲染；后续使用 IntersectionObserver 惰性渲染、Canvas 复用或页码分段 |

## 12. 需要新增/修改的文件汇总

第一阶段必改：

- `desktop/src/main/workspace/FileLoaders.ts`
- `desktop/package.json`
- `desktop/package-lock.json`
- `desktop/tests/unit/workspace/FileLoaders.test.ts`

第二阶段可选：

- 新增 `desktop/src/renderer/src/components/PdfPreview.vue`
- 修改 `desktop/src/main/workspace/WorkspaceService.ts`
- 修改 `desktop/src/renderer/src/components/ChatSidePanel.vue`
- 修改 `desktop/src/preload/index.d.ts`
- 修改 `desktop/electron.vite.config.ts`
- 修改 `desktop/src/renderer/index.html`
- 新增 `desktop/tests/e2e/pdf-preview.e2e.ts`

## 13. 实施顺序

1. 先落第一阶段，替换 `loadPdf`，删掉 `pdf-parse` 及旧 workaround。
2. 跑通 `FileLoaders.test.ts` 和 `agent/file-parts.test.ts`，确认文本链路稳定。
3. 执行 `npm run build` 验证主进程动态 import 和 asar 产物。
4. 如产品确认需要页面级 PDF 预览，再实施第二阶段 `PdfPreview.vue`。
5. 补齐 CMaps、worker、CSP、e2e 和性能优化。
