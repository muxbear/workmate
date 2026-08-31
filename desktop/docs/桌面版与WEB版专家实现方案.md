# 桌面版与 WEB 版专家实现方案

> 本文档基于 DeepAgents 官方文档（子智能体、动态子智能体、异步子智能体、解释器、配置 / Profiles）以及 WorkMate 现有代码结构，对"专家"功能在桌面版与 Web 版之间的数据存储、同步、分配与全生命周期管理进行完整规划。

---

## 方案现状与调研结论

> 本次已对照仓库实际代码完成静态核对。总体结论：**方案方向可行，Web 端大部分已落地，但文档中的部分字段、接口和实现步骤与实际代码或当前 DeepAgents TypeScript 包不一致，需按本节修正后再进入编码。**

核对要点：

1. Web 后端已实际实现 `expert_profiles` 表、`/api/experts` 管理 API、`/api/expert-sync` 同步 API 和 `expert:read` scope。
2. 当前创建专家时写入的是 `agents.type=expert`，不是文档原稿中的 `type=sub`。应统一为 `expert`。
3. `/api/expert-sync/featured` 路由目前被 `/{expert_id}` 遮挡，若要启用精选同步接口，需要调整路由声明顺序。
4. Web 前端专家列表和 CRUD 已接真实 API，但精选场景仍是 `MOCK_SCENES`，未调用 `fetchFeaturedExperts()`。
5. 桌面版静态子智能体可用，但 TypeScript 的 `SubAgent` 使用 `systemPrompt`，不是 `prompt`；文档原示例会编译失败。
6. 当前 `deepagents@1.11.1` 没有 `dynamicSubagents` / `subagentMode` 这两个直接配置项；动态/异步子智能体应按实际 API 重新设计。
7. `AgentManager.setExperts()` 不能只调用 `builder.setSubagents()`，必须重建 `this.agent` 后才对后续消息生效。
8. `catalog.ts` 静态专家改动态后，还需要同步修改 `PlusMenu.vue`，并兼容旧的 number 类型 localStorage 选择状态。
9. 当前 `/api/expert-sync/list` 返回的 `ExpertSyncItem` 只包含展示字段，不包含模型、工具、技能、MCP 等执行配置，导致桌面端无法还原专家能力。
10. 桌面端映射时把 tools 写死为空数组、providerId/modelId 写死为 null，配置再次丢失。
11. AgentManager.expertToSubAgent 当前 tools 和 skills 为空且未设置 model，专家实际只是普通子智能体。
12. Web 后端 image_generate 是 stub，model_sync 也不包含 image-gen 类型，桌面端拿不到 GLM-Image 凭据。
13. 现有输入框提示词是身份扮演型，不利于主智能体拆任务、委派专家和汇总结果。

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

Web 版已落地：专家作为 `agents.type='expert'` 的记录，展示元数据单独存储在 `expert_profiles` 表；Web 管理页面走 `/api/experts`，桌面版 / 移动版同步走 `/api/expert-sync`。

专家数据流仍为四层：Web 数据库存储 → REST API → 桌面版同步服务 → Pinia Store → AgentManager 子智能体配置。

---
## 二、DeepAgents 文档要点

本方案严格遵循 DeepAgents 官方文档的以下概念：

### 2.1 子智能体（Subagents）

> 文档：https://docs.langchain.com/oss/python/deepagents/subagents

- 子智能体通过 `create_deep_agent()` 的 `subagents=[...]` 参数声明；Python 版使用 dict，桌面版 TypeScript 的 `SubAgent` 必填 `name`、`description`、`systemPrompt`，可选 `tools`、`model`、`skills` 等字段。注意 TypeScript 字段名是 `systemPrompt`，不是 `prompt`。
- 主智能体在规划阶段根据子智能体的 `description` 自动决定是否委派任务。子智能体作为独立的图节点运行，拥有自己的 LLM 调用上下文。
- 子智能体可以拥有独立的工具集和 skills 目录（`/skills/<agent_id>/`），与主智能体隔离。
- 桌面版 `deepagents` npm 包中对应 `SubAgent` 接口，通过 `createDeepAgent({ subagents })` 传入。

### 2.2 动态子智能体（Dynamic Subagents）

> 文档：https://docs.langchain.com/oss/python/deepagents/dynamic-subagents

