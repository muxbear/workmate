# 桌面版集成 docx-editor 方案

> 目标：在 WorkMate 桌面版中，为“工作空间文件”下的 `.doc`、`.docx` 文件引入 `docx-editor`，提供查看、编辑、保存 Word 文档的能力。
>
> 组件定位：新增 `WordEditor.vue`，与现有 `FilePreview.vue` 平级，负责 Word 文档的富文档预览与编辑；`FilePreview.vue` 继续负责普通文本与 Markdown 预览。

## 1. 现状分析

### 1.1 当前技术栈

| 层 | 实际版本 |
| --- | --- |
| Electron | 39.2.6 |
| Vue | 3.5.25 |
| TypeScript | 5.9.3 |
| electron-vite | 5.0.0 |
| Vite | 7.2.6 |
| 状态管理 | Pinia 4.0.2 |
| 当前 docx 文本解析 | mammoth 1.12.0 |

当前 `package.json` 中没有 React，也没有 `@docx-editor.dev/*`。

### 1.2 当前文件预览链路

登录后进入 `Home.vue`，点击左侧“Ke-Work工作空间”下的会话进入 `NewTaskPage`，右侧栏由 `ChatSidePanel` 承载。

普通文件预览链路：

```text
ChatSidePanel
  -> FileList 选择文件
  -> openFile()
  -> workspaceStore.readFile()
  -> window.api.readWorkspaceFile()
  -> IPC: workspace:read-file
  -> WorkspaceService.readFile()
  -> FileLoaders.loadFileText()
  -> 返回 { content: string, truncated: boolean }
  -> FilePreview 渲染文本/Markdown
```

当前 `.docx` 通过 `mammoth.extractRawText()` 抽取纯文本；`.doc` 走默认文本读取，因为是二进制文件，会被 NUL 嗅探拒绝，实际不支持预览。

## 2. 设计目标

1. 为 `.docx`、`.doc` 提供基于 `docx-editor` 的富文档预览。
2. 保留 docx-editor 自带的标题栏、菜单、工具栏、导航等完整包装层。
3. 新增 `WordEditor.vue`，其组件地位与 `FilePreview.vue` 相同。
4. 支持查看、编辑、保存 Word 文档。
5. 主进程继续作为文件路径和文件字节的唯一权威来源。
6. `.doc` 与 `.docx` 的读取、转换、写入均由主进程处理，渲染层只传 `workspaceId` 与 `relPath`。

## 3. 总体架构

```text
Vue 渲染层
  ChatSidePanel
    ├─ 普通文件 -> FilePreview（文本/Markdown）
    └─ doc/docx -> WordEditor（与 FilePreview 平级）
                      └─ createRoot() + React <DocxEditor>
                           ├─ 标题栏
                           ├─ 菜单
                           ├─ 工具栏
                           ├─ 导航
                           └─ 文档编辑区

Preload
  readWorkspaceFileBytes(workspaceId, relPath)
  writeWorkspaceFile(workspaceId, relPath, bytes)

主进程
  WorkspaceService
    ├─ readFileBytes()
    └─ writeFile()
  WordConversionService
    ├─ doc -> docx（打开时）
    └─ docx -> doc（保存时）
```

业务层仍然只写 Vue；React 只封装在 `WordEditor.vue` 内部。

## 4. 组件关系

```text
ChatSidePanel
  ├─ 普通文件 -> FilePreview（文本/Markdown，保持不变）
  └─ doc/docx -> WordEditor（与 FilePreview 平级）
                    └─ docx-editor 完整 chrome
                         ├─ 标题栏
                         ├─ 菜单
                         ├─ 工具栏
                         ├─ 导航
                         └─ 文档编辑区
```

`WordEditor` 不是嵌在 `FilePreview` 内部，而是同一层级的另一类预览/编辑器组件。

## 5. 依赖与版本

建议安装：

```bash
npm install @docx-editor.dev/react @docx-editor.dev/core @docx-editor.dev/i18n @docx-editor.dev/fonts react react-dom
npm install -D @types/react @types/react-dom
```

预期版本：

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

注意事项：

- 不要安装 `@docx-editor.dev/vue`，当前 npm 上仍是占位包。
- 不要把 `@docx-editor.dev/react` 加入 `optimizeDeps.exclude`。
- 保留 `mammoth`，主进程 Agent 文本提取仍然需要它。

## 6. 新增组件 WordEditor.vue

建议位置：

```text
desktop/src/renderer/src/components/WordEditor.vue
```

### 6.1 Props / Emits / Expose

