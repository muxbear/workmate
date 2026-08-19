# 桌面版与 Web 版技能数据对接方案

## 一、背景与目标

桌面版登录首页后，左侧“智能体 → 技能”二级菜单页面目前使用本地静态数据，未与 Web 版打通。目标是让桌面版“技能”页面直接展示 Web 版“智能体 → 技能”页面中配置的技能数据，并通过统一的 OAuth2 授权完成安全同步。

具体需求：

1. 桌面版“技能”页面初始无技能时，展示提示“请先从服务器同步技能”。
2. 用户点击该提示后，跳转到 Web 版 OAuth2 浏览器授权页面完成授权并获取 token。
3. 桌面版使用 token 调用 Web 后端技能接口，获取技能并在桌面版“技能”页面展示。

Web 后端 OAuth2 授权服务不属于桌面端专用能力，后续移动端、第三方应用也会接入。OAuth2 服务的详细设计见：

- [Ke-Hermes-OAuth2授权方案](../../web/backend/docs/Ke-Hermes-OAuth2授权方案.md)

本文档只描述桌面端如何基于该通用 OAuth2 服务完成技能数据同步。

## 二、现状与关键结论

### 2.1 桌面端现状

桌面端技能页已独立为：

- `desktop/src/renderer/src/views/SkillPage.vue`
- `desktop/src/renderer/src/views/Home.vue` 在 `activeNav === '技能'` 时渲染 `SkillPage`
- 技能页当前直接导入 `desktop/src/renderer/src/store/catalog.ts` 中的静态 `skillItems`
- 当前 `SkillPage.vue` 只有搜索、静态技能卡片和“安装”toast，没有“无技能空状态”，也没有服务器同步入口

桌面端已有以下可复用能力：

- Electron 主进程负责权威逻辑
- `preload` 通过 `contextBridge` 暴露类型化 `window.api`
- `secure-storage.ts` 使用 `safeStorage` 加密保存密钥
- `desktop/src/main/browser/WorkspacePreviewServer.ts` 已有“仅监听 127.0.0.1 随机端口”的本地 HTTP 服务器实现模式

### 2.2 Web 端现状

Web 后端已有技能接口：

- `GET /api/skill/list`
- `GET /api/skill/search`
- `POST /api/skill`
- `PATCH /api/skill/{skill_id}/toggle`

技能接口通过 `Authorization: Bearer <token>` 保护，依赖：

- `web/backend/src/api/deps.py`
- `web/backend/src/api/skill/skill_api.py`

Web 版现有 `/api/oauth` 是第三方账号登录，不适合直接作为统一 OAuth2 授权服务。桌面端依赖的通用 OAuth2 服务按 [Ke-Hermes-OAuth2授权方案](../../web/backend/docs/Ke-Hermes-OAuth2授权方案.md) 实施。

## 三、总体方案

### 3.1 核心流程

1. 用户进入桌面端“智能体 → 技能”页面。
2. 页面查询技能同步状态。
3. 若尚未授权，页面展示空状态和可点击提示：“请先从服务器同步技能”。
4. 用户点击后，桌面端主进程：
   - 生成 PKCE `code_verifier` 和 `code_challenge`。
   - 启动仅监听 `127.0.0.1` 随机端口的本地回调服务器。
   - 调用 Web 后端通用 OAuth2 接口创建授权请求。
   - 通过系统浏览器打开 Web 前端通用授权页。
5. 用户在 Web 授权页登录并点击“授权”。
6. Web 后端校验后，将浏览器重定向到桌面端本地回调地址，并携带一次性 `code`。
7. 桌面端主进程捕获 `code`，调用 Web 后端 token 接口换取 `accessToken` 和 `refreshToken`。
8. 桌面端主进程安全保存 token，随后调用 `GET /api/skill/list` 拉取技能。
9. 桌面端渲染层展示服务器技能数据。

### 3.2 流程示意

```text
桌面端渲染层
   │
   ├─ getSkillSyncStatus()
   ├─ authorize()
   ├─ sync()
   ▼
桌面端主进程 SkillSyncService
   │
   ├─ 生成 PKCE + 启动 loopback 回调服务器
   ├─ POST /api/oauth2/authorization-url
   ├─ 打开系统浏览器
   ├─ 捕获回调 code
   ├─ POST /api/oauth2/token
   ├─ 安全存储 token
   ├─ GET /api/skill/list
   ▼
Web 后端
```

## 四、桌面端依赖的 Web 端能力

### 4.1 Web 后端 OAuth2 服务

桌面端使用以下通用 OAuth2 接口：

| 接口 | 桌面端用途 |
| --- | --- |
| `POST /api/oauth2/authorization-url` | 创建授权请求，获取浏览器授权页 URL |
| `POST /api/oauth2/token` | 使用授权码和 PKCE 换取 token |
| `POST /api/auth/refresh` | 当前阶段用于刷新 access token |

客户端注册信息：

