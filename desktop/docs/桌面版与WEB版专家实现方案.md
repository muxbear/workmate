# 桌面版与 WEB 版专家实现方案

> 本文档基于 DeepAgents 官方文档（子智能体、动态子智能体、异步子智能体、解释器、配置 / Profiles）以及 WorkMate 现有代码结构，对"专家"功能在桌面版与 Web 版之间的数据存储、同步、分配与全生命周期管理进行完整规划。

---

## 一、整体架构与数据流

```
┌──────────────────────────────────────────────────────────────┐
│                      Web 版（数据权威源）                       │
│  ┌─────────────┐      ┌───────────────────────────────┐      │
│  │ ExpertView  │─────▶│  /api/experts（专家管理 CRUD）  │      │
│  │ 专家管理页面  │      └──────────┬────────────────────┘      │
│  └─────────────┘                 │                            │
│                                  ▼                            │
│  ┌────────────────────────────────────────────────────┐       │
│  │ DB：agents + expert_profiles（1:1）                 │       │
│  │     + agent_tools / agent_skills / agent_mcp_configs│       │
│  └───────────────────────┬────────────────────────────┘       │
│                          │                                    │
│                          ▼                                    │
│  ┌────────────────────────────────────────────────────┐       │
│  │ /api/expert-sync（桌面版 / 移动版同步，只读）          │       │
│  │   GET /list  GET /{id}  GET /featured              │       │
│  │   依赖 require_scope("expert:read")                  │       │
│  └────────────────────────────────────────────────────┘       │
└──────────────────────────┬───────────────────────────────────┘
                           │ OAuth2 Bearer Token（expert:read）
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                  桌面版（消费方 + 子智能体宿主）                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │
│  │ ExpertSync   │─▶│ Expert Store  │─▶│ ExpertPage   │        │
│  │ Service      │  │ (Pinia)       │  │ (展示/选择)   │        │
│  └──────────────┘  └──────┬───────┘  └──────────────┘        │
│                           │                                    │
│                    ┌──────▼───────┐                           │
│                    │ NewTaskPage  │                           │
│                    │ (输入框选专家) │                           │
│                    └──────┬───────┘                           │
│                           │ 用户提交问题                        │
│                    ┌──────▼───────┐                           │
│                    │ AgentManager │                           │
│                    │ .setSubagents│                           │
│                    │ →主智能体    │                           │
│                    └──────────────┘                           │
└──────────────────────────────────────────────────────────────┘
```

Web 版已落地：专家作为 `agents.type='sub'` 的记录，展示元数据单独存储在 `expert_profiles` 表；Web 管理页面走 `/api/experts`，桌面版 / 移动版同步走 `/api/expert-sync`。

专家数据流仍为四层：Web 数据库存储 → REST API → 桌面版同步服务 → Pinia Store → AgentManager 子智能体配置。

---
## 二、DeepAgents 文档要点

本方案严格遵循 DeepAgents 官方文档的以下概念：

### 2.1 子智能体（Subagents）

> 文档：https://docs.langchain.com/oss/python/deepagents/subagents

- 子智能体通过 `create_deep_agent()` 的 `subagents=[...]` 参数声明，每个子智能体是一个 dict，包含 `name`、`description`、`tools`、`prompt`、`model`、`skills` 等字段。
- 主智能体在规划阶段根据子智能体的 `description` 自动决定是否委派任务。子智能体作为独立的图节点运行，拥有自己的 LLM 调用上下文。
- 子智能体可以拥有独立的工具集和 skills 目录（`/skills/<agent_id>/`），与主智能体隔离。
- 桌面版 `deepagents` npm 包中对应 `SubAgent` 接口，通过 `createDeepAgent({ subagents })` 传入。

### 2.2 动态子智能体（Dynamic Subagents）

> 文档：https://docs.langchain.com/oss/python/deepagents/dynamic-subagents

- 动态子智能体在运行时由主智能体自行创建，而非在编译期静态声明。
- 通过 `dynamic_subagents=True`（或 `AgentBuilder` 链中设置）启用，主智能体获得 `create_subagent` 工具，可按需生成新的子智能体。
- 适用于任务不确定、专家角色可能临时扩展的场景。本方案中桌面版主智能体默认使用静态子智能体（从同步的专家列表构建），同时保留动态子智能体能力供运行时扩展。

### 2.3 异步子智能体（Async Subagents）

> 文档：https://docs.langchain.com/oss/python/deepagents/async-subagents

- 异步子智能体允许子任务在后台执行，主智能体不必等待其完成即可继续推进。
- 通过 `subagent_mode="async"` 配置，子智能体任务进入异步队列，完成后通过回调 / 事件流通知主智能体。
- 适用于耗时较长（如深度研究、大量文件处理）的专家任务，主智能体可并行处理多个子任务。
- 本方案在桌面版 AgentManager 中预留 `asyncSubagents` 选项，当专家任务涉及重计算时启用异步模式。

### 2.4 解释器（Interpreters）

> 文档：https://docs.langchain.com/oss/python/deepagents/interpreters