```ts
defineProps<{
  /** 主进程读取并返回的 docx 字节 */
  document?: Uint8Array | ArrayBuffer
  /** 文件标题，显示在 docx-editor 自带标题栏 */
  title?: string
  /** 查看/编辑模式；docx-editor 的 mode 是挂载时生效，因此切换需要 remount */
  mode?: 'view' | 'edit'
}>()

defineEmits<{
  ready: []
  change: []
  save: [bytes: ArrayBuffer]
  fontError: [error: unknown]
}>()

defineExpose({
  save,
  focus
})
```

### 6.2 React 桥接渲染

```ts
const element = createElement(DocxEditor, {
  document: props.document ?? blankDocumentBytes(),
  mode: props.mode,
  locale: 'zh-CN',
  i18n: zhCN,
  title: props.title,
  fonts: fonts.value ?? undefined,
  ref: reactRef,
  onReady: () => {
    editorRef.value = reactRef.current
    emit('ready')
  },
  onChange: () => emit('change'),
  onFontError: (error: unknown) => emit('fontError', error),
  onSave: () => {
    void handleSave()
  }
})
```

### 6.3 保存处理

`onSave` 必须显式接入，避免 docx-editor 的 `File -> Save` 回退成浏览器下载：

```ts
async function handleSave(): Promise<void> {
  const bytes = await editorRef.value?.save()
  if (bytes) emit('save', bytes)
}
```

对外暴露：

```ts
const save = async (): Promise<ArrayBuffer | null> =>
  editorRef.value?.save() ?? null

const focus = (): void => editorRef.value?.focus()
```

### 6.4 组件外壳

`WordEditor.vue` 作为平级组件，可以有自己的顶部操作条，但不要隐藏 docx-editor 自己的 chrome：

```vue
<template>
  <div class="we">
    <div class="we-toolbar">
      <button :class="{ active: mode === 'view' }" @click="mode = 'view'">查看</button>
      <button :class="{ active: mode === 'edit' }" @click="mode = 'edit'">编辑</button>
      <button @click="handleSave">保存</button>
    </div>

    <div ref="host" class="we-host" />
  </div>
</template>
```

如果不想增加额外操作条，也可以把“查看/编辑/保存”放到 docx-editor 的 `renderTitleBarRight` 中；MVP 更简单、稳定的是外层 Vue 操作条。

## 7. ChatSidePanel.vue 分流

在 `ChatSidePanel` 中直接选择平级组件，而不是在 `FilePreview` 内部区分 Word。

### 7.1 FileTab 扩展

```ts
interface FileTab {
  key: string
  entry: WorkspaceFileEntry
  kind: 'text' | 'word'
  content: string
  truncated: boolean
  document?: Uint8Array
  wordMode: 'view' | 'edit'
  loading: boolean
  error: string
}
```

### 7.2 打开文件时分流

```ts
const ext = getExt(entry.name)

if (ext === 'doc' || ext === 'docx') {
  const result = await workspaceStore.readFileBytes(panelWorkspaceId.value!, entry.relPath)
  tab.kind = 'word'
  tab.document = result.bytes
  tab.wordMode = 'view'
} else {
  const result = await workspaceStore.readFile(panelWorkspaceId.value!, entry.relPath)
  tab.kind = 'text'
  tab.content = result.content
  tab.truncated = result.truncated
}
```

### 7.3 模板分流

```vue
<div v-if="activeTab" class="csp-view-body">
  <p v-if="activeTab.loading" class="csp-empty-tip">加载中…</p>
  <p v-else-if="activeTab.error" class="csp-load-error">{{ activeTab.error }}</p>

  <WordEditor
    v-else-if="activeTab.kind === 'word' && activeTab.document"
    :document="activeTab.document"
    :title="activeTab.entry.name"
    :mode="activeTab.wordMode"
    @save="saveActiveWord"
  />

  <FilePreview
    v-else
    :name="activeTab.entry.name"
    :rel-path="activeTab.entry.relPath"
    :content="activeTab.content"
    :truncated="activeTab.truncated"
    :show-back="false"
  />
</div>
```

`WordEditor` 使用 `defineAsyncComponent` 动态加载：

```ts
const WordEditor = defineAsyncComponent(() => import('./WordEditor.vue'))
```

这样打开普通文件不会加载 docx-editor。

## 8. 主进程读取与保存

### 8.1 读取字节

新增类型：

```ts
export interface WorkspaceFileBinary {
  name: string
  ext: string
  bytes: Uint8Array
}
```

`WorkspaceService` 新增：

```ts
resolveFilePath(id: string, userId: string, relPath: string): string

async readFileBytes(
  id: string,
  userId: string,
  relPath: string
): Promise<WorkspaceFileBinary>
```