```json
{
  "client_id": "ke-work-desktop",
  "client_name": "KE-WORK 桌面版",
  "client_type": "public",
  "redirect_uris": [
    "http://127.0.0.1:{port}/callback",
    "http://localhost:{port}/callback"
  ],
  "allowed_scopes": ["skill:read"],
  "grant_types": ["authorization_code"],
  "enabled": true
}
```

详细接口、安全策略和数据模型见：

- [Ke-Hermes-OAuth2授权方案](../../web/backend/docs/Ke-Hermes-OAuth2授权方案.md)

### 4.2 Web 前端通用授权页

Web 前端提供通用授权页：

```text
/oauth2/authorize
```

桌面端不需要单独开发 Web 端授权页，只需打开 Web 后端返回的 `authorizeUrl`。

### 4.3 Web 后端技能接口

桌面端使用：

```text
GET /api/skill/list?page=1&page_size=100
```

请求头：

```text
Authorization: Bearer <accessToken>
```

## 五、桌面端改动方案

### 5.1 新增主进程技能同步服务

建议新增：

```text
desktop/src/main/skills/
├── SkillSyncService.ts
├── DesktopOAuthCallbackServer.ts
└── types.ts
```

`SkillSyncService` 负责：

- 管理 Web 后端基础地址。
- 管理 PKCE 生成。
- 管理 loopback 回调服务器。
- 调用通用 OAuth2 接口。
- 保存 token。
- 调用技能接口。
- 刷新 token。
- 缓存同步结果。

### 5.2 本地回调服务器

参考现有 `WorkspacePreviewServer.ts` 的实现模式：

- 监听 `127.0.0.1`。
- 随机端口。
- 只处理 `/callback`。
- 校验 `state`。
- 捕获 `code` 或 `error`。
- 返回简单 HTML 页面提示用户授权成功或失败。
- 回调完成后关闭服务器。

### 5.3 Token 安全存储

不把 Web 端 token 暴露给渲染层。

建议使用现有 `secure-storage.ts`，将 Web token 存到 `secrets.bin`，key 可设计为：

```text
skill-sync:{localUserId}:tokens
```

保存内容：

```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "expiresAt": 1234567890,
  "webUserId": "...",
  "webNickname": "..."
}
```

如果 `accessToken` 过期，主进程调用：

```text
POST /api/auth/refresh
```

进行刷新。

### 5.4 新增 IPC 接口

在 `desktop/src/preload/index.ts` 的 `api` 对象中新增 `skillSync` 命名空间：

```ts
skillSync: {
  getStatus(): Promise<IpcResult<SkillSyncStatus>>
  authorize(): Promise<IpcResult<{ webUser: WebUser | null }>>
  sync(): Promise<IpcResult<{ skills: DesktopSkill[]; syncedAt: number }>>
  getCachedSkills(): Promise<IpcResult<DesktopSkill[]>>
  disconnect(): Promise<IpcResult<null>>
}
```

对应 IPC 通道：

```text
skill-sync:status
skill-sync:authorize
skill-sync:sync
skill-sync:cached
skill-sync:disconnect
```

同时在 `desktop/src/preload/index.d.ts` 中新增 `SkillSyncAPI` 接口，并让 `KeWorkWindowApi` 继承该接口。

### 5.5 新增渲染层技能同步 Store

建议新增：

```text
desktop/src/renderer/src/store/skillSync.ts
```

状态：

```ts
{
  status: 'unknown' | 'unauthorized' | 'authorized' | 'syncing'
  skills: DesktopSkill[]
  lastSyncedAt: number | null
  error: string | null
}
```

动作：

```ts
loadStatus()
authorize()
sync()
loadCachedSkills()
disconnect()
```

### 5.6 改造 catalog 中的静态技能数据

当前 `catalog.ts` 中：

- `SkillItem` 字段为 `id: number`、`name`、`desc`、`color`、`count`
- `skillItems` 是模块级导出的静态 `SkillItem[]`
- `SkillPage.vue` 直接通过 `import { skillItems } from '@store/catalog'` 读取
- `selectedSkillIds` 当前为 `number[]`
- `toggleSkill(id: number)` 当前按 number 处理
- 已存在的 `clearSkills()` 只清空“已选技能 id”，不是清空服务器技能数据

建议改为：

- `skillItems` 成为响应式数据，例如 `ref<SkillItem[]>([])`，默认空数组
- 新增 `setSkills(skills: SkillItem[])`，用于同步后替换服务器技能列表
- 新增 `clearSkillItems()`，用于退出登录或断开连接时清空服务器技能数据
- 保留现有 `clearSkills()`，继续只清空已选技能 id
- `selectedSkillIds` 从 `number[]` 改为 `string[]`，与 Web 端技能 `id: string` 对齐
- `toggleSkill(id: string)` 同步修改

这会影响：

- `desktop/src/renderer/src/views/SkillPage.vue`
- `desktop/src/renderer/src/components/PlusMenu.vue`
- `desktop/src/renderer/src/views/NewTaskPage.vue`

需要一并把技能 ID 相关逻辑从 number 改为 string。

### 5.7 技能页 UI 状态

在 `SkillPage.vue` 中增加：