- 动态子智能体在运行时由主智能体自行创建，而非在编译期静态声明。
- 当前 TypeScript 包没有 `dynamic_subagents=True` 这样的直接开关；动态委派由 DeepAgents 的 task tool 和已声明的 `subagents` 完成。若需临时扩展，应基于实际 `subagents` / `createSubAgentMiddleware` 设计，而不是新增 `dynamicSubagents` 布尔配置。
- 适用于任务不确定、专家角色可能临时扩展的场景。本方案中桌面版主智能体默认使用静态子智能体（从同步的专家列表构建），同时保留动态子智能体能力供运行时扩展。

### 2.3 异步子智能体（Async Subagents）

> 文档：https://docs.langchain.com/oss/python/deepagents/async-subagents

- 异步子智能体允许子任务在后台执行，主智能体不必等待其完成即可继续推进。
- TypeScript 包中异步子智能体通过 `AsyncSubAgent` + `createAsyncSubAgentMiddleware` 实现，要求 `graphId` 和可选 `url`，指向远程 Agent Protocol server；没有 `subagentMode='async'` 这类简单开关。
- 适用于耗时较长（如深度研究、大量文件处理）的专家任务，主智能体可并行处理多个子任务。
- 因此桌面版如需异步专家，需准备远程 Agent Protocol 服务，并注入 async middleware；不能仅靠本地开关实现。

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
- 专家判定：`agents.type = 'expert'` 且存在对应 `expert_profiles` 记录。

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

`sync_list` 只返回 `is_published=true` 且 `status='active'` 的专家，并按 `sort_order` 倒序。响应结构为 `{ items, total, synced_at }`，每个 item 是 `ExpertSyncItem`。本次升级后，ExpertSyncItem 必须包含 provider/model/tools/skills/mcp 等执行字段。

### 3.5 Service 设计

文件：`web/backend/src/api/experts/service.py`

- `ExpertAssembler`：工厂式组装 `Agent + ExpertProfile + tools + skills + mcp_configs`，保证列表 / 详情 / 同步数据一致。
- `SORT_STRATEGIES`：策略字典实现 rating / usage / recent / name 排序。
- `list_experts`：JOIN `agents` + `expert_profiles`，先筛选再排序，最后内存分页。
- `create_expert`：插入 `Agent`（type=expert，parent_id=主智能体，status=inactive）+ `ExpertProfile` + 关联表，并创建版本快照、失效图缓存。
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
- 精选场景区域（当前为静态 `MOCK_SCENES`，需接 `/api/experts/featured` 才能真正展示后端数据）。
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
- 当前 Store 的列表/CRUD 已通过 `useMock = false` 走真实 API；但 `featuredScenes` 仍初始化为 `MOCK_SCENES`，`fetchFeaturedExperts()` 尚未被调用，需补接真实精选数据后清理 mock。

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
  provider_id: string | null
  model_id: string | null
  model_name: string | null
  model_type: string | null
  tools: ExpertSyncToolBrief[]
  skills: ExpertSyncSkillBrief[]
  mcp_configs: ExpertSyncMcpBrief[]
  prompt_template: string
  expertise_areas: string[]
}

