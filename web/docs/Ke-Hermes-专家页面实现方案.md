# Ke-Hermes 专家（Expert）页面实现方案

> 文档位置：`web/docs/Ke-Hermes-专家页面实现方案.md`
> 创建日期：2026-08-28
> 状态：方案规划

---

## 一、背景与目标

### 1.1 现状

桌面版已实现「专家」页面（`desktop/src/renderer/src/views/ExpertPage.vue`），展示一组预配置的专家卡片，用户可「召唤」专家将其提示词注入对话。当前专家数据硬编码在 `desktop/src/renderer/src/store/catalog.ts` 的 `experts` 数组中（8 条静态数据），无法动态管理。

Web 版主界面「智能体 → 专家」菜单尚未实现。需要在本方案中完成：

1. **检索、编辑、查询、删除专家**（CRUD）
2. **编辑专家时配置**：模型、提示词、工具、技能、MCP 等
3. **对外提供同步接口**，供桌面版（及未来移动版）获取和同步专家数据

### 1.2 设计原则

- **最大化复用现有 Agent 基础设施**：专家本质上是「子智能体（sub-agent）+ 展示元数据」。现有 `agents` 表已支持 name / description / system_prompt / provider_id / model_id，`agent_tools` / `agent_skills` 关联表已支持工具与技能绑定，`AgentVersion` 已支持版本快照。专家在此基础上扩展展示与分类字段，避免重复造轮子。
- **与现有 AgentsView 共存**：AgentsView 管理智能体层级（主智能体 + 子智能体），ExpertView 管理专家的「门面」展示与分类。两者共享同一张 `agents` 表，通过 `expert_profiles` 关联表区分。
- **同步复用 OAuth2 体系**：参照 `SkillSyncService` 的 OAuth2 Authorization Code + PKCE 模式，为桌面版/移动版提供 `expert:read` scope 的同步接口。
- **MCP 复用 agent_tools 机制**：MCP 工具已注册为 `Tool` 记录（`tool_type='mcp'`），通过 `agent_tools` 关联即可为专家配置 MCP 工具。同时新增 `agent_mcp_configs` 表存储专家级 MCP 运行配置。

---

## 二、数据模型设计

### 2.1 新增模型

#### 2.1.1 ExpertProfile — 专家展示元数据（1:1 关联 agents）

> 文件：`web/backend/src/db/models/expert_profile.py`

| 字段 | 类型 | 说明 |
|------|------|------|
| `agent_id` | String(36) FK, PK | 关联的 Agent ID（1:1） |
| `title` | String(128) | 头衔（如「内容创作专家」） |
| `category` | String(32) | 分类 key（如 content_creation / legal_tax / tech_rnd） |
| `tags` | JSON (list[str]) | 标签（如 ["小红书", "品牌文案"]） |
| `icon` | String(64) | 图标 emoji 或图标名 |
| `color` | String(128) | 头像渐变色 CSS |
| `initials` | String(8) | 头像文字 |
| `avatar_url` | String(512) nullable | 头像图片 URL |
| `rating` | Float default=0.0 | 评分 0-5 |
| `usage_count` | Integer default=0 | 使用次数 |
| `featured` | Boolean default=False | 是否精选 |
| `scene` | String(32) nullable | 所属精选场景 key |
| `sort_order` | Integer default=0 | 排序权重 |
| `is_published` | Boolean default=True | 是否已发布 |
| `created_at` | DateTime | 创建时间 |
| `updated_at` | DateTime | 更新时间 |

设计说明：

- `agent_id` 同时作为主键和外键，确保 1:1 关系。
- 专家 = `agents.type='sub'` 且存在对应的 `expert_profiles` 记录。
- `category` 支持自定义，不强制枚举，前端预置常用分类。
- `scene` 对应桌面版「精选场景」分组，null 表示不属于任何场景。

#### 2.1.2 AgentMcpConfig — 专家级 MCP 运行配置

> 文件：`web/backend/src/db/models/agent_mcp_config.py`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | String(36) PK | UUID |
| `agent_id` | String(36) FK | 关联 Agent |
| `mcp_tool_id` | String(36) FK | 关联 mcp_tools.id |
| `config` | JSON (dict) | 运行配置（command / args / env / transport） |
| `enabled` | Boolean default=True | 是否启用 |
| `created_at` | DateTime | 创建时间 |
| `updated_at` | DateTime | 更新时间 |