- 解释器是 DeepAgents 中负责将自然语言指令转换为可执行操作的核心机制。
- 子智能体可以配置自己的解释器，决定它如何理解输入指令、选择工具并生成输出。
- 专家子智能体将继承主智能体的解释器配置，同时可通过 `system_prompt` 注入领域特定的解释逻辑（如"法律专家优先调用合同审查工具"）。

### 2.5 配置 / Profiles

> 文档：https://docs.langchain.com/oss/python/deepagents/profiles

- Profiles 是 DeepAgents 的预设配置包，封装了模型、工具、系统提示词、子智能体等组合，可实现一键切换智能体行为模式。
- 每个 Profile 是一个 JSON/YAML 配置，包含 `name`、`model`、`tools`、`subagents`、`system_prompt` 等字段。
- 专家本质就是一组"角色 Profile"：名称、领域描述、系统提示词、推荐工具、推荐模型。Web 版通过 `expert_profiles` 表保存展示 Profile，通过 `agents` 及其关联表保存核心配置。
- 桌面版同步专家后，将同步到的 `ExpertSyncItem`（或详情 `ExpertInfo`）转换为 DeepAgents 的 `SubAgent` 配置传入 `AgentBuilder.setSubagents()`。

---

## 三、Web 后端：专家数据模型与 API（已实现）

### 3.1 存储模型

实际实现采用“1 个 Agent 记录 + 1 条 ExpertProfile 记录”，并未在 `agents` 表新增 `expert_profile` 列。

- `agents` 继续承载核心子智能体配置：`name`、`type`、`status`、`description`、`system_prompt`、`provider_id`、`model_id`、`parent_id`、`files` 等。
- 新增 `expert_profiles` 表，保存展示元数据：`title`、`category`、`tags`、`icon`、`color`、`initials`、`avatar_url`、`rating`、`usage_count`、`featured`、`scene`、`sort_order`、`is_published` 等。
- `expert_profiles.agent_id` 为主键 + 外键，指向 `agents.id`，`ondelete="CASCADE"`，与 Agent 为 1:1。
- 工具、技能、MCP 继续复用 `agent_tools`、`agent_skills`、`agent_mcp_configs` 关联表。
- 专家判定：`agents.type = 'sub'` 且存在对应 `expert_profiles` 记录。

模型文件：`web/backend/src/db/models/expert_profile.py`

### 3.2 Schema

文件：`web/backend/src/api/experts/schemas.py`

主要响应 / 请求模型：

- `ExpertInfo`：列表和详情共用的完整专家信息。
- `ExpertListResponse`：`items` + `total` + `page` + `page_size`。
- `ExpertCreateRequest`：创建时一次传入基础信息、展示信息、工具 / 技能 / MCP。
- `ExpertUpdateRequest`：更新名称、头衔、描述、系统提示词、模型。
- `ExpertProfileUpdateRequest`：部分更新展示元数据。
- `ExpertConfigUpdateRequest`：批量更新系统提示词、模型、工具、技能、MCP。
- `ExpertSyncItem` / `ExpertSyncListResponse`：桌面端 / 移动端同步用的精简结构。
- `FeaturedScene` / `FeaturedSceneResponse`：精选场景响应。

### 3.3 Web 管理 API

前缀：`/api/experts`，鉴权方式为 `Depends(get_current_user_id)`，给 Web 管理页面使用。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/experts` | 分页列表，支持 keyword、category、featured、status、sort |
| GET | `/api/experts/categories` | 分类及数量统计 |
| GET | `/api/experts/featured` | 精选场景 + 精选专家 |
| GET | `/api/experts/{expert_id}` | 专家详情 |
| POST | `/api/experts` | 创建专家 |
| PUT | `/api/experts/{expert_id}` | 更新基础信息 |
| PUT | `/api/experts/{expert_id}/profile` | 更新展示元数据 |
| PUT | `/api/experts/{expert_id}/config` | 批量更新配置 |
| DELETE | `/api/experts/{expert_id}` | 删除专家 |
| PATCH | `/api/experts/{expert_id}/status` | 切换启用 / 停用 |
| POST | `/api/experts/{expert_id}/clone` | 克隆专家 |

路由注册：`web/backend/src/api/experts/__init__.py`，并在 `web/backend/src/api/__init__.py` 中挂载。

### 3.4 同步 API

前缀：`/api/expert-sync`，鉴权方式为 `Depends(require_scope("expert:read"))`，供桌面版 / 移动版拉取。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/expert-sync/list` | 已发布且启用的专家精简列表 |
| GET | `/api/expert-sync/{expert_id}` | 单个专家完整详情 |
| GET | `/api/expert-sync/featured` | 精选场景 + 精选专家 |

> 注意：当前 `sync_api.py` 中 `/{expert_id}` 声明在 `/featured` 之前。FastAPI/Starlette 按声明顺序匹配路径，若直接请求 `/api/expert-sync/featured`，会被 `/{expert_id}` 捕获；如需使用精选同步接口，应将 `/featured` 路由声明移到 `/{expert_id}` 之前。

`sync_list` 只返回 `is_published=true` 且 `status='active'` 的专家，并按 `sort_order` 倒序。响应结构为 `{ items, total, synced_at }`，每个 item 是 `ExpertSyncItem`。

### 3.5 Service 设计

文件：`web/backend/src/api/experts/service.py`