interface ExpertSyncToolBrief { id: string; name: string; display_name: string; tool_type: string; category: string; icon?: string }
interface ExpertSyncSkillBrief { id: string; name: string; description: string; category: string; icon: string; enabled: boolean }
interface ExpertSyncMcpBrief { mcp_tool_id: string; mcp_tool_name: string; config: Record<string, unknown>; enabled: boolean }

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
    initials: item.initials || item.name.charAt(0),
    systemPrompt: item.system_prompt,
    tools: item.tools.map((t) => t.name),
    skills: item.skills,
    providerId: item.provider_id,
    modelId: item.model_id,
    modelName: item.model_name,
    modelType: item.model_type,
    mcpConfigs: item.mcp_configs,
    promptTemplate: item.prompt_template,
    expertiseAreas: item.expertise_areas,
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
  openExternal: (url) =>
    process.env.WORKMATE_OAUTH_INTERNAL_BROWSER === '1'
      ? openOAuthWindow(url)
      : shell.openExternal(url),
  apiBaseUrl: process.env.WORKMATE_WEB_API_BASE_URL ?? '',
  clientId: process.env.WORKMATE_OAUTH_CLIENT_ID ?? 'ke-work-desktop'
})
registerExpertSyncHandlers(ipcMain, { expertSyncService, session })
```

> 说明：`expert:read` 使用独立 token key，首次同步专家会触发一次单独的 OAuth2 授权；如果希望和技能同步共享登录态，需统一 scope 与 token key。

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
  modelName: string | null
  modelType: string | null
  skills: unknown[]
  mcpConfigs: unknown[]
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
  modelName: string | null
  modelType: string | null
  skills: unknown[]
  mcpConfigs: unknown[]
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

> 注意：实际还有 `PlusMenu.vue` 直接使用 `store.experts`，也需要同步改为 `experts.value` 和 string id。localStorage 中旧的 `selectedExpertId` / `recentExpertIds` 若为 number，需要迁移/忽略。

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
- 不再默认插入“请以某专家身份协助我”的提示词。
- 如果需要插入提示，应插入任务编排提示：先拆解任务，适合该专家的子任务委派给专家，最后汇总。

改进点：将专家提示词模板从静态函数改为编排型模板：

```typescript
// catalog.ts 中的 buildExpertPrompt 调整为编排型提示
function buildExpertPrompt(expert: Expert): string {
  const template = expert.promptTemplate
    || '请先分析任务并拆分为子任务；对于适合【{name}·{title}】处理的子任务，请调用该专家处理；最后汇总结果。'
  return template
    .replace('{name}', expert.name)
    .replace('{title}', expert.title)
}
```

> 主智能体本身已由 DeepAgents 的 `TASK_SYSTEM_PROMPT` 引导使用 task 工具委派子智能体。该输入框提示只是可选强化，不应把用户原始任务改写成“我以专家身份回答”。

### 7.3 专家 → SubAgent 配置转换

当选中专家并提交消息时，需要将选中专家转换为 DeepAgents 的 `SubAgent` 配置，注入主智能体。

**DeepAgents SubAgent 接口**（TypeScript / 桌面版 `deepagents` npm 包）：

```typescript
interface SubAgent {
  name: string
  description: string
  systemPrompt: string
  tools?: unknown[]
  model?: string
  skills?: string[]
}
```

**转换逻辑（`AgentManager` 中新增方法）：**

```typescript
// desktop/src/main/agent/AgentManager.ts

import type { SubAgent } from 'deepagents'

/** 将桌面版专家数据转换为 DeepAgents SubAgent 配置 */
function buildExpertDescription(expert: DesktopExpert): string {
  const expertise = (expert.expertiseAreas || []).join('、') || expert.desc || '无'
  const tags = (expert.tags || []).join('、') || '通用任务'
  const tools = (expert.tools || []).join('、') || '无专用工具'
  return [expert.name + '：' + expert.title + '。', '专长领域：' + expertise + '。', '适用场景：' + tags + '，可用工具：' + tools].join('')
}

function resolveExpertModel(expert: DesktopExpert, modelService: ModelService) {
  if (expert.modelType === 'image-gen') return undefined
  const modelId = expert.modelName || expert.modelId || undefined
  if (modelId === undefined) return undefined
  const credential = modelService.getCredential(modelId)
  return credential ? createModelFromCredential(credential) : undefined
}

function expertToSubAgent(expert: DesktopExpert, modelService: ModelService): SubAgent {
  return {
    name: expert.name,
    description: buildExpertDescription(expert),
    systemPrompt: expert.systemPrompt || '',
    model: resolveExpertModel(expert, modelService),
    tools: buildExpertTools(expert.tools, modelService),
    skills: buildExpertSkills(expert.skills)
  }
}

/** 设置选中的专家为主智能体的子智能体，并重建 agent */
async setExperts(experts: DesktopExpert[]): Promise<void> {
  this.experts = experts
  if (this.builder === null) throw new Error('AgentManager not initialized')
  this.initPromise = this.buildAgent(this.currentMode)
  await this.initPromise
}
```

> 其中 `buildExpertDescription`、`resolveExpertModel`、`buildExpertTools`、`buildExpertSkills` 为新增的桌面端工具/模型解析函数；`buildExpertTools` 至少需要实现 `image_generate`，`resolveExpertModel` 对 image-gen 模型返回 undefined，避免把生成模型误当作对话模型。

### 7.4 提交消息时的专家注入流程

```
用户在 NewTaskPage 输入框：
  1. 选择专家，展示专家 chip，但不把用户任务改写成“我以专家身份回答”。
  2. 用户输入原始问题正文。
  3. 点击发送。

发送时：
  4. 渲染层读取 selectedExpert。
  5. 调用 IPC agent:set-experts，把选中专家作为 SubAgent 注入主智能体。
  6. 主进程重建 agent，等待成功后继续。
  7. 调用 agent:send 提交用户原始问题。