UniqueConstraint: `(agent_id, mcp_tool_id)`

设计说明：

- 现有 `mcp_installations` 是用户级 MCP 配置（per-user），不适用于专家。
- 专家级 MCP 配置存储在 `agent_mcp_configs` 中，`mcp_loader.py` 加载时优先读取此表。
- MCP 工具仍通过 `agent_tools` 关联表绑定到专家，`agent_mcp_configs` 提供额外运行参数。

### 2.2 现有模型无需修改

| 模型 | 复用说明 |
|------|----------|
| `Agent` | name / description / system_prompt / provider_id / model_id / files / status |
| `AgentTool` | 关联工具（含 MCP 类型的 Tool） |
| `AgentSkill` | 关联技能 |
| `AgentVersion` | 版本快照自动记录专家配置变更 |
| `Tool` | MCP 工具以 tool_type='mcp' 注册 |
| `Skill` / `Provider` / `AIModel` / `McpTool` | 直接复用 |

### 2.3 ER 关系图

```
agents (1) ──── (1) expert_profiles
    │
    ├── (N) agent_tools ──── (1) tools
    │                          └── tool_type: function | mcp
    ├── (N) agent_skills ─── (1) skills
    ├── (N) agent_mcp_configs ─ (1) mcp_tools
    ├── (N) agent_versions
    └── (N) cron_jobs

providers (1) ──── (N) ai_models
```

### 2.4 专家分类预置

| 分类 key | 中文标签 |
|----------|----------|
| `content_creation` | 内容创作 |
| `legal_tax` | 法律财税 |
| `tech_rnd` | 技术研发 |
| `product_design` | 产品设计 |
| `startup_invest` | 创业投资 |
| `sme_ops` | 小微企业 |
| `ai_tools` | AI工具专家 |
| `spc` | SPC |
| `custom` | 自定义 |

---

## 三、后端 API 设计

### 3.1 路由注册

新增路由模块 `web/backend/src/api/experts/`，注册到 `api/__init__.py`：

```python
from api.experts import router as experts_router
from api.experts.sync_api import router as expert_sync_router
router.include_router(experts_router)
router.include_router(expert_sync_router)
```

### 3.2 专家管理 API（Web 前端使用）

> 前缀：`/api/experts`，标签：`experts`

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| GET | `/api/experts` | 分页列表（搜索、分类筛选、排序） | get_current_user_id |
| GET | `/api/experts/categories` | 获取所有分类及计数 | get_current_user_id |
| GET | `/api/experts/featured` | 获取精选场景 + 精选专家 | get_current_user_id |
| GET | `/api/experts/{expert_id}` | 获取专家详情（含完整配置） | get_current_user_id |
| POST | `/api/experts` | 创建专家 | get_current_user_id |
| PUT | `/api/experts/{expert_id}` | 更新专家基础信息 | get_current_user_id |
| DELETE | `/api/experts/{expert_id}` | 删除专家（级联删除 profile） | get_current_user_id |
| PATCH | `/api/experts/{expert_id}/status` | 切换启用/停用 | get_current_user_id |
| POST | `/api/experts/{expert_id}/clone` | 克隆专家 | get_current_user_id |
| PUT | `/api/experts/{expert_id}/profile` | 更新展示元数据 | get_current_user_id |
| PUT | `/api/experts/{expert_id}/config` | 批量更新配置（模型+提示词+工具+技能+MCP） | get_current_user_id |
| GET | `/api/experts/{expert_id}/mcp-configs` | 获取 MCP 配置列表 | get_current_user_id |
| PUT | `/api/experts/{expert_id}/mcp-configs/{mcp_tool_id}` | 更新单个 MCP 配置 | get_current_user_id |
| DELETE | `/api/experts/{expert_id}/mcp-configs/{mcp_tool_id}` | 删除单个 MCP 配置 | get_current_user_id |

#### 3.2.1 列表查询参数

```
GET /api/experts?page=1&page_size=20&keyword=文案&category=content_creation&featured=true&sort=rating
```