- `ExpertAssembler`：工厂式组装 `Agent + ExpertProfile + tools + skills + mcp_configs`，保证列表 / 详情 / 同步数据一致。
- `SORT_STRATEGIES`：策略字典实现 rating / usage / recent / name 排序。
- `list_experts`：JOIN `agents` + `expert_profiles`，先筛选再排序，最后内存分页。
- `create_expert`：插入 `Agent`（type=sub，parent_id=主智能体，status=inactive）+ `ExpertProfile` + 关联表，并创建版本快照、失效图缓存。
- `update_expert` / `update_expert_profile` / `update_expert_config`：更新对应字段；配置类更新采用“先快照 → 全量替换关联 → 提交”的事务模式。
- `delete_expert`：删除 `ExpertProfile` 和 `Agent`，级联清理关联。
- `toggle_expert_status`：切换 `Agent.status`。
- `clone_expert`：复制 Agent + Profile + 工具 / 技能 / MCP 关联，新专家默认停用、非精选。
- `get_featured` / `list_categories`：供精选场景和分类筛选使用。

---

## 四、Web 前端：专家页面（已实现）

### 4.1 入口与路由

- 路由：`web/frontend/src/router/index.ts` 中 `/experts` → `ExpertView.vue`。
- 主页面组件：`web/frontend/src/views/ExpertView.vue`。
- 卡片组件：`web/frontend/src/components/expert/ExpertCard.vue`。
- 编辑抽屉：`web/frontend/src/components/expert/ExpertEditDialog.vue`。

### 4.2 页面功能

`ExpertView.vue` 已实现：

- 顶部标题 + 搜索框 + 刷新 + 新建专家。
- 错误提示条（可重试）。
- 精选场景区域，展示各场景及关联专家。
- 分类筛选 chips，排序按钮（评分 / 使用量 / 最新 / 名称）。
- 专家卡片网格，支持编辑、克隆、启用 / 停用、删除。
- 分页条。
- 新建 / 编辑统一使用右侧 `ExpertEditDialog`。

### 4.3 编辑抽屉

`ExpertEditDialog.vue` 使用 5 个 Tab：

1. 基本信息：名称、头衔、分类、标签、头像颜色、头像文字、描述、精选 / 精选场景、排序、发布状态。
2. 模型与提示词：提供商、模型、系统提示词。
3. 工具：内置工具和第三方工具多选。
4. 技能：技能标签多选。
5. MCP：MCP 工具 + command / args / transport / enabled 配置。

编辑时拆分三个请求：基础信息、展示元数据、配置；创建时通过 `POST /api/experts` 一次提交。

### 4.4 前端数据层

- API 封装：`web/frontend/src/services/expertApi.ts`，将后端 snake_case 转 camelCase，并封装 CRUD、分类、精选、同步相关请求。
- 类型定义：`web/frontend/src/types/expert.ts`。
- Store：`web/frontend/src/stores/expert.ts`，管理列表、分页、搜索、分类、排序、精选场景和 CRUD 动作。
- 当前 Store 仍保留 mock 数据和 `useMock` 分支；`useMock = false` 时走真实 API。后端接口已实现，后续可清理 mock 逻辑。

---
## 五、桌面版：专家同步服务（需求 1）

### 5.1 同步服务设计

桌面版专家同步完全复用 `SkillSyncService` 的 OAuth2 Authorization Code + PKCE 模式，新建 `ExpertSyncService`。

**新建文件：`desktop/src/main/experts/ExpertSyncService.ts`**

