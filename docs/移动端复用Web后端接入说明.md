# 移动端接入说明（复用 Web 后端）

> 版本：v1.0　日期：2026-09-22
> 适用范围：HarmonyOS 移动端（`mobile/`），复用 Web 版后端（`web/backend`，ke-hermes）
> 关联契约：`packages/expert-contract/contract.json`、`docs/文档写作专家多端业务梳理与改造方案.md`

---

## 0. 定位与结论

移动端是**纯客户端**：智能体执行、沙箱、产物物化、提示词渲染全部在服务端完成，移动端复用**同一套 HTTP / SSE API**。

因此移动端**不需要**实现桌面版那套"本地执行适配层"（WorkspacePort / DeliverablePort），只需实现"取件与展示"：登录 → 对话（SSE）→ 产物列表 → 预览 / 下载 / 打包。

服务端已完成的配套改造：

| 能力 | 服务端现状 |
| --- | --- |
| 平台参数 | `POST /api/chat/stream` 接受 `platform`（`desktop` / `web` / `mobile`；缺省与非法值回退 `web`），并通过 `selection` 事件回显 |
| 移动端运行环境说明 | `agent/experts/platforms.py` 已提供 `mobile` 口径（沙箱在服务端 + 交付物通过产物接口取件，不引用本地路径） |
| 交付目录 | 每轮 `/artifacts/<thread_id>/turn-<n>/`：文章 `<标题>.md` + 同名目录配图 `figure-N.png` |
| 产物接口 | 列表 / 预览 / 下载 / 打包（本轮、整会话）均已提供，含轮次字段 `turn` |
| 提示词 | 平台化渲染（`{{platform_notes}}` 等），无需为移动端维护第二份专家提示词 |

---

## 1. 平台参数（必传）

```jsonc
POST /api/chat/stream
{
  "thread_id": "…",              // 新会话可不传
  "message": "帮我写一篇关于…",
  "expert_id": "…",              // 选择「文档写作专家」时
  "expert_name": "文档写作专家",
  "platform": "mobile",          // 移动端必须显式传 mobile
  "model_id": "…", "provider_id": "…",   // 可选：会话级模型
  "skill_ids": [], "kb_ids": [],          // 可选
  "allow_network": true, "allow_shell": true, "web_search": false
}
```

- 不传 `platform` 时服务端按 `web` 渲染运行环境说明（功能可用，但提示词口径是浏览器）；
- 服务端在 `selection` 事件中回显 `platform`、`expert_name`、`delivery_dir` 等，便于客户端核对。

---

## 2. 认证

- 登录 / 刷新令牌复用现有接口（`/api/auth/*`），随后所有请求带 `Authorization: Bearer <access_token>`。

---

## 3. 对话（SSE 事件表）

`POST /api/chat/stream` → `text/event-stream`，每条消息形如 `data: {"event": "...", "data": {...}}\n\n`。

| event | data 关键字段 | 客户端用法 |
| --- | --- | --- |
| `selection` | `mode`、`platform`、`expert_name`、`delivery_dir`、`workspace_id` | 顶部回显"本轮专家/工作区/交付目录" |
| `agent_start` / `agent_end` | `agent_name`、`agent_type`（`main`/`sub`）、`call_id`、`status` | 展示主/子智能体运行状态（可选） |
| `token` | `agent_name`、`content` | 正文流式追加 |
| `reasoning` | `agent_name`、`content` | 思考过程（默认折叠） |
| `tool_start` / `tool_output` / `tool_end` | `tool_name`、`call_id`、`input`、`output` | 工具调用卡片（`tool_end.output` 可折叠展示） |
| `artifact` | `path`、`name`、`mime_type`、`size`、`artifact_id`、`status`、`turn` | **新增交付物**：按 `turn` 分组挂到当前回复 |
| `artifact_updated` | 同上 | 流结束补全大小 / 状态，刷新卡片 |
| `done` | `thread_id`、`duration_ms` | 结束本轮，收起 loading |
| `error` | `message` | 展示服务端错误文案 |

要点：`artifact.path` 是**虚拟路径**（如 `/artifacts/<thread>/turn-1/文章标题.md`），后续预览 / 下载 / 打包都直接用它。

---