| 参数 | 类型 | 说明 |
|------|------|------|
| page | int >= 1 | 页码，默认 1 |
| page_size | int 1-100 | 每页条数，默认 20 |
| keyword | str | 搜索名称/头衔/标签/描述 |
| category | str | 分类筛选 |
| featured | bool | 仅精选 |
| status | str | 状态筛选（active/inactive） |
| sort | str | 排序：rating(默认) / usage / recent / name |

#### 3.2.2 关键 Schema

> 文件：`web/backend/src/api/experts/schemas.py`

```python
class ExpertCreateRequest(BaseModel):
    """创建专家请求"""
    name: str = Field(min_length=1, max_length=128)
    title: str = Field(max_length=128)
    description: str = ""
    system_prompt: str = ""
    category: str = "custom"
    tags: list[str] = []
    icon: str = ""
    color: str = ""
    initials: str = ""
    provider_id: str | None = None
    model_id: str | None = None
    tool_names: list[str] = []
    skill_ids: list[str] = []
    mcp_configs: list[McpConfigItem] = []
    featured: bool = False
    scene: str | None = None


class ExpertConfigUpdateRequest(BaseModel):
    """批量更新配置（模型+提示词+工具+技能+MCP）"""
    system_prompt: str | None = None
    provider_id: str | None = None
    model_id: str | None = None
    tool_names: list[str] | None = None    # None=不更新, []=清空
    skill_ids: list[str] | None = None
    mcp_configs: list[McpConfigItem] | None = None


class ExpertInfo(BaseModel):
    """专家完整信息"""
    id: str
    name: str
    title: str
    description: str
    category: str
    tags: list[str]
    icon: str
    color: str
    initials: str
    avatar_url: str | None = None
    rating: float
    usage_count: int
    featured: bool
    scene: str | None = None
    sort_order: int
    is_published: bool
    status: str
    system_prompt: str
    provider_id: str | None = None
    model_id: str | None = None
    tools: list[ToolBrief] = []
    skills: list[SkillBrief] = []
    mcp_configs: list[McpConfigBrief] = []
    files: list[str] = []
    created_at: datetime
    updated_at: datetime
```

### 3.3 同步 API（桌面版/移动版使用）

> 前缀：`/api/expert-sync`，标签：`expert-sync`

使用 `require_scope("expert:read")` 依赖校验 OAuth2 scope。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/expert-sync/list` | 获取所有已发布专家（精简版） |
| GET | `/api/expert-sync/{expert_id}` | 获取单个专家完整配置 |
| GET | `/api/expert-sync/featured` | 获取精选场景 + 精选专家 |

#### 3.3.1 同步响应 Schema

```python
class ExpertSyncItem(BaseModel):
    """同步用精简专家数据（适配桌面版 ExpertPage）"""
    id: str
    name: str
    title: str
    desc: str                    # 对齐桌面版字段名
    category: str
    tags: list[str]
    color: str
    initials: str
    icon: str
    avatar_url: str | None = None
    rating: float
    users: str                   # usage_count 格式化文案
    system_prompt: str          # 用于「召唤」注入
    scene: str | None = None
    sort_order: int


class ExpertSyncListResponse(BaseModel):
    items: list[ExpertSyncItem]
    total: int
    synced_at: int               # Unix 时间戳