```typescript
import axios, { type AxiosInstance } from 'axios'
import type { DesktopExpert, ExpertSyncStatus, WebUser } from '../../preload/index.d'
import type { ISecureStorage } from '../security/secure-storage'
import { OAuth2ClientService } from '../oauth2/OAuth2ClientService'

interface WebApiEnvelope<T> {
  code: number
  data: T
  message: string
}

interface ExpertSyncItem {
  id: string
  name: string
  title: string
  desc: string
  category: string
  tags: string[]
  color: string
  initials: string
  icon: string
  avatar_url: string | null
  rating: number
  users: string
  system_prompt: string
  scene: string | null
  sort_order: number
}

interface ExpertSyncListData {
  items: ExpertSyncItem[]
  total: number
  synced_at: number
}

interface ExpertSyncServiceDeps {
  secureStorage: ISecureStorage
  openExternal: (url: string) => Promise<void>
  apiBaseUrl?: string
  clientId?: string
}

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8001'
const DEFAULT_CLIENT_ID = 'ke-work-desktop'
const TOKEN_KEY_PREFIX = 'expert-sync:'
const EXPERT_SCOPE = 'expert:read'

/** 将 Web 专家数据映射为桌面版展示模型 */
function mapExpert(item: ExpertSyncItem): DesktopExpert {
  return {
    id: item.id,
    name: item.name,
    title: item.title || item.desc,
    tags: item.tags,
    desc: item.desc,
    color: item.color || 'linear-gradient(135deg,#0891b2,#0e7490)',
    icon: item.icon || 'Zap',
    category: item.category,
    rating: item.rating,
    users: item.users,
    initials: item.name.charAt(0),
    systemPrompt: item.system_prompt,
    tools: [],
    providerId: null,
    modelId: null,
    promptTemplate: '',
    expertiseAreas: [],
    isExpert: true,
  }
}

/**
 * 专家同步服务：从 Web 版拉取专家数据
 *
 * 复用 SkillSyncService 的 OAuth2 授权流程（共享 token 或独立 token），
 * 通过 expert:read scope 调用 /api/expert-sync/list 拉取专家精简列表。
 */
export class ExpertSyncService {
  private readonly http: AxiosInstance
  private readonly apiBaseUrl: string
  private readonly clientId: string
  private readonly oauth2: OAuth2ClientService
  private cachedExperts: DesktopExpert[] = []
  private lastSyncedAt: number | null = null

  constructor(deps: ExpertSyncServiceDeps) {
    this.apiBaseUrl = (deps.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '')
    this.clientId = deps.clientId || DEFAULT_CLIENT_ID
    this.oauth2 = new OAuth2ClientService({
      secureStorage: deps.secureStorage,
      openExternal: deps.openExternal,
      apiBaseUrl: this.apiBaseUrl,
      clientId: this.clientId,
    })
    this.http = axios.create({ baseURL: this.apiBaseUrl, timeout: 15_000 })
  }

  getStatus(localUserId: string): ExpertSyncStatus {
    const status = this.oauth2.getStatus(this.tokenKey(localUserId))
    if (status.status !== 'authorized') {
      return { status: 'unauthorized', webUser: null }
    }
    return {
      status: 'authorized',
      webUser: {
        id: status.webUser?.id ?? '',
        nickname: status.webUser?.nickname ?? '',
        avatar: status.webUser?.avatar,
      },
    }
  }

  /** OAuth2 授权（浏览器打开 → 回调获取 token） */
  async authorize(localUserId: string): Promise<{ webUser: WebUser | null }> {
    const token = await this.oauth2.authorize(EXPERT_SCOPE)
    this.oauth2.saveToken(this.tokenKey(localUserId), token)
    return { webUser: token.webUser }
  }

  /** 拉取并同步专家数据 */
  async sync(localUserId: string): Promise<{ experts: DesktopExpert[]; syncedAt: number }> {
    const accessToken = await this.oauth2.ensureValidAccessToken(this.tokenKey(localUserId))
    const data = await this.request<ExpertSyncListData>('get', '/api/expert-sync/list', undefined, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    this.cachedExperts = data.items.map(mapExpert)
    this.lastSyncedAt = Date.now()
    return { experts: this.cachedExperts, syncedAt: this.lastSyncedAt }
  }

  getCachedExperts(): DesktopExpert[] {
    return this.cachedExperts
  }

  async disconnect(localUserId: string): Promise<void> {
    const token = this.oauth2.loadToken(this.tokenKey(localUserId))
    if (token) {
      await this.oauth2.revoke(token.refreshToken)
    }
    this.oauth2.deleteToken(this.tokenKey(localUserId))
    this.cachedExperts = []
    this.lastSyncedAt = null
  }

  private tokenKey(localUserId: string): string {
    return `${TOKEN_KEY_PREFIX}${localUserId}:tokens`
  }

  private async request<T>(
    method: 'get' | 'post',
    path: string,
    body?: unknown,
    config?: Record<string, unknown>,
  ): Promise<T> {
    try {
      const response =
        method === 'post'
          ? await this.http.post<WebApiEnvelope<T>>(path, body, config)
          : await this.http.get<WebApiEnvelope<T>>(path, config)
      const envelope = response.data
      if (envelope.code !== 0) {
        throw new Error(envelope.message || 'Web 服务返回错误')
      }
      return envelope.data
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || error.message || '网络请求失败'
        throw new Error(message)
      }
      throw error
    }
  }
}
```

> 关键设计：`ExpertSyncService` 与 `SkillSyncService` 结构对称，但使用独立的 token key 前缀（`expert-sync:` vs `skill-sync:`），避免 token 冲突。二者共享同一个 `OAuth2ClientService`（同一个 `client_id`），只是授权时请求的 scope 不同。

### 5.2 IPC 处理器注册

**新建文件：`desktop/src/main/ipc/expert-sync-handlers.ts`**

```typescript
import type { IpcMain } from 'electron'
import type { SessionService } from '../services/SessionService'
import type { ExpertSyncService } from '../experts/ExpertSyncService'

interface ExpertSyncHandlerDeps {
  expertSyncService: ExpertSyncService
  session: SessionService
}

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data }
}

function fail(error: string): { success: false; error: string } {
  return { success: false, error }
}

/** 注册专家同步 IPC 通道 */
export function registerExpertSyncHandlers(ipc: IpcMain, deps: ExpertSyncHandlerDeps): void {
  const { expertSyncService, session } = deps

  ipc.handle('expert-sync:status', async () => {
    try {
      const userId = session.requireUserId()
      return ok(expertSyncService.getStatus(userId))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('expert-sync:authorize', async () => {
    try {
      const userId = session.requireUserId()
      return ok(await expertSyncService.authorize(userId))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('expert-sync:sync', async () => {
    try {
      const userId = session.requireUserId()
      return ok(await expertSyncService.sync(userId))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('expert-sync:cached', async () => {
    try {
      session.requireUserId()
      return ok(expertSyncService.getCachedExperts())
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('expert-sync:disconnect', async () => {
    try {
      const userId = session.requireUserId()
      await expertSyncService.disconnect(userId)
      return ok(null)
    } catch (err) {
      return fail((err as Error).message)
    }
  })
}
```