当前 `SkillPage.vue` 直接渲染静态 `skillItems`，并已有搜索框和“安装”toast；改造时在此基础上补齐以下状态：

- 未授权空状态：

```text
请先从服务器同步技能
```

点击后触发：

```ts
await skillSyncStore.authorize()
await skillSyncStore.sync()
```

- 已授权但正在同步：loading。
- 同步成功：技能卡片列表。
- 同步失败：错误提示 + 重试按钮。
- 已授权、有缓存：显示上次同步数据，并保留“重新同步”入口。

### 5.8 数据映射

当前 `catalog.ts` 中的 `SkillItem`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `number` | 当前静态技能 ID |
| `name` | `string` | 技能名 |
| `desc` | `string` | 描述 |
| `color` | `string` | 卡片图标渐变色 |
| `count` | `string` | 当前静态使用量文案 |

Web 端 `SkillInfo` 映射到桌面端新 `DesktopSkill`：

| Web 字段 | 桌面字段 | 说明 |
| --- | --- | --- |
| `id` | `id` | 字符串 |
| `name` | `name` | 技能名 |
| `description` | `desc` | 描述 |
| `category` / `icon` | `color` | 按分类映射颜色 |
| `enabled` | 可增加状态字段 | 控制展示或禁用样式 |
| `is_builtin` | 可增加标签 | 内置技能标记 |
| `source` | 可增加标签 | 来源 |

当前 `count` 是静态展示字段，Web 技能列表接口没有直接对应字段；改造后建议移除或由使用量/安装量另行补充。

建议桌面端类型：

```ts
export interface DesktopSkill {
  id: string
  name: string
  desc: string
  category: string
  icon: string
  color: string
  enabled: boolean
  isBuiltin: boolean
  source: string
}
```

## 六、配置与环境变量

桌面端需要知道 Web 后端地址和 Web 前端地址。建议在 `.env.sample` 增加：

```env
# Web 技能同步
WORKMATE_WEB_API_BASE_URL=http://127.0.0.1:8001
WORKMATE_WEB_FRONTEND_URL=http://localhost:5173
WORKMATE_OAUTH_CLIENT_ID=ke-work-desktop
```

主进程初始化 `SkillSyncService` 时读取这些配置。

Web 后端和 Web 前端配置按 [Ke-Hermes-OAuth2授权方案](../../web/backend/docs/Ke-Hermes-OAuth2授权方案.md) 执行。

## 七、实施阶段建议

### 阶段 1：Web 后端通用 OAuth2 服务

按 [Ke-Hermes-OAuth2授权方案](../../web/backend/docs/Ke-Hermes-OAuth2授权方案.md) 完成：

- `oauth2_clients` 表和桌面端客户端种子数据。
- Authorization Code + PKCE。
- token 交换接口。
- redirect_uri 安全校验。

### 阶段 2：Web 前端通用授权页

完成：

- `/oauth2/authorize` 路由。
- `OAuth2AuthorizeView.vue`。
- 登录重定向。
- 授权 / 取消流程。

### 阶段 3：桌面端主进程能力

完成：

- `SkillSyncService`。
- loopback 回调服务器。
- token 安全存储与刷新。
- 技能接口调用。
- 新增 IPC 通道和类型。

### 阶段 4：桌面端 UI 与数据打通

完成：

- 技能页空状态。
- 同步按钮。
- `skillSync` store。
- `catalog.skillItems` 动态化。
- 字符串 ID 改造。

### 阶段 5：联调与测试

完成：

- 桌面端、Web 前端、Web 后端三端联调。
- 授权成功 / 取消 / token 过期 / 网络错误。
- 桌面端 typecheck、lint、test。
- Web 后端 OAuth2 与技能接口测试。
- 手动回归验证。

## 八、边界情况

1. **用户取消授权**
   - 回调地址携带 `error=access_denied`。
   - 桌面端显示“已取消授权”，停留在未授权空状态。

2. **token 过期**
   - 主进程使用 refresh token 刷新。
   - 刷新失败时清除本地 Web token，回到未授权状态。

3. **重复点击同步**
   - 前端禁止重复提交。
   - 主进程对同步请求做去重或复用同一个 Promise。

4. **本地账号和 Web 账号关系**
   - 建议 Web token 按桌面端本地 `userId` 隔离存储。
   - 桌面端退出登录时清理对应技能同步状态。
   - 避免 A 用户同步到 B 用户的数据。

5. **技能 ID 变更**
   - 同步后重新建立技能列表。
   - 已选技能如果不在新列表中，自动清理选中状态。

## 九、推荐结论

建议按以下方向落地：

- Web 后端新增通用 OAuth2 授权服务，桌面端作为首个客户端接入。
- 桌面端主进程负责 OAuth 回调和 token 管理，渲染层不接触 token。
- 技能数据统一通过 `GET /api/skill/list` 拉取。
- 桌面端技能页从静态数据改为“授权 → 同步 → 展示”的动态数据流。

这套方案既满足当前桌面端技能同步需求，也为后续移动端和第三方应用接入统一 OAuth2 能力预留了扩展空间。