## 4. 产物接口（预览 / 下载 / 打包）

| 用途 | 请求 | 说明 |
| --- | --- | --- |
| 产物列表 | `GET /api/chat/artifacts/{thread_id}` | 返回含 `turn` 的产物数组，用于历史回显 |
| 预览（内联） | `GET /api/chat/artifacts/{thread_id}/download?path=<虚拟路径>&disposition=inline` | 文本 / 图片 / PDF 直接展示 |
| 下载 | 同上，`disposition=attachment` | 支持 `Range`（大文件可续传） |
| 打包本轮 | `GET /api/chat/artifacts/{thread_id}/bundle.zip?scope=turn&turn=turn-<n>` | 文章 + 同名图片目录，保留结构 |
| 打包整会话 | `GET /api/chat/artifacts/{thread_id}/bundle.zip?scope=thread` | 含全部轮次子目录 |

状态码约定：

- `404`：产物不属于该会话 / 会话无该路径 / 打包目录为空；
- `410`：持久副本与沙箱均不可用（`status=expired`），客户端应提示"文件已过期，无法恢复"而非重试。

---

## 5. 配图显示规则（必须与 Web 端一致）

文章内配图使用相对路径引用：`![](文章标题/figure-1.png)`。移动端渲染 Markdown 前需：

1. 以文章虚拟路径为基准解析相对路径 → `/artifacts/<thread_id>/turn-<n>/文章标题/figure-1.png`；
2. 命中该会话产物清单时，用 `disposition=inline` 拉取图片字节（建议本地缓存，键=虚拟路径）；
3. 未命中或拉取失败时保留占位，不要整篇渲染失败。

参考实现（可直接移植为 ArkTS/Kotlin 工具函数）：

- 相对路径 → 产物地址：`web/frontend/src/utils/markdownArtifacts.ts`
- 产物按轮分组与挂载：`web/frontend/src/utils/artifactGroups.ts`（轮次与助手回复一一对应时精确挂载，数量不匹配时挂到最后一条）

---

## 6. 交付物契约

- 交付目录：`/artifacts/<thread_id>/turn-<n>/`；
- 文章：`<文章标题>.md`（同名自动追加 `-1`、`-2`）；
- 配图：与文章同名的目录下 `figure-1.png`、`figure-2.png`……；
- 契约基准文件：`packages/expert-contract/contract.json`（平台、能力、提示词变量、素材工具名、交付结构）；
- 能力（`image.generate` / `document.assemble` / `web.search` / `video.generate`）在服务端执行，移动端无需实现对应工具，只需按契约取件。

---

## 7. 移动端待办清单

- [ ] 登录 / 刷新令牌（Bearer）
- [ ] 对话页：SSE 消费（含 `selection` / `artifact` / `artifact_updated` / `done` / `error`），请求带 `platform=mobile`
- [ ] 专家选择：`expert_id` + `expert_name`（专家列表可复用 `/api/experts`）
- [ ] 产物列表按 `turn` 分组展示，消息内显示"第 N 轮交付物"
- [ ] 文章预览：Markdown 渲染 + 相对配图解析 + inline 拉图 + 缓存
- [ ] 下载：单文件（attachment）与打包（bundle.zip：本轮 / 整会话）
- [ ] 历史会话加载：按轮把产物挂到对应助手回复
- [ ] 过期产物（410）友好提示

---

## 8. 服务端就绪情况

| 项 | 状态 |
| --- | --- |
| 平台参数贯通（`ChatRequest.platform` → `Context.platform` → 提示词/中间件） | ✅ |
| 移动端运行环境说明 | ✅ |
| 交付目录 + 产物登记（含 `turn`） | ✅ |
| 预览 / 下载 / 打包接口 | ✅ |
| 相对配图解析契约（前端参考实现） | ✅ |
| 移动端工程内实现（登录态、SSE、渲染、下载） | ⏳ 待 `mobile/` 中落地 |
---

## 9. ArkTS 工具（已提供，可直接复用）

移动端工程内已落地与 Web 前端**同规则**的纯函数工具（ArkTS，无框架依赖）：