### 5.3 主进程初始化

**文件：`desktop/src/main/index.ts`**

在现有 `SkillSyncService` 初始化位置旁，新增 `ExpertSyncService` 初始化：

```typescript
import { ExpertSyncService } from './experts/ExpertSyncService'
import { registerExpertSyncHandlers } from './ipc/expert-sync-handlers'

// 在 app.whenReady() 中
const expertSyncService = new ExpertSyncService({
  secureStorage,
  openExternal: shell.openExternal,
})
registerExpertSyncHandlers(ipcMain, { expertSyncService, session })
```

### 5.4 Preload 类型声明

**文件：`desktop/src/preload/index.d.ts`**

```typescript
export interface DesktopExpert {
  id: string
  name: string
  title: string
  tags: string[]
  desc: string
  color: string
  icon: string
  category: string
  rating: number
  users: string
  initials: string
  // 子智能体配置字段
  systemPrompt: string
  tools: string[]
  providerId: string | null
  modelId: string | null
  promptTemplate: string
  expertiseAreas: string[]
  isExpert: boolean
}

export interface ExpertSyncStatus {
  status: 'authorized' | 'unauthorized'
  webUser: { id: string; nickname: string; avatar?: string } | null
}

// 在 api 命名空间中新增
export interface ExpertApi {
  status(): Promise<ApiResponse<ExpertSyncStatus>>
  authorize(): Promise<ApiResponse<{ webUser: WebUser | null }>>
  sync(): Promise<ApiResponse<{ experts: DesktopExpert[]; syncedAt: number }>>
  cached(): Promise<ApiResponse<DesktopExpert[]>>
  disconnect(): Promise<ApiResponse<null>>
}
```

**文件：`desktop/src/preload/index.ts`**

```typescript
expert: {
  status: () => ipcRenderer.invoke('expert-sync:status'),
  authorize: () => ipcRenderer.invoke('expert-sync:authorize'),
  sync: () => ipcRenderer.invoke('expert-sync:sync'),
  cached: () => ipcRenderer.invoke('expert-sync:cached'),
  disconnect: () => ipcRenderer.invoke('expert-sync:disconnect'),
},
```

---

## 六、桌面版：专家 Store 与 UI（需求 1）

### 6.1 Expert Store

将现有 `catalog.ts` 中的静态 `experts` 数组替换为从同步服务获取的动态数据。

**文件：`desktop/src/renderer/src/store/catalog.ts`**

```typescript
// 删除静态 experts 数组，改为 ref
export const experts = ref<Expert[]>([])

// Expert 接口扩展（与 DesktopExpert 对齐）
export interface Expert {
  id: string  // 从 number 改为 string（Web UUID）
  name: string
  title: string
  tags: string[]
  desc: string
  color: string
  initials: string
  category: string
  rating: number
  users: string
  // 子智能体配置字段
  systemPrompt: string
  tools: string[]
  providerId: string | null
  modelId: string | null
  promptTemplate: string
  expertiseAreas: string[]
  isExpert: boolean
}

// 在 useCatalogStore 中新增
function setExperts(items: Expert[]): void {
  experts.value = items
}

function clearExpertItems(): void {
  experts.value = []
}

// selectedExpertId 类型从 number 改为 string | null
const selectedExpertId = ref<string | null>(loadPersisted().selectedExpertId)
```

### 6.2 ExpertPage.vue 改造

**文件：`desktop/src/renderer/src/views/ExpertPage.vue`**

核心改动：

1. 页面挂载时调用 `window.api.expert.sync()`（或先取 `cached()` 再异步刷新）拉取专家数据
2. "同步专家"按钮触发 `window.api.expert.sync()`
3. 未授权时显示"连接 Web 版"引导

```vue
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { experts, useCatalogStore } from '@store/catalog'

const catalog = useCatalogStore()
const expertFilter = ref('全部')
const sort = ref<'综合' | '最新'>('综合')
const search = ref('')
const syncStatus = ref<'idle' | 'syncing' | 'unauthorized'>('idle')

const filteredExperts = computed(() =>
  experts.value.filter(
    (e) =>
      (expertFilter.value === '全部' || e.category === expertFilter.value) &&
      (e.name.includes(search.value) ||
        e.title.includes(search.value) ||
        e.tags.some((t) => t.includes(search.value)))
  )
)

onMounted(async () => {
  await loadExperts()
})

async function loadExperts() {
  syncStatus.value = 'idle'
  const cachedRes = await window.api.expert.cached()
  if (cachedRes.success && cachedRes.data.length > 0) {
    catalog.setExperts(cachedRes.data)
  }
  // 异步刷新
  const statusRes = await window.api.expert.status()
  if (statusRes.success && statusRes.data.status === 'authorized') {
    syncStatus.value = 'syncing'
    const syncRes = await window.api.expert.sync()
    if (syncRes.success) {
      catalog.setExperts(syncRes.data.experts)
    }
    syncStatus.value = 'idle'
  } else {
    syncStatus.value = 'unauthorized'
  }
}

async function handleSync() {
  const statusRes = await window.api.expert.status()
  if (statusRes.success && statusRes.data.status !== 'authorized') {
    await window.api.expert.authorize()
  }
  syncStatus.value = 'syncing'
  const res = await window.api.expert.sync()
  if (res.success) {
    catalog.setExperts(res.data.experts)
  }
  syncStatus.value = 'idle'
}

const summonExpert = (id: string): void => {
  catalog.setExpert(id)
  emit('summon')
}
</script>
```