```

#### 3.3.2 OAuth2 Scope 扩展

在 `db/seeds/oauth2_clients_seed.json` 中添加 `expert:read`：

```json
{
  "client_id": "ke-work-desktop",
  "allowed_scopes": ["skill:read", "user:read", "agent:read", "expert:read",
    "conversation:read", "conversation:write", "workspace:read"]
},
{
  "client_id": "workmate-mobile",
  "allowed_scopes": ["skill:read", "agent:read", "expert:read"]
}
```

### 3.4 业务逻辑要点

> 文件：`web/backend/src/api/experts/service.py`

1. **创建专家**：在 `agents` 表插入 `type='sub'` 记录（parent_id 为主智能体 ID），同时在 `expert_profiles` 插入展示元数据。创建后自动创建版本快照。

2. **删除专家**：先删除 `expert_profiles`，再删除 `agents` 记录（级联删除 agent_tools / agent_skills / agent_mcp_configs / agent_versions / cron_jobs）。检查 `undeletable` 标记。

3. **配置更新**：`PUT /api/experts/{id}/config` 采用「先快照 - 全量替换关联 - 提交」事务模式：
   - 先创建当前配置的版本快照
   - 全量替换 agent_tools（删除旧 - 插入新）
   - 全量替换 agent_skills
   - 全量 upsert agent_mcp_configs
   - 更新 agents 表的 system_prompt / provider_id / model_id
   - 调用 `invalidate_graph()` 使图缓存失效

4. **克隆专家**：复制 Agent + ExpertProfile + 所有关联表 + Store 文件副本。新专家状态为 inactive，名称追加「(副本)」。

5. **同步接口**：`/api/expert-sync/list` 只返回 `is_published=True` 且 `status='active'` 的专家。`usage_count` 格式化为 `1.2k` / `3.4k` 等文案。

6. **MCP 配置加载**：修改 `mcp_loader.py` 的 `_get_mcp_config()`，优先从 `agent_mcp_configs` 读取专家级配置，fallback 到 `mcp_installations` 用户级配置。

---

## 四、前端页面设计

### 4.1 路由

> 文件：`web/frontend/src/router/index.ts`

```typescript
{
  path: 'experts',
  name: 'experts',
  component: () => import('@/views/ExpertView.vue'),
  meta: { title: '专家' },
},
```

### 4.2 页面布局

> 文件：`web/frontend/src/views/ExpertView.vue`

采用与桌面版 ExpertPage 对齐的卡片网格布局，增加 Web 管理能力。

```
+-----------------------------------------------------------+
|  专家                                    [搜索框] [同步]      |  <- 顶栏
+-----------------------------------------------------------+
|  精选场景                                                  |
|  +---------+ +---------+ +---------+ +---------+           |
|  |内容创作  | |投资分析  | |法律财税  | |小微企业  |           |
|  |* 专家A   | |* 专家D  | |* 专家B  | |* 专家F  |           |
|  +---------+ +---------+ +---------+ +---------+           |
+-----------------------------------------------------------+
|  专家 - 专家园              [综合] [评分]  [+ 新建]          |
|  [全部] [内容创作] [法律财税] [技术研发] [产品设计] ...      |  <- 分类筛选
|                                                            |
|  +----------+ +----------+ +----------+ +----------+      |
|  | [头像]    | | [头像]    | | [头像]    | | [头像]    |      |
|  | 名称 头衔 | | 名称 头衔 | | 名称 头衔 | | 名称 头衔 |      |
|  | [标签]    | | [标签]    | | [标签]    | | [标签]    |      |
|  | 描述...   | | 描述...   | | 描述...   | | 描述...   |      |
|  | 4.9 2.1k | | 4.8 1.7k | | 4.9 3.4k | | 4.7 980  |      |
|  | [编辑][删]| | [编辑][删]| | [编辑][删]| | [编辑][删]|      |
|  +----------+ +----------+ +----------+ +----------+      |
|                                                            |
|  <- 1 2 3 ... ->                                           |  <- 分页
+-----------------------------------------------------------+
```

#### 4.2.1 组件拆分

| 组件 | 文件 | 说明 |
|------|------|------|
| ExpertView | views/ExpertView.vue | 页面主体（顶栏、精选场景、列表、分页） |
| ExpertCard | components/expert/ExpertCard.vue | 单个专家卡片 |
| ExpertEditDialog | components/expert/ExpertEditDialog.vue | 编辑抽屉（含 Tab 配置） |
| ExpertFormBasic | components/expert/ExpertFormBasic.vue | 基本信息表单 Tab |
| ExpertConfigPanel | components/expert/ExpertConfigPanel.vue | 配置面板 Tab |
| ToolMultiSelect | components/expert/ToolMultiSelect.vue | 工具多选（内置 + MCP） |
| SkillMultiSelect | components/expert/SkillMultiSelect.vue | 技能多选 |
| McpConfigPanel | components/expert/McpConfigPanel.vue | MCP 配置面板 |

### 4.3 专家编辑抽屉（Tab 式）

采用 Element Plus `el-drawer` 全屏右侧抽屉，内含 5 个 Tab：

- **基本信息**：名称、头衔、分类、标签、图标、头像渐变色、头像文字、描述、精选、场景、排序、发布状态
- **模型与提示词**：提供商下拉、模型下拉、系统提示词编辑器、记忆文件管理
- **工具**：内置工具勾选 + MCP 工具勾选（复用现有 ToolSelectDialog 逻辑）
- **技能**：已选技能列表 + 添加技能（复用现有 SkillSelectDialog 逻辑）
- **MCP**：MCP 工具配置面板（选择 MCP 工具 + 编辑运行参数 command/args/env）

保存时一次性提交 `PUT /api/experts/{id}/config` + `PUT /api/experts/{id}/profile`。

### 4.4 前端 Store

> 文件：`web/frontend/src/stores/expert.ts`

```typescript
export const useExpertStore = defineStore('expert', () => {
  const experts = ref<ExpertInfo[]>([])
  const total = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const searchQuery = ref('')
  const categoryFilter = ref<string | null>(null)
  const sortBy = ref<'rating' | 'usage' | 'recent' | 'name'>('rating')
  const page = ref(1)
  const pageSize = ref(20)
  const featuredScenes = ref<FeaturedScene[]>([])

  async function fetchExperts() { ... }
  async function fetchFeatured() { ... }
  async function fetchCategories() { ... }
  async function getExpert(id: string) { ... }
  async function createExpert(data: ExpertCreateRequest) { ... }
  async function updateExpert(id: string, data: ExpertUpdateRequest) { ... }
  async function updateExpertProfile(id: string, data: ExpertProfileUpdateRequest) { ... }
  async function updateExpertConfig(id: string, data: ExpertConfigUpdateRequest) { ... }
  async function deleteExpert(id: string) { ... }
  async function toggleStatus(id: string) { ... }
  async function cloneExpert(id: string) { ... }

  return { ... }
})
```

### 4.5 前端 API Service

> 文件：`web/frontend/src/services/expertApi.ts`

```typescript
import request from '@/services/request'
import type { Expert, ExpertCreateRequest, ... } from '@/types/expert'