主智能体运行时：
  8. 主智能体使用 DeepAgents 的 task 工具和 TASK_SYSTEM_PROMPT 进行任务拆分。
  9. 依据每个 SubAgent 的 description 判断是否需要委派给专家。
  10. 相关子任务委派给专家子智能体，其余子任务由主智能体/通用子智能体处理。
  11. 专家子智能体使用自己的 systemPrompt、model、tools 执行子任务。
  12. 专家把结构化结果（文本、图片路径/URL 等）返回给主智能体。
  13. 主智能体汇总所有子任务结果，形成最终回复。
```

### 7.5 IPC 通道：设置专家子智能体

**文件：`desktop/src/main/ipc/` （扩展现有 agent handlers 或新增）**

```typescript
// 在 conversation-handlers.ts 或新建 agent-handlers.ts 中
ipc.handle('agent:set-experts', async (_event, experts: DesktopExpert[]) => {
  try {
    await agentManager.setExperts(experts)
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

本方案推荐策略 A，保留策略 B 作为配置选项。当前 catalog 是单选专家；若后续升级为多专家协作，需要把 selectedExpertId 改为 selectedExpertIds: string[]，NewTaskPage 发送 setExperts(catalog.selectedExperts)，而不是只发送一个专家。

```typescript
// AgentManager 新增状态与重建逻辑
private experts: DesktopExpert[] = []
private expertMode: 'selected' | 'all' = 'selected'
private currentMode: WorkMode = 'local'

setExpertMode(mode: 'selected' | 'all'): this {
  this.expertMode = mode
  return this
}

/** 设置专家并重建 agent；调用方必须 await 后再发送消息 */
async setExperts(experts: DesktopExpert[]): Promise<void> {
  this.experts = experts
  if (!this.builder) throw new Error('AgentManager not initialized')
  this.initPromise = this.buildAgent(this.currentMode)
  await this.initPromise
}

// 在 buildAgent 中，在 this.agent = await this.builder.build() 前写入：
if (this.expertMode === 'all' && this.experts.length > 0) {
  this.builder.setSubagents(this.experts.map(expertToSubAgent))
} else if (this.expertMode === 'selected' && this.experts.length > 0) {
  this.builder.setSubagents(this.experts.map(expertToSubAgent))
}

// init()/switchMode() 中同步记录 currentMode
async init(mode: WorkMode): Promise<void> {
  this.currentMode = mode
  this.initPromise = this.buildAgent(mode)
  return this.initPromise
}

async switchMode(newMode: WorkMode): Promise<void> {
  this.currentMode = newMode
  if (!this.builder) throw new Error('AgentManager not initialized')
  this.initPromise = this.buildAgent(newMode)
  await this.initPromise
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
| 图片生成能力 | Web 后端实现 image_generate 真实 API | Desktop ImageGenerateTool + ImageGenerationService |

桌面版与 Web 版分别使用 `deepagents` 的 TypeScript 版和 Python 版；两者字段命名存在差异，例如桌面版是 `systemPrompt`。转换时不要照搬 Python 版的 `prompt` / `system_prompt` 字段名。

### 7.8 动态子智能体与异步子智能体的集成点

根据 DeepAgents 文档：

**动态子智能体**：当前 TypeScript 版不通过 `dynamicSubagents: true` 开启。主智能体已经通过 task tool 依据 `subagents[].description` 动态选择并委派；若需要更多自定义行为，应基于 `createSubAgentMiddleware` / `SubAgent` 设计，而不是新增不存在的布尔配置。

**异步子智能体**：如需异步专家，应使用 `AsyncSubAgent` + `createAsyncSubAgentMiddleware`，每个异步子智能体需要指向远程 Agent Protocol server 的 `graphId` 和可选 `url`。这是一个独立中间件，不是本地 `subagentMode` 开关。

两者均标记为后续迭代，初始版本不启用。

### 7.9 图片生成专家专项落地方案（本轮新增）

针对图片生成专家暴露的问题，按以下顺序落地：

1. 同步契约补全。
   - Web ExpertSyncItem 增加 provider_id / model_id / model_name / model_type / tools / skills / mcp_configs / prompt_template / expertise_areas。
   - ExpertAssembler.to_sync_item 从 ExpertInfo 原样填充，不再只返回展示字段。
   - DesktopExpert 与 mapExpert 保留这些字段。

2. 桌面专家执行链修复。
   - expertToSubAgent 必须设置 model、tools、skills。
   - image-gen 模型不作为子智能体对话模型，回退主智能体默认模型，同时注入 image_generate 工具。
   - 建立 buildExpertDescription，使主智能体有足够信息判断是否委派。

3. 图片生成能力落地。
   - Web 后端替换 image_generate stub，按提供商调用真实图片生成 API。
   - Desktop 新增 ImageGenerateTool 和 ImageGenerationService，支持智谱 GLM-Image / OpenAI Images / DashScope 等适配器。
   - model_sync 允许同步 image-gen 模型，使桌面端能取得 GLM-Image 凭据。

4. 编排与结果汇总。
   - 输入框不再插入身份扮演型提示词，改为编排提示或保持原始用户问题。
   - 主智能体依赖 DeepAgents task tool + TASK_SYSTEM_PROMPT 拆任务、委派、汇总。
   - 图片生成结果统一返回 artifacts（图片路径/URL），桌面端 MessageContent 负责渲染。

5. 多专家能力。
   - 当前 catalog 单选专家，若需要多专家协作，升级 selectedExpertIds 并一次注入多个 SubAgent。

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
| 同步完整配置 | GET /api/expert-sync/list | 返回 model/tools/skills/mcp，不再丢失执行配置 |
| image_generate 工具 | 模拟专家调用图片生成工具 | 返回真实图片 URL/路径，不再是 not configured |

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
| 专家 → 子智能体注入 | AgentManager.setExperts | setExperts 后重建 agent，ready() 返回的 agent 已包含 subagents |
| 离线缓存 | 断网打开页面 | 显示缓存数据 |
| 编排链路 | 输入复杂问题 | 主智能体拆解任务并委派专家，最终汇总 |
| 图片生成 | 图片生成专家 + 生成小猫图片 | 子智能体调用 ImageGenerateTool，返回图片结果 |
| 模型角色 | 图片生成专家 | image-gen 不作为子智能体对话模型，不产生 ChatOpenAI 误调用 |

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
| 修正 | 统一专家 type=expert / 修复 expert-sync featured 路由 | 待处理 | Web 后端 |
| 修正 | Web 前端精选场景接真实 API，清理 MOCK_SCENES | 待处理 | Web 后端 API |
| 修正 | 桌面 SubAgent 字段与 DeepAgents API 对齐 | 待处理 | 调研结论 |
| 修正 | AgentManager.setExperts 重建 agent + PlusMenu/localStorage 兼容 | 待处理 | 调研结论 |
| 清理 | 移除前端 mock 专家数据和 mock 分支 | 待处理 | Web 前端 |
| 图片生成专家专项 | 同步契约、桌面专家执行链、图片生成工具、模型同步 | 待实施 | 本方案 7.9 |

---
## 十一、假设与约定

1. 专家是 `agents.type='expert'` 且存在 `expert_profiles` 记录的 Agent；主智能体为 `agents.type='main'`，专家通过 `parent_id` 挂到主智能体。
2. 专家核心配置（模型、系统提示词、工具、技能、MCP）复用 `agents` 及其关联表；`expert_profiles` 只存面向用户展示的门面数据。
3. Web 管理端走独立 `/api/experts`，不是复用 `/api/agents` 的专家过滤；同步端走独立 `/api/expert-sync`。
4. 桌面版只同步已发布且启用的专家（`is_published=true` 且 `status='active'`），按 `sort_order` 倒序。
5. Web 第一方 token 访问 `/api/expert-sync` 时，`require_scope` 按登录态放行；OAuth2 客户端 token 必须包含 `expert:read`。
6. 桌面版 `ExpertSyncService` 应消费 `/api/expert-sync/list` 的 `items` 字段，而不是早期方案中的 `/api/agents/experts/list` 与 `experts` 字段。
7. 前端 `expertApi.ts` 负责 snake_case / camelCase 转换；当前 `stores/expert.ts` 中的 mock 分支仅用于无后端阶段，后续可删除。
8. 本次升级后 `/api/expert-sync/list` 应直接返回专家执行所需的 provider/model/tools/skills/mcp 字段；桌面端 mapExpert 必须原样保留，不再写死为空。
9. `selectedExpertId` 从 number 改为 string（Web UUID），需兼容 localStorage 旧值。
10. 动态委派基于当前 TypeScript 版的 task tool + 静态 `subagents`；异步子智能体需使用 `AsyncSubAgent` + `createAsyncSubAgentMiddleware` 和远程 Agent Protocol server，不在初始版本启用。