### 6.3 专家数据本地缓存（可选）

同步后的专家数据可写入桌面版 SQLite（`desktop/src/main/database/`），实现离线可用：

```sql
CREATE TABLE IF NOT EXISTS cached_experts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT,
  category TEXT,
  description TEXT,
  system_prompt TEXT,
  tools TEXT,        -- JSON array
  expert_profile TEXT, -- JSON
  synced_at INTEGER NOT NULL
);
```

`ExpertSyncService.sync()` 成功后写入 `cached_experts` 表，`getCachedExperts()` 优先读本地缓存。

---

## 七、桌面版：专家 → 子智能体配置（需求 2 & 4）

### 7.1 需求回顾

需求 2：在"新建任务"消息输入框可以添加专家，提交问题后由主智能体将问题拆分成任务，对适合的任务分配给选中专家处理。

需求 4：桌面版选中专家后如何配置给主智能体。

### 7.2 专家选择 → 输入框（NewTaskPage.vue）

现有 `NewTaskPage.vue` 已实现专家选择逻辑：

- `catalog.setExpert(id)` 将选中的专家写入 store
- `syncExpertPromptToDom()` 将专家提示词插入到 contenteditable 输入框开头
- `buildExpertPrompt()` 生成提示词模板：`请以【{name}·{title}】的身份协助我完成以下任务：`

改进点：将专家提示词模板从静态函数改为使用同步的专家 `promptTemplate` 字段：

```typescript
// catalog.ts 中的 buildExpertPrompt 改进
function buildExpertPrompt(expert: Expert): string {
  const template = expert.promptTemplate || '请以【{name}·{title}】的身份协助我完成以下任务：'
  return template
    .replace('{name}', expert.name)
    .replace('{title}', expert.title)
}
```

### 7.3 专家 → SubAgent 配置转换

当选中专家并提交消息时，需要将选中专家转换为 DeepAgents 的 `SubAgent` 配置，注入主智能体。

**DeepAgents SubAgent 接口**（TypeScript / 桌面版 `deepagents` npm 包）：

```typescript
interface SubAgent {
  name: string          // 子智能体名称（唯一标识）
  description: string    // 描述（主智能体据此决定何时委派任务）
  tools?: unknown[]      // 工具列表
  prompt?: string        // 系统提示词
  model?: string         // 模型标识
  skills?: string[]      // skills 目录路径
}
```

**转换逻辑（`AgentManager` 中新增方法）：**

```typescript
// desktop/src/main/agent/AgentManager.ts

import type { SubAgent } from 'deepagents'

/** 将桌面版专家数据转换为 DeepAgents SubAgent 配置 */
function expertToSubAgent(expert: DesktopExpert): SubAgent {
  const description = expert.isExpert
    ? `${expert.title}。专长领域：${expert.expertiseAreas.join('、')}。`
      + `适用场景：当任务涉及${expert.tags.join('、')}时，应委派给此专家处理。`
    : expert.desc

  return {
    name: expert.name,
    description,
    prompt: expert.systemPrompt || undefined,
    // tools 和 model 在桌面版由本地工具注册表和模型服务解析，
    // 此处暂传空数组 / undefined，后续迭代中接入本地工具注册
    tools: [],
    skills: [],
  }
}

/** 设置选中的专家为主智能体的子智能体 */
setExperts(experts: DesktopExpert[]): this {
  const subagents = experts.map(expertToSubAgent)
  this.builder?.setSubagents(subagents)
  return this
}
```

### 7.4 提交消息时的专家注入流程

```
用户在 NewTaskPage 输入框：
  1. 通过「+ 菜单 → 专家」选择专家 → catalog.selectedExpertId / selectedExpertPrompt
  2. 提示词自动插入输入框开头（现有逻辑）
  3. 用户输入问题正文
  4. 点击发送

发送时（NewTaskPage.vue → agentStore.sendMessage）：
  5. agentStore 从 catalog 读取 selectedExpert
  6. 调用 IPC：window.api.agent.setExperts([selectedExpert])
  7. 主进程 AgentManager.setExperts() → builder.setSubagents()
  8. AgentManager 重新构建 agent（或热更新 subagents）
  9. agent.streamEvents() 提交问题

主智能体运行时：
  10. 主智能体收到消息，prompt 开头是专家提示词
  11. 主智能体进行任务拆分（planner）
  12. 根据子智能体 description 匹配，将相关子任务委派给专家子智能体
  13. 专家子智能体用自己的 system_prompt 和 tools 执行子任务
  14. 结果返回主智能体汇总
```

### 7.5 IPC 通道：设置专家子智能体

**文件：`desktop/src/main/ipc/` （扩展现有 agent handlers 或新增）**