export async function fetchExperts(params: ExpertListParams): Promise<ExpertListResponse> {
  const res = await request.get('/experts', { params })
  return res.data.data
}

export async function getExpert(id: string): Promise<Expert> {
  const res = await request.get(`/experts/${id}`)
  return toExpert(res.data.data)
}

export async function createExpert(data: ExpertCreateRequest): Promise<Expert> {
  const res = await request.post('/experts', toSnakeCase(data))
  return toExpert(res.data.data)
}

export async function updateExpertConfig(id: string, data: ExpertConfigUpdateRequest): Promise<Expert> {
  const res = await request.put(`/experts/${id}/config`, toSnakeCase(data))
  return toExpert(res.data.data)
}

export async function deleteExpert(id: string): Promise<void> {
  await request.delete(`/experts/${id}`)
}
```

### 4.6 前端类型定义

> 文件：`web/frontend/src/types/expert.ts`

```typescript
export interface Expert {
  id: string
  name: string
  title: string
  description: string
  category: string
  tags: string[]
  icon: string
  color: string
  initials: string
  avatarUrl?: string
  rating: number
  usageCount: number
  featured: boolean
  scene?: string
  sortOrder: number
  isPublished: boolean
  status: 'active' | 'inactive' | 'error'
  systemPrompt: string
  providerId?: string
  modelId?: string
  tools: ToolBrief[]
  skills: SkillBrief[]
  mcpConfigs: McpConfigBrief[]
  files: string[]
  createdAt: string
  updatedAt: string
}
```

### 4.7 侧边菜单集成

现有侧边菜单通过权限系统动态加载（`permission.ts` 的 `menuGroups`）。需在数据库菜单种子中加入「专家」菜单项，挂在「智能体」目录下。前端 `SideMenu.vue` 已支持动态渲染，无需修改。

---

## 五、桌面端/移动端同步设计

### 5.1 桌面端同步服务

> 文件：`desktop/src/main/experts/ExpertSyncService.ts`

参照现有 `SkillSyncService` 实现，复用 OAuth2ClientService：

```typescript
export class ExpertSyncService {
  private readonly http: AxiosInstance
  private readonly oauth2: OAuth2ClientService

  constructor(deps: ExpertSyncServiceDeps) {
    this.oauth2 = new OAuth2ClientService({
      secureStorage: deps.secureStorage,
      openExternal: deps.openExternal,
      apiBaseUrl: deps.apiBaseUrl,
      clientId: deps.clientId || 'ke-work-desktop',
    })
    this.http = axios.create({ baseURL: deps.apiBaseUrl, timeout: 15_000 })
  }