| 文件 | 内容 |
| --- | --- |
| `mobile/entry/src/main/ets/common/utils/MarkdownArtifacts.ets` | `normalizeImagePath` / `resolveImagePath` / `resolveImageSrc` / `extractImageSources` / `buildImageSrcMap`；`buildArtifactDownloadUrl`（预览 / 下载接口）、`buildBundleUrl`（本轮 / 整会话打包） |
| `mobile/entry/src/main/ets/common/utils/ArtifactGroups.ets` | `groupArtifactsByTurn`、`turnLabel`、`attachArtifactsToMessages`（按轮挂到助手消息） |
| `mobile/entry/src/main/ets/common/types/Models.ets` | 新增 `ChatArtifact`（与后端产物结构一致，含 `turn`）与 `ChatArtifactList` |

Hypium 单测已注册到 `mobile/entry/src/test/List.test.ets`：

- `MarkdownArtifacts.test.ets`：9 例（路径归一化 / 相对与绝对解析 / 越界与协议拒绝 / 产物地址拼接 / 打包地址 / 命中与未命中 / 图片提取 / src 映射）
- `ArtifactGroups.test.ets`：5 例（按轮分组、精确挂载、退化到末尾、空输入、轮次文案）

### 使用要点

1. `resolveImageSrc` 返回的是**需鉴权的接口地址**，不要直接交给 `Image()` 组件；请用 `HttpClient` 带 token 拉取字节后渲染（建议按虚拟路径缓存，并在 `artifact_updated` 时失效重取）。
2. `MarkdownImageContext.apiBaseUrl` 传 `Constants.BASE_URL + '/api'`；缺省回退 `/api`。
3. `attachArtifactsToMessages` 采用**就地修改**（ArkTS 不支持对象展开），调用后请显式触发 UI 刷新。
4. 工具函数只做"解析与拼接"，不发起网络请求，便于单测与复用。

### 一致性保障

移植用"把 `.ets` 逐字节复制为 `.ts`（仅改写一处 import 路径）+ 与 Web 实现逐用例对拍"的方式验证：8 组用例覆盖路径归一化、相对路径解析、命中 / 未命中、协议地址、图片提取、产物地址拼接、按轮分组、消息挂载，全部与 Web 实现一致。为统一规则，Web 端也同步支持了显式 `apiBaseUrl`（此前写死环境变量基址），并补了对应用例。
---

## 10. 对话链路接入现状（已落地）

| 层 | 文件 | 说明 |
| --- | --- | --- |
| 契约 | `services/contracts/ChatService.ets` | `ChatSendRequest`（含 **platform=mobile**）/ `ChatSendReply` / `ChatStreamHandlers`（token、artifact、artifact_updated、error）/ `listArtifacts` |
| Real | `services/real/RealChatService.ets` | `POST /api/chat`（非流式兜底）、`POST /api/chat/stream`（SSE：`dataReceive` 累积分片 → `parseSseChunk` → 事件分发）、`GET /api/chat/artifacts/{threadId}` |
| Mock | `services/mock/MockChatService.ets` | 设计稿示例改为 Markdown 形态，满足新契约（Mock 下产物为空） |
| 解析 | `common/utils/MarkdownBlocks.ets` | Markdown → 内容块（标题/列表/表格/图片/段落，图片已解析为产物接口地址） |
| 解析 | `common/utils/SseParser.ets` | SSE 分片解析（跨分片、CRLF、默认事件名） |
| 取件 | `common/utils/ArtifactAssets.ets` | 带 token 拉字节、解码 `PixelMap`、下载到应用沙箱 `filesDir/artifacts/` |
| 状态 | `store/ChatStore.ets` | 流式 token 累积 → `markdownToBlocks`；artifact 事件登记并挂到当前回复；`loadThread` 按轮挂载；`artifactUrlFor` / `bundleUrlFor` |
| UI | `components/ArtifactImage.ets`、`components/ArtifactList.ets`、`components/MarkdownBlock.ets`、`pages/ChatPage.ets` | 配图渲染、交付物清单（轮次标题 + 下载 + 打包）、下载落沙箱并提示路径 |

要点：SSE 与产物接口**必须带 Authorization**，因此配图先拉字节再渲染（`ArtifactImage`）；移动端没有浏览器式"另存为"，统一下载到应用沙箱再由上层决定分享/打开。