```typescript
// 在 conversation-handlers.ts 或新建 agent-handlers.ts 中
ipc.handle('agent:set-experts', async (_event, experts: DesktopExpert[]) => {
  try {
    agentManager.setExperts(experts)
    return ok(null)
  } catch (err) {
    return fail((err as Error).message)
  }
})
```

**Preload 暴露：**

```typescript
// preload/index.ts
agent: {
  // ... 现有方法 ...
  setExperts: (experts: DesktopExpert[]) => ipcRenderer.invoke('agent:set-experts', experts),
},
```

### 7.6 全部同步专家作为子智能体（需求 2 完整方案）

需求 2 要求"对于适合选中专家解决的任务分配给专家"。有两种策略：

**策略 A（推荐）：用户选中专家 → 注入为子智能体**

- 用户在输入框通过「+ 菜单 → 专家」选择一个或多个专家
- 选中的专家转换为 `SubAgent` 注入主智能体
- 主智能体 planner 自动判断哪些子任务适合委派给这些专家
- 这是"选中专家"的直接含义

**策略 B（扩展）：同步的全部专家都成为子智能体**

- `ExpertSyncService.sync()` 后，所有活跃专家自动注册为子智能体
- 用户在输入框"选中"专家只是插入提示词引导，实际子智能体始终全部可用
- 优点：主智能体可自由委派给任何专家；缺点：token 消耗大、模型上下文长

本方案推荐策略 A，保留策略 B 作为配置选项。

```typescript
// AgentManager 新增配置项
private expertMode: 'selected' | 'all' = 'selected'

setExpertMode(mode: 'selected' | 'all'): this {
  this.expertMode = mode
  return this
}

// 在 buildAgent 中
if (this.expertMode === 'all' && this.experts.length > 0) {
  const subagents = this.experts.map(expertToSubAgent)
  this.builder.setSubagents(subagents)
}
```

### 7.7 与 Web 版子智能体机制的对齐

Web 版的 `create_subagents()` 函数（`web/backend/src/agent/subagents/subagents_operate.py`）已实现从数据库查询活跃子智能体并构建 subagents 列表。桌面版的方案与 Web 版逻辑对称：

| 维度 | Web 版 | 桌面版 |
|------|--------|--------|
| 数据来源 | DB `agents` 表 | 桌面版内存（从 Web 同步） |
| 子智能体构建 | `create_subagents()` → dict | `expertToSubAgent()` → SubAgent |
| 注入方式 | `AgentBuilder.with_subagents()` → `create_deep_agent(subagents=...)` | `AgentBuilder.setSubagents()` → `createDeepAgent({ subagents })` |
| 工具解析 | `tool_registry.get(name)` | 本地工具注册表（待实现） |
| 模型解析 | `resolve_model(provider_id, model_id)` | `ModelService` / `ModelFactory` |
| Skills 路径 | `/skills/{agent_id}/` | `/skills/{expert_id}/`（本地或从 Web 同步） |

桌面版与 Web 版使用同一个 `deepagents` 库（Web 用 Python 版，桌面版用 TypeScript npm 版），SubAgent 结构一致，确保专家配置在两端行为一致。

### 7.8 动态子智能体与异步子智能体的集成点

根据 DeepAgents 文档：

**动态子智能体**：桌面版可在 `AgentBuilder` 中启用 `dynamicSubagents: true`，主智能体获得 `create_subagent` 工具。当同步的专家列表中没有匹配的专家时，主智能体可临时创建新子智能体。

```typescript
// AgentBuilder.ts 新增
setDynamicSubagents(enabled: boolean): this {
  this.config.dynamicSubagents = enabled
  return this
}
```

**异步子智能体**：当专家任务耗时较长（如深度研究），可启用异步模式：

```typescript
// AgentBuilder.ts 新增
setSubagentMode(mode: 'sync' | 'async'): this {
  this.config.subagentMode = mode
  return this
}
```

两者均在桌面版中预留接口，后续按需启用。

---

## 八、OAuth2 Scope 与鉴权（已实现）

### 8.1 scope 定义

文件：`web/backend/src/api/oauth2/scope_service.py`

`SCOPE_LABELS` 已包含：

- `expert:read`：读取并同步专家列表。

### 8.2 OAuth2 客户端授权

文件：`web/backend/src/db/seeds/oauth2_clients_seed.json`

- `ke-work-desktop` 的 `allowed_scopes` 已包含 `expert:read`，同时包含 `skill:read`、`user:read`、`agent:read`、`conversation:read`、`conversation:write`、`workspace:read`。
- `workmate-mobile` 的 `allowed_scopes` 也包含 `expert:read`。

### 8.3 鉴权差异

- Web 管理 API `/api/experts` 使用 `get_current_user_id`，只校验第一方 access token。
- 同步 API `/api/expert-sync` 使用 `require_scope("expert:read")`。该依赖对含 `client_id` 的 OAuth2 客户端 token 校验 scope；对 Web 第一方 token（无 `client_id`）按登录态放行。

依赖定义：`web/backend/src/api/deps.py`。

---
## 九、测试方案

### 9.1 Web 后端测试（待补充）