处理逻辑：

```ts
if (ext === 'docx') {
  return {
    name,
    ext,
    bytes: new Uint8Array(await readFile(sourcePath))
  }
}

if (ext === 'doc') {
  const docxBytes = await wordConversionService.toDocxForPreview(sourcePath)
  return { name, ext: 'docx', bytes: docxBytes }
}
```

### 8.2 保存字节

新增 IPC：

```ts
ipcMain.handle(
  'workspace:write-file',
  async (_event, id?: unknown, relPath?: unknown, bytes?: unknown) => {
    // 校验 id、relPath、bytes
    // session.requireUserId()
    // workspaceService.writeFile(id, userId, relPath, bytes)
  }
)
```

`WorkspaceService.writeFile`：

```ts
async writeFile(
  id: string,
  userId: string,
  relPath: string,
  bytes: Uint8Array | ArrayBuffer
): Promise<void>
```

逻辑：

1. 解析工作空间和文件路径，执行 containment 校验。
2. 校验目标必须是文件。
3. 根据原扩展名决定写入方式：
   - `.docx`：直接写入 docx 字节。
   - `.doc`：先由主进程调用 LibreOffice 把 docx 字节转回 `.doc`，再写回原路径。
4. 写入前做临时文件转换，转换失败则不覆盖原文件。

之所以要这样，是因为 `docx-editor` 只能输出 `.docx`，不能直接输出老式 `.doc`。

## 9. WordConversionService

建议位置：

```text
desktop/src/main/workspace/WordConversionService.ts
```

职责：

```ts
class WordConversionService {
  toDocxForPreview(sourcePath: string): Promise<Uint8Array>
  toLegacyDoc(docxBytes: Uint8Array): Promise<Uint8Array>
}
```

`.doc` 处理策略：

| 场景 | 处理方式 |
| --- | --- |
| 打开 `.docx` | 主进程直接读 `.docx` 字节，传给 `WordEditor` |
| 打开 `.doc` | 主进程先通过 LibreOffice 转成 `.docx`，再传给 `WordEditor` |
| 保存 `.docx` | 主进程直接写回 `.docx` |
| 保存 `.doc` | 主进程先通过 LibreOffice 把 docx 转回 `.doc`，再写回原路径 |
| LibreOffice 不存在 | `.doc` 只能查看，保存时明确报错，不覆盖原文件 |

LibreOffice 查找顺序建议：

- 环境变量 `LIBREOFFICE_BINARY`
- Windows 常见安装路径
- macOS 常见安装路径
- `soffice` / `libreoffice` 命令

## 10. Preload 与 Store

`preload/index.ts` 新增：

```ts
readWorkspaceFileBytes(workspaceId: string, relPath: string) {
  return ipcRenderer.invoke('workspace:read-file-bytes', workspaceId, relPath)
},

writeWorkspaceFile(
  workspaceId: string,
  relPath: string,
  bytes: Uint8Array | ArrayBuffer
) {
  return ipcRenderer.invoke('workspace:write-file', workspaceId, relPath, bytes)
}
```

`preload/index.d.ts` 新增类型：

```ts
readWorkspaceFileBytes(
  workspaceId: string,
  relPath: string
): Promise<IpcResult<WorkspaceFileBinary>>

writeWorkspaceFile(
  workspaceId: string,
  relPath: string,
  bytes: Uint8Array | ArrayBuffer
): Promise<IpcResult<null>>
```

`store/workspace.ts` 新增：

```ts
async function readFileBytes(
  workspaceId: string,
  relPath: string
): Promise<WorkspaceFileBinary> {
  const result = await window.api.readWorkspaceFileBytes(workspaceId, relPath)
  if (!result.success || !result.data) {
    throw new Error(result.error || '读取文件失败')
  }
  return result.data
}

async function saveFile(
  workspaceId: string,
  relPath: string,
  bytes: Uint8Array | ArrayBuffer
): Promise<void> {
  const result = await window.api.writeWorkspaceFile(workspaceId, relPath, bytes)
  if (!result.success) {
    throw new Error(result.error || '保存文件失败')
  }
}
```

## 11. 工程配置调整

### 11.1 引入编辑器样式

在 `desktop/src/renderer/src/main.ts` 中：

```ts
import '@docx-editor.dev/core/styles/editor.css'
```

### 11.2 electron-vite 配置

在 `desktop/electron.vite.config.ts` 的 `renderer` 增加：

```ts
optimizeDeps: {
  exclude: ['@docx-editor.dev/fonts', 'harfbuzzjs']
}
```

不要 exclude `@docx-editor.dev/react`。

### 11.3 全局布局