  async authorize(localUserId: string): Promise<{ webUser: WebUser | null }> {
    const token = await this.oauth2.authorize('expert:read')
    this.oauth2.saveToken(this.tokenKey(localUserId), token)
    return { webUser: token.webUser }
  }

  async sync(localUserId: string): Promise<{ experts: DesktopExpert[]; syncedAt: number }> {
    const accessToken = await this.oauth2.ensureValidAccessToken(this.tokenKey(localUserId))
    const data = await this.request<ExpertSyncListData>('get', '/api/expert-sync/list', undefined, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    return { experts: data.items.map(mapExpert), syncedAt: data.synced_at }
  }

  // getCachedExperts(), disconnect(), getStatus() 同 SkillSyncService
}

function mapExpert(item: ExpertSyncItem): DesktopExpert {
  return {
    id: item.id,          // number -> string (对齐 Web UUID)
    name: item.name,
    title: item.title,
    tags: item.tags,
    desc: item.desc,
    color: item.color,
    initials: item.initials,
    category: item.category,
    rating: item.rating,
    users: item.users,
    systemPrompt: item.system_prompt,
    icon: item.icon,
    scene: item.scene,
  }
}
```

### 5.2 桌面端 catalog store 改造

> 文件：`desktop/src/renderer/src/store/catalog.ts`

```typescript
// 1. Expert 接口调整
export interface Expert {
  id: string              // number -> string
  name: string
  title: string
  tags: string[]
  desc: string
  color: string
  initials: string
  category: string
  rating: number
  users: string
  systemPrompt?: string   // 新增：召唤时注入的提示词
  icon?: string
  scene?: string
}

// 2. experts 从硬编码数组改为 ref
export const experts = ref<Expert[]>([])

// 3. 新增 setExperts 方法
function setExperts(items: Expert[]): void {
  experts.value = items
}

// 4. buildExpertPrompt 使用 systemPrompt
function buildExpertPrompt(expert: Expert): string {
  if (expert.systemPrompt) return expert.systemPrompt
  return `请以【${expert.name}·${expert.title}】的身份协助我完成以下任务：`
}
```

### 5.3 桌面端 ExpertPage 改造

> 文件：`desktop/src/renderer/src/views/ExpertPage.vue`

- `experts` 从 `import { experts }` 改为 `storeToRefs(catalog)` 获取响应式引用
- 「同步专家」按钮调用 `ExpertSyncService.sync()`，成功后 `catalog.setExperts(items)`
- 未同步时展示空状态引导
- `summonExpert` 的 ID 类型从 number 改为 string

### 5.4 移动版同步

移动版使用 `workmate-mobile` OAuth2 客户端（已配置 `expert:read` scope，redirect URI 为 `workmate://oauth/callback`），同步逻辑与桌面版一致。

---

## 六、MCP 配置加载改造

### 6.1 修改 mcp_loader.py

> 文件：`web/backend/src/agent/tools/mcp_loader.py`

`_get_mcp_config()` 增加专家级配置查询优先级：

```python
async def _get_mcp_config(
    db: AsyncSession,
    mcp_tool_name: str,
    agent_id: str | None = None,
    user_id: str | None = None,
) -> dict[str, Any]:
    """获取 MCP 配置：优先专家级 > 用户级 > 默认空"""
    # 1. 优先从 agent_mcp_configs 读取专家级配置
    if agent_id is not None:
        from db.models.agent_mcp_config import AgentMcpConfig
        mcp_tool = (await db.execute(
            select(McpTool).where(McpTool.name == mcp_tool_name)
        )).scalar_one_or_none()
        if mcp_tool is not None:
            agent_config = (await db.execute(
                select(AgentMcpConfig).where(
                    AgentMcpConfig.agent_id == agent_id,
                    AgentMcpConfig.mcp_tool_id == mcp_tool.id,
                    AgentMcpConfig.enabled == True,
                )
            )).scalar_one_or_none()
            if agent_config is not None:
                return agent_config.config

    # 2. Fallback 到用户级配置
    if user_id is None:
        return {}
    # ... 原有 mcp_installations 逻辑不变
```

### 6.2 修改 load_mcp_tools_for_agent

传递 `agent_id` 给 `_get_mcp_config()`：

```python
config = await _get_mcp_config(db, mcp_name, agent_id=agent_id, user_id=user_id)
```

---

## 七、数据流与时序

### 7.1 创建专家

```
Web 前端                Web 后端                    数据库
   |                       |                          |
   |-- POST /api/experts ->|                          |
   |                       |-- 查询主智能体 ID ------>|
   |                       |-- INSERT agents (sub)     |
   |                       |-- INSERT expert_profiles  |
   |                       |-- INSERT agent_tools      |
   |                       |-- INSERT agent_skills     |
   |                       |-- INSERT agent_mcp_configs|
   |                       |-- INSERT agent_versions   |
   |                       |-- invalidate_graph()      |
   |                       |<--------------------------|
   |<-- 200 ExpertInfo ----|                          |
```

### 7.2 桌面端同步专家

```
桌面端 ExpertSyncService     Web 后端                   数据库
        |                       |                        |
        |-- OAuth2 授权 ------->|                        |
        |  (expert:read scope)   |                        |
        |<-- access_token -------|                        |
        |                       |                        |
        |-- GET /expert-sync/list ->|                    |
        |  Authorization: Bearer  |-- 校验 scope          |
        |                       |-- 查询已发布专家 ----->|
        |                       |-- JOIN expert_profiles |
        |                       |-- 格式化 usage_count    |
        |<-- ExpertSyncList -----|                        |
        |                       |                        |
        |-- catalog.setExperts() |                        |
        +-- ExpertPage 响应更新  |                        |
```

### 7.3 专家在对话中的使用（召唤）

```
桌面端                      Web 后端                    DeepAgent Graph
  |                           |                          |
  |-- catalog.setExpert(id)   |                          |
  |-- 输入框注入 systemPrompt  |                          |
  |-- 发送消息 -------------->|                          |
  |                           |-- 加载 LangGraph ------->|
  |                           |   (create_subagents()    |
  |                           |    读取 type=sub+active   |
  |                           |    的所有专家)            |
  |                           |                          |
  |                           |<-- 流式回复 -------------|
  |<-- SSE 事件流 -------------|                          |
```

---

## 八、实现步骤

### 阶段一：后端数据模型与 API（核心）

| # | 文件 | 说明 |
|---|------|------|
| 1 | db/models/expert_profile.py | 新建 ExpertProfile 模型 |
| 2 | db/models/agent_mcp_config.py | 新建 AgentMcpConfig 模型 |
| 3 | db/models/__init__.py | 注册新模型 |
| 4 | api/experts/__init__.py | 新建模块，定义 router |
| 5 | api/experts/schemas.py | 定义所有 Pydantic schema |
| 6 | api/experts/service.py | 实现专家 CRUD、配置更新、克隆等 |
| 7 | api/experts/experts_api.py | 定义专家管理 API 端点 |
| 8 | api/experts/sync_api.py | 定义同步 API 端点（OAuth2 scope） |
| 9 | api/__init__.py | 注册 experts_router + expert_sync_router |
| 10 | agent/tools/mcp_loader.py | 改造 MCP 配置加载优先级 |
| 11 | db/seeds/oauth2_clients_seed.json | 添加 expert:read scope |
| 12 | db/seeds/expert_categories_seed.json | 预置专家分类（可选） |

### 阶段二：前端页面与组件

| # | 文件 | 说明 |
|---|------|------|
| 13 | types/expert.ts | 定义前端类型 |
| 14 | services/expertApi.ts | 实现 API 调用层 |
| 15 | stores/expert.ts | 实现 Pinia store |
| 16 | views/ExpertView.vue | 主页面 |
| 17 | components/expert/ExpertCard.vue | 专家卡片组件 |
| 18 | components/expert/ExpertEditDialog.vue | 编辑抽屉 |
| 19 | components/expert/ExpertFormBasic.vue | 基本信息表单 |
| 20 | components/expert/ExpertConfigPanel.vue | 配置面板 |
| 21 | components/expert/ToolMultiSelect.vue | 工具多选组件 |
| 22 | components/expert/SkillMultiSelect.vue | 技能多选组件 |
| 23 | components/expert/McpConfigPanel.vue | MCP 配置面板 |
| 24 | router/index.ts | 添加 /experts 路由 |
| 25 | 菜单种子/SQL | 在智能体目录下添加专家菜单 |

### 阶段三：桌面端同步改造

| # | 文件 | 说明 |
|---|------|------|
| 26 | desktop/src/main/experts/ExpertSyncService.ts | 新建同步服务 |
| 27 | desktop/src/renderer/src/store/catalog.ts | 改造 experts 为 ref + setExperts |
| 28 | desktop/src/renderer/src/views/ExpertPage.vue | 对接同步 + ID 类型适配 |
| 29 | desktop/src/preload/index.d.ts | 更新 Expert 类型定义 |
| 30 | desktop/src/main/index.ts | 注册 ExpertSyncService |

### 阶段四：测试与验证

| # | 说明 |
|---|------|
| 31 | 后端单元测试：专家 CRUD、配置更新、版本快照、MCP 配置加载 |
| 32 | 后端集成测试：同步 API + OAuth2 scope 校验 |
| 33 | 前端组件测试：ExpertView 渲染、ExpertEditDialog 表单提交 |
| 34 | 端到端验证：Web 创建专家 - 桌面端同步 - 召唤专家 - 对话注入 |

---

## 九、注意事项与风险

1. **Agent ID 类型迁移**：桌面版现有 Expert.id 为 number，Web 使用 UUID string。需统一为 string，涉及桌面版 catalog store + ExpertPage + localStorage 持久化格式变更，需做向前兼容。

2. **主智能体依赖**：创建专家需要 parent_id 指向主智能体。如果系统中尚无主智能体（首次使用），现有 `list_agents()` 已有自动创建主智能体的逻辑。

3. **Store 文件同步**：专家的记忆文件（AGENTS.md / SOUL.md 等）存储在 LangGraph Store 中。同步 API 目前只返回文件名列表，不返回文件内容。如桌面端需要文件内容，可后续扩展 `/api/expert-sync/{id}/files/{filename}` 端点。

4. **MCP 配置安全**：`agent_mcp_configs.config` 可能包含 API Key 等敏感信息。同步 API 返回时应脱敏，桌面端如需实际配置应走单独的认证流程。

5. **并发修改**：多人同时编辑同一专家时，通过 `agent_versions` 版本快照保证可追溯。乐观锁（updated_at 比对）可作为后续增强。

6. **与现有 AgentsView 的关系**：专家在 agents 表中是 type='sub' 的记录，会出现在 AgentsView 的子智能体列表中。两者管理视角不同但数据同源：AgentsView 管理智能体层级结构，ExpertView 管理专家的展示与分类。建议在 AgentsView 中对有 expert_profile 的子智能体标记「专家」标签。

---

## 十、API 完整清单汇总

### 专家管理 API（/api/experts）

| # | 方法 | 路径 | 说明 |
|---|------|------|------|
| 1 | GET | /api/experts | 分页列表 |
| 2 | GET | /api/experts/categories | 分类列表 |
| 3 | GET | /api/experts/featured | 精选场景 |
| 4 | GET | /api/experts/{id} | 专家详情 |
| 5 | POST | /api/experts | 创建专家 |
| 6 | PUT | /api/experts/{id} | 更新基础信息 |
| 7 | PUT | /api/experts/{id}/profile | 更新展示元数据 |
| 8 | PUT | /api/experts/{id}/config | 批量更新配置 |
| 9 | DELETE | /api/experts/{id} | 删除专家 |
| 10 | PATCH | /api/experts/{id}/status | 切换状态 |
| 11 | POST | /api/experts/{id}/clone | 克隆专家 |
| 12 | GET | /api/experts/{id}/mcp-configs | MCP 配置列表 |
| 13 | PUT | /api/experts/{id}/mcp-configs/{mcp_tool_id} | 更新 MCP 配置 |
| 14 | DELETE | /api/experts/{id}/mcp-configs/{mcp_tool_id} | 删除 MCP 配置 |

### 同步 API（/api/expert-sync）

| # | 方法 | 路径 | 说明 |
|---|------|------|------|
| 15 | GET | /api/expert-sync/list | 同步专家列表 |
| 16 | GET | /api/expert-sync/{id} | 同步专家详情 |
| 17 | GET | /api/expert-sync/featured | 同步精选场景 |

---

*本文档随实现进展持续更新。*