| 测试项 | 方法 | 预期 |
|--------|------|------|
| 专家表结构 | 启动后检查 `expert_profiles` 表 | 表存在，`agent_id` 外键 CASCADE |
| 创建专家 | POST /api/experts | 同时写入 agents、expert_profiles、关联表 |
| 专家列表筛选 | GET /api/experts?keyword=&category=&featured=&status=&sort= | 过滤、排序、分页正确 |
| 更新展示元数据 | PUT /api/experts/{id}/profile | 仅更新传入字段 |
| 批量更新配置 | PUT /api/experts/{id}/config | 工具 / 技能 / MCP 全量替换正确 |
| 删除专家 | DELETE /api/experts/{id} | profile 与关联数据级联清理 |
| 状态切换 | PATCH /api/experts/{id}/status | active / inactive 互切 |
| 同步列表 | GET /api/expert-sync/list | 仅返回 is_published=true 且 active 的专家 |
| scope 校验 | 无 token / 缺少 expert:read 请求同步 API | 返回 401 / 403 |
| 版本快照 | 创建 / 更新专家 | agent_versions 生成快照 |

### 9.2 Web 前端测试（待补充）

| 测试项 | 方法 | 预期 |
|--------|------|------|
| 专家页加载 | 挂载 ExpertView | 调用列表接口并渲染 |
| 搜索 / 分类 / 排序 | 触发对应交互 | 请求参数与结果正确 |
| 创建 / 编辑抽屉 | 打开 ExpertEditDialog | 表单回填 / 提交数据正确 |
| 克隆 / 删除 / 停用 | 触发卡片操作 | 调用对应 API，列表刷新 |
| Mock 清理 | 移除 mock 分支后回归 | 真实 API 路径稳定 |

### 9.3 桌面版测试（待实现）

| 测试项 | 方法 | 预期 |
|--------|------|------|
| 同步授权 | 点击同步专家 → 浏览器授权 | 返回 authorized |
| 同步拉取 | ExpertSyncService.sync | 返回 /api/expert-sync/list 数据并映射 |
| 专家页面展示 | ExpertPage | 展示同步专家卡片 |
| 选中专家 → 输入框 | NewTaskPage | 提示词插入输入框 |
| 专家 → 子智能体注入 | AgentManager.setExperts | AgentBuilder.subagents 非空 |
| 离线缓存 | 断网打开页面 | 显示缓存数据 |

---
## 十、实施状态与后续步骤

| 阶段 | 任务 | 状态 | 依赖 |
|------|------|------|------|
| Web 后端 | ExpertProfile 表 + 管理 / 同步 API | 已完成 | 无 |
| Web 后端 | OAuth2 expert:read scope + 客户端配置 | 已完成 | 无 |
| Web 前端 | ExpertView / ExpertCard / ExpertEditDialog | 已完成 | Web 后端 API |
| Web 前端 | expertApi / expert store / types | 已完成，仍保留 mock 分支 | Web 后端 API |
| 桌面版 | ExpertSyncService 对齐 `/api/expert-sync/list` | 待实现 | 同步 API |
| 桌面版 | Preload / IPC 暴露 | 待实现 | ExpertSyncService |
| 桌面版 | catalog store 静态 → 动态 | 待实现 | Preload |
| 桌面版 | ExpertPage 改造 | 待实现 | Store |
| 桌面版 | AgentManager.setExperts + expertToSubAgent | 待实现 | Store |
| 桌面版 | NewTaskPage 专家注入 | 待实现 | AgentManager |
| 测试 | Web 后端 / 前端 / 桌面端测试 | 待补充 | 对应模块 |
| 清理 | 移除前端 mock 专家数据和 mock 分支 | 待处理 | Web 前端 |

---
## 十一、假设与约定

1. 专家是 `agents.type='sub'` 且存在 `expert_profiles` 记录的 Agent；主智能体为 `agents.type='main'`，专家通过 `parent_id` 挂到主智能体。
2. 专家核心配置（模型、系统提示词、工具、技能、MCP）复用 `agents` 及其关联表；`expert_profiles` 只存面向用户展示的门面数据。
3. Web 管理端走独立 `/api/experts`，不是复用 `/api/agents` 的专家过滤；同步端走独立 `/api/expert-sync`。
4. 桌面版只同步已发布且启用的专家（`is_published=true` 且 `status='active'`），按 `sort_order` 倒序。
5. Web 第一方 token 访问 `/api/expert-sync` 时，`require_scope` 按登录态放行；OAuth2 客户端 token 必须包含 `expert:read`。
6. 桌面版 `ExpertSyncService` 应消费 `/api/expert-sync/list` 的 `items` 字段，而不是早期方案中的 `/api/agents/experts/list` 与 `experts` 字段。
7. 前端 `expertApi.ts` 负责 snake_case / camelCase 转换；当前 `stores/expert.ts` 中的 mock 分支仅用于无后端阶段，后续可删除。
8. 专家工具和模型在桌面版中仍需对接本地工具注册表与 ModelService，这是后续迭代接入点。
9. `selectedExpertId` 从 number 改为 string（Web UUID），需兼容 localStorage 旧值。
10. 动态子智能体和异步子智能体在初始版本中预留接口但不默认启用，待专家功能稳定后按需打开。