确保 `WordEditor` 的宿主容器有真实高度：

```css
html,
body,
#app {
  height: 100%;
  min-height: 0;
}

body {
  overflow: hidden;
}

#app {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
}
```

需要回归验证登录页、Home 布局没有被破坏。

### 11.4 CSP

在 `desktop/src/renderer/index.html` 中：

```html
<meta
  http-equiv="Content-Security-Policy"
  content="
    default-src 'self';
    script-src 'self' 'wasm-unsafe-eval';
    style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
    font-src 'self' https://fonts.gstatic.com data: blob:;
    img-src 'self' data: blob:;
  "
/>
```

只放开 `'wasm-unsafe-eval'`，不要放开通用 `unsafe-eval`。

## 12. 安全边界

- 渲染层只传 `workspaceId + relPath`，不传绝对路径。
- 主进程继续做 `session.requireUserId()` 和 containment 校验。
- `.doc` 转换使用主进程创建的临时目录，结束后清理。
- 文件大小在主进程校验，避免 IPC 传输异常大的字节。
- 不开启 `nodeIntegration`；`docx-editor` 只在 renderer 内运行。
- 不把 `.docx` 内容直接拼进 HTML 或 URL。
- CSP 只新增 `wasm-unsafe-eval`、`blob:` 等最小权限。

## 13. 测试与验收

### 13.1 单元测试

- 保留并继续通过现有 `FileLoaders.test.ts`，确认 `mammoth` 抽文本能力不受影响。
- 新增 `WordConversionService.test.ts`：
  - `.docx` 直接读取成功；
  - `.doc` 在假 LibreOffice 可用时成功转换；
  - `.doc` 找不到 LibreOffice 时返回可读错误；
  - 临时目录清理逻辑。

### 13.2 手工验收

查看：

- 在“工作空间文件”中选择 `.docx`，右侧渲染 `WordEditor`。
- 能看到 docx-editor 自带的标题栏、菜单、工具栏、导航。
- 文档内容正常显示。

编辑：

- 切换到“编辑”模式后可以修改文档。
- `change` 事件正常触发。
- docx-editor 的 `File -> Save` 不会触发浏览器下载。

保存：

- 保存 `.docx` 后，重新打开文件内容与编辑结果一致。
- 保存 `.doc` 时，主进程完成 `docx -> doc` 转换后再写回原文件。
- 转换失败时不覆盖原文件，并给出明确错误提示。

回归：

- `.txt`、`.md` 等普通文件仍走 `FilePreview`。
- 右侧栏展开、收起、全屏、标签页切换不受影响。
- 无黑屏、无 `deps/undefined`、无 wasm 报错。

### 13.3 构建验证

至少执行：

```bash
npm run typecheck
npm run lint
npm test
npm run build:unpack
```

并重点检查 renderer bundle 是否成功拆分出 docx-editor chunk。

## 14. 风险与应对

| 风险 | 应对 |
| --- | --- |
| `.doc` 依赖 LibreOffice | MVP 只支持 LibreOffice；无环境时给出明确提示，不伪造支持 |
| docx-editor Vue 包未正式发布 | 用 React bridge 封装，未来替换 `WordEditor.vue` 内部实现即可 |
| 中文排版/字体 | `@docx-editor.dev/fonts` 只覆盖默认拉丁字体；后续需要注册系统 CJK 字体并做分页对齐 |
| 首屏包体变大 | 使用 `defineAsyncComponent` 动态导入，编辑器不在登录页加载 |
| 两次 `ready` 事件 | 已知行为，接受；或改为先加载字体再首次渲染 |
| `onChange` 不是 docx 字节 | 保存时必须调用 `editorRef.save()` |
| 文档许可 | 基础编辑为 Apache-2.0；跟踪修改、批注、文档自动化等 Pro 能力需商业授权确认 |
| 全局样式变更 | 必须回归登录、首页、聊天布局，避免破坏现有 UI |

## 15. 需要新增/修改的文件汇总

新增：

- `src/renderer/src/components/WordEditor.vue`
- `src/main/workspace/WordConversionService.ts`

修改：

- `src/main/workspace/WorkspaceService.ts`
- `src/main/ipc/workspace-handlers.ts`
- `src/preload/index.ts`
- `src/preload/index.d.ts`
- `src/renderer/src/store/workspace.ts`
- `src/renderer/src/components/ChatSidePanel.vue`
- `src/renderer/src/main.ts`
- `src/renderer/index.html`
- `electron.vite.config.ts`
- `src/renderer/src/assets/main.css`

`FilePreview.vue` 不再负责 doc/docx，回归纯粹的文本/Markdown 预览。
