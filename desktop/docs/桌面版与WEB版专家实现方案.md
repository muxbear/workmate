# 桌面版与 WEB 版专家实现方案

> 本文档基于 DeepAgents 官方文档（子智能体、动态子智能体、异步子智能体、解释器、配置 / Profiles）以及 WorkMate 现有代码结构，对"专家"功能在桌面版与 Web 版之间的数据存储、同步、分配与全生命周期管理进行完整规划。

---

## 一、整体架构与数据流

```
┌─────────────────────────────────────────────────────────┐
│                    Web 版（数据权威源）                    │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ Agents   │───▶│ Agent 表     │    │ Expert       │  │
│  │ 管理页面  │    │ (expert_     │    │ Profile JSON │  │
│  │ (CRUD)   │    │  profile列)  │    │              │  │
│  └──────────┘    └──────┬───────┘    └──────────────┘  │
│                         │                                │
│           ┌─────────────┼─────────────┐                  │
│           ▼             ▼             ▼                  │
│     /api/agents    /api/experts   OAuth2 Scope          │
│    (现有CRUD)     (新增只读)     expert:read             │
└─────────────────────┬───────────────────────────────────┘
                      │ OAuth2 Bearer Token
                      ▼
┌─────────────────────────────────────────────────────────┐
│                  桌面版（消费方 + 子智能体宿主）            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ ExpertSync   │─▶│ Expert Store  │─▶│ ExpertPage   │  │
│  │ Service      │  │ (Pinia)       │  │ (展示/选择)   │  │
│  └──────────────┘  └──────┬───────┘  └──────────────┘  │
│                           │                              │
│                    ┌──────▼───────┐                      │
│                    │ NewTaskPage  │                      │
│                    │ (输入框选专家) │                      │
│                    └──────┬───────┘                      │
│                           │ 用户提交问题                  │
│                    ┌──────▼───────┐                      │
│                    │ AgentManager │                      │
│                    │ .setSubagents│                      │
│                    │ →主智能体    │                      │
│                    └──────────────┘                      │
└─────────────────────────────────────────────────────────┘
```

专家数据流经四层：Web 数据库存储 → REST API → 桌面版同步服务 → Pinia Store → AgentManager 子智能体配置。

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
- 专家本质就是一组"角色 Profile"：名称、领域描述、系统提示词、推荐工具、推荐模型。Web 版存储的 `expert_profile` JSON 列即为 Profile 序列化。
- 桌面版同步专家后，将 `expert_profile` 转换为 DeepAgents 的 `SubAgent` 配置传入 `AgentBuilder.setSubagents()`。

---

## 三、Web 后端：专家数据存储与 API 扩展（需求 3）

### 3.1 存储方案：扩展 Agent 表

专家在 Web 版中本质是"带有专家元数据的子智能体"，因此复用现有 `agents` 表，新增 `expert_profile` JSON 列存储专家专有配置。

**文件：`web/backend/src/db/models/agent.py`**

```python
# 在现有 Agent 类中新增字段
class Agent(Base):
    # ... 现有字段保持不变 ...

    expert_profile: Mapped[dict | None] = mapped_column(
        JSON, nullable=True, default=None,
        comment="专家扩展配置 Profile（仅 type=sub 的专家智能体使用，普通子智能体为 NULL）"
    )
```

`expert_profile` JSON 结构定义：

```json
{
  "title": "内容创作专家",
  "category": "AI工具专家",
  "tags": ["小红书", "品牌文案"],
  "icon": "Zap",
  "color": "linear-gradient(135deg,#f59e0b,#d97706)",
  "rating": 4.9,
  "users": "2.1k",
  "recommended_tools": ["http_request", "tavily_search"],
  "recommended_model": "deepseek:deepseek-v4-pro",
  "prompt_template": "请以【{name}·{title}】的身份协助我完成以下任务：",
  "is_expert": true,
  "expertise_areas": ["小红书种草内容", "品牌故事撰写"]
}
```

> 设计理由：专家区别于普通子智能体的核心是"面向用户展示的元数据"（标题、分类、标签、图标、评分等）。这些字段不属于 DeepAgents SubAgent 原生结构，因此用独立的 `expert_profile` JSON 列承载，与 Agent 表的 `system_prompt`、`tools`（通过 AgentTool 关联表）、`model` 等子智能体核心配置正交，互不干扰。

### 3.2 数据库迁移

**文件：`web/backend/src/db/utils.py`**（或 Alembic 迁移脚本）

```python
# 迁移 SQL（SQLite ALTER TABLE）
ALTER TABLE agents ADD COLUMN expert_profile TEXT DEFAULT NULL;
```

对 PostgreSQL 同理使用 `JSON` 类型列。迁移在应用启动时自动执行（现有 `SqlMigrationRunner` 模式）。

### 3.3 Schema 扩展

**文件：`web/backend/src/api/agents/schemas.py`**

```python
class ExpertProfile(BaseModel):
    """专家扩展配置（Profile）。"""
    title: str = ""
    category: str = ""
    tags: list[str] = []
    icon: str = "Zap"
    color: str = ""
    rating: float = 0.0
    users: str = ""
    recommended_tools: list[str] = []
    recommended_model: str | None = None
    prompt_template: str = ""
    is_expert: bool = True
    expertise_areas: list[str] = []


# 扩展现有 AgentCreateRequest
class AgentCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    description: str = ""
    system_prompt: str = ""
    parent_id: str | None = None
    provider_id: str | None = None
    model_id: str | None = None
    expert_profile: ExpertProfile | None = None  # 新增


# 扩展现有 AgentUpdateRequest
class AgentUpdateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    description: str = ""
    system_prompt: str = ""
    provider_id: str | None = None
    model_id: str | None = None
    expert_profile: ExpertProfile | None = None  # 新增


# 扩展现有 AgentInfo（响应）
class AgentInfo(BaseModel):
    # ... 现有字段 ...
    expert_profile: ExpertProfile | None = None  # 新增


# 新增：专家列表专用响应（轻量，不含 files / tools 细节）
class ExpertListItem(BaseModel):
    """专家列表项（桌面版同步拉取用）。"""
    id: str
    name: str
    description: str
    system_prompt: str
    status: str
    provider_id: str | None = None
    model_id: str | None = None
    tools: list[str] = []
    expert_profile: ExpertProfile

    class Config:
        from_attributes = True


class ExpertListResponse(BaseModel):
    """专家列表响应。"""
    experts: list[ExpertListItem]
```

### 3.4 Service 层扩展

**文件：`web/backend/src/api/agents/service.py`**

在现有 `_agent_to_info()` 中补充 `expert_profile` 字段：

```python
async def _agent_to_info(db, agent, sub_agent_ids=None, skills=None, tool_names=None):
    # ... 现有逻辑 ...
    return AgentInfo(
        # ... 现有字段 ...
        expert_profile=agent.expert_profile,  # 新增
    )
```

在 `create_agent()` 和 `update_agent()` 中持久化 `expert_profile`：

```python
async def create_agent(db, req: AgentCreateRequest) -> AgentInfo:
    agent = Agent(
        # ... 现有字段 ...
        expert_profile=req.expert_profile.model_dump() if req.expert_profile else None,
    )
    # ... 其余逻辑不变 ...


async def update_agent(db, agent_id, req: AgentUpdateRequest) -> AgentInfo:
    agent.name = req.name
    # ... 现有字段 ...
    agent.expert_profile = req.expert_profile.model_dump() if req.expert_profile else None
    # ... 其余逻辑不变 ...
```

新增专家列表查询函数（专供桌面版同步拉取）：

```python
async def list_experts(db: AsyncSession) -> ExpertListResponse:
    """查询所有带 expert_profile 的活跃子智能体（即"专家"）。"""
    stmt = (
        select(Agent)
        .where(Agent.type == "sub", Agent.status == "active")
        .where(Agent.expert_profile.isnot(None))
        .order_by(Agent.created_at)
    )
    rows = (await db.execute(stmt)).scalars().all()

    experts = []
    for agent in rows:
        tool_names = await _get_agent_tool_names(db, agent.id)
        profile_data = agent.expert_profile or {}
        experts.append(ExpertListItem(
            id=agent.id,
            name=agent.name,
            description=agent.description or "",
            system_prompt=agent.system_prompt or "",
            status=agent.status,
            provider_id=agent.provider_id,
            model_id=agent.model_id,
            tools=tool_names,
            expert_profile=ExpertProfile(**profile_data) if profile_data else ExpertProfile(),
        ))
    return ExpertListResponse(experts=experts)
```

### 3.5 专家只读 API（供桌面版拉取）

**文件：`web/backend/src/api/agents/agents_api.py`**

```python
@router.get("/experts/list", response_model=ApiResponse[ExpertListResponse])
@handle_errors
async def expert_list(db: AsyncSession = Depends(get_db)):
    """获取所有专家列表（桌面版同步拉取专用，只含 expert_profile 非空的活跃子智能体）。"""
    result = await list_experts(db)
    return ok(result)
```

> 注意：该接口与现有 `GET /api/agents` 不同——后者返回全部智能体含文件、技能等完整信息，数据量大；`/api/agents/experts/list` 只返回专家轻量信息，专供桌面版同步。

### 3.6 专家管理复用现有 Agent CRUD

Web 版对专家的管理（配置、删除、修改、查询）全部复用现有 `/api/agents` 接口：

| 操作 | 现有接口 | 说明 |
|------|---------|------|
| 创建专家 | `POST /api/agents` | 传 `parent_id`（主智能体 ID）+ `expert_profile` |
| 查询专家 | `GET /api/agents/{id}` | 返回含 `expert_profile` 的完整信息 |
| 查询列表 | `GET /api/agents` | 前端过滤 `expert_profile != null` 的子智能体 |
| 修改专家 | `PUT /api/agents/{id}` | 更新名称、描述、提示词、`expert_profile` |
| 删除专家 | `DELETE /api/agents/{id}` | 级联删除关联的工具、技能 |
| 状态切换 | `PATCH /api/agents/{id}/status` | 启用 / 停用专家（影响桌面版是否同步） |
| 配置工具 | `POST /api/agents/{id}/config` | `type=tool`，为专家添加工具 |
| 配置文件 | `POST /api/agents/{id}/config` | `type=file`，为专家添加记忆文件 |
| 配置技能 | `POST /api/agents/{id}/skills` | 为专家关联技能包 |

不需要额外新增管理端接口，只需在 Web 前端页面做专家专属的 UI 呈现。

---

## 四、Web 前端：专家管理页面增强（需求 5）

### 4.1 专家管理入口

在 Web 版主页面左侧菜单"专家"页面中，提供完整的 CRUD 管理能力。

**现有文件：`web/frontend/src/views/AgentsView.vue`**（智能体管理页面）

该页面已实现智能体的列表、创建、编辑、删除、状态切换等管理功能。专家管理复用此页面，扩展以下能力：

### 4.2 专家列表视图

在 `AgentsView.vue` 中新增"专家"筛选标签：

```vue
<!-- 在现有列表筛选区域新增 -->
<el-radio-group v-model="filterType">
  <el-radio-button label="all">全部智能体</el-radio-button>
  <el-radio-button label="expert">专家</el-radio-button>
  <el-radio-button label="sub">普通子智能体</el-radio-button>
</el-radio-group>
```

当 `filterType === 'expert'` 时，前端过滤 `agent.expert_profile != null` 的记录展示。

### 4.3 专家创建 / 编辑表单

在创建 / 编辑弹窗中新增"专家配置"折叠面板：

```vue
<el-collapse v-model="expertCollapse">
  <el-collapse-item title="专家配置" name="expert">
    <el-form-item label="专家标题">
      <el-input v-model="form.expert_profile.title" placeholder="如：内容创作专家" />
    </el-form-item>
    <el-form-item label="专家分类">
      <el-select v-model="form.expert_profile.category">
        <el-option label="AI工具专家" value="AI工具专家" />
        <el-option label="法律财税" value="法律财税" />
        <el-option label="技术研发" value="技术研发" />
        <el-option label="产品设计" value="产品设计" />
        <el-option label="创业投资" value="创业投资" />
        <el-option label="SPC" value="SPC" />
      </el-select>
    </el-form-item>
    <el-form-item label="标签">
      <el-select v-model="form.expert_profile.tags" multiple>
        <!-- 标签输入 -->
      </el-select>
    </el-form-item>
    <el-form-item label="图标颜色">
      <el-color-picker v-model="form.expert_profile.color" />
    </el-form-item>
    <el-form-item label="提示词模板">
      <el-input v-model="form.expert_profile.prompt_template" type="textarea"
        placeholder="请以【{name}·{title}】的身份协助我完成以下任务：" />
    </el-form-item>
    <el-form-item label="专长领域">
      <el-select v-model="form.expert_profile.expertise_areas" multiple>
        <!-- 领域输入 -->
      </el-select>
    </el-form-item>
  </el-collapse-item>
</el-collapse>
```

### 4.4 专家详情页

点击专家卡片进入详情页，展示：

- 基本信息：名称、标题、分类、描述
- 系统提示词（可编辑）
- 已配置工具列表（添加 / 移除）
- 已关联技能列表（添加 / 移除）
- 记忆文件列表（AGENTS.md / SOUL.md 等，可编辑）
- 专家 Profile 配置（评分、使用量、标签等）

### 4.5 Web 前端 Store

**文件：`web/frontend/src/stores/`** （新增 `expert.ts` 或扩展现有 agent store）

```typescript
// web/frontend/src/stores/expert.ts
export const useExpertStore = defineStore('expert', () => {
  const experts = ref<AgentInfo[]>([])
  const loading = ref(false)

  async function fetchExperts() {
    loading.value = true
    const res = await api.get('/api/agents')
    experts.value = res.data.data.agents.filter(
      (a: AgentInfo) => a.type === 'sub' && a.expert_profile
    )
    loading.value = false
  }

  async function createExpert(payload: AgentCreateRequest) {
    const res = await api.post('/api/agents', {
      ...payload,
      parent_id: mainAgentId, // 绑定到主智能体
      expert_profile: payload.expert_profile,
    })
    await fetchExperts()
    return res.data.data
  }

  async function updateExpert(id: string, payload: AgentUpdateRequest) {
    await api.put(`/api/agents/${id}`, payload)
    await fetchExperts()
  }

  async function deleteExpert(id: string) {
    await api.delete(`/api/agents/${id}`)
    await fetchExperts()
  }

  async function toggleExpertStatus(id: string) {
    await api.patch(`/api/agents/${id}/status`)
    await fetchExperts()
  }

  return { experts, loading, fetchExperts, createExpert, updateExpert, deleteExpert, toggleExpertStatus }
})
```

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

interface WebExpertInfo {
  id: string
  name: string
  description: string
  system_prompt: string
  status: string
  provider_id: string | null
  model_id: string | null
  tools: string[]
  expert_profile: {
    title: string
    category: string
    tags: string[]
    icon: string
    color: string
    rating: number
    users: string
    recommended_tools: string[]
    recommended_model: string | null
    prompt_template: string
    is_expert: boolean
    expertise_areas: string[]
  }
}

interface ExpertListData {
  experts: WebExpertInfo[]
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
function mapExpert(item: WebExpertInfo): DesktopExpert {
  const ep = item.expert_profile
  return {
    id: item.id,
    name: item.name,
    title: ep.title || item.description,
    tags: ep.tags,
    desc: item.description,
    color: ep.color || 'linear-gradient(135deg,#0891b2,#0e7490)',
    icon: ep.icon || 'Zap',
    category: ep.category,
    rating: ep.rating,
    users: ep.users,
    initials: item.name.charAt(0),
    // 子智能体配置所需字段
    systemPrompt: item.system_prompt,
    tools: item.tools,
    providerId: item.provider_id,
    modelId: item.model_id,
    promptTemplate: ep.prompt_template,
    expertiseAreas: ep.expertise_areas,
    isExpert: ep.is_expert,
  }
}

/**
 * 专家同步服务：从 Web 版拉取专家数据
 *
 * 复用 SkillSyncService 的 OAuth2 授权流程（共享 token 或独立 token），
 * 通过 expert:read scope 调用 /api/agents/experts/list 拉取专家列表。
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
    const data = await this.request<ExpertListData>('get', '/api/agents/experts/list', undefined, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    this.cachedExperts = data.experts.map(mapExpert)
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

## 八、OAuth2 Scope 扩展

### 8.1 新增 expert:read scope

**文件：`web/backend/src/api/oauth2/scope_service.py`**

```python
SCOPE_LABELS: dict[str, str] = {
    "skill:read": "读取并同步技能列表",
    "skill:write": "创建、修改、删除技能",
    "user:read": "读取用户资料（昵称、头像）",
    "agent:read": "读取智能体配置",
    "expert:read": "读取并同步专家列表",  # 新增
    "agent:write": "修改智能体配置",
    "conversation:read": "读取会话",
    "conversation:write": "创建和修改会话",
    "workspace:read": "读取工作区",
}
```

### 8.2 OAuth2 客户端配置

在 `oauth2_clients_seed.json` 中，`ke-work-desktop` 客户端的 `allowed_scopes` 新增 `expert:read`：

```json
{
  "client_id": "ke-work-desktop",
  "allowed_scopes": [
    "skill:read",
    "user:read",
    "expert:read"
  ]
}
```

### 8.3 授权端点 scope 校验

现有 `authorize` 端点已通过 `validate_scope_subset()` 校验请求 scope 是否在客户端允许列表中。新增 `expert:read` 后，桌面版 `ExpertSyncService.authorize()` 请求 `expert:read` scope 即可通过校验。

### 8.4 专家接口鉴权

`GET /api/agents/experts/list` 端点需要 `expert:read` scope 校验：

```python
@router.get("/experts/list", response_model=ApiResponse[ExpertListResponse])
@handle_errors
async def expert_list(
    db: AsyncSession = Depends(get_db),
    token_data: TokenData = Depends(require_scope("expert:read")),  # 新增 scope 校验
):
    result = await list_experts(db)
    return ok(result)
```

> `require_scope` 依赖从现有 OAuth2 中间件中复用，校验 access_token 的 scope 声明中包含 `expert:read`。

---

## 九、测试方案

### 9.1 Web 后端测试

| 测试项 | 方法 | 预期 |
|--------|------|------|
| Agent 表新增 expert_profile 列 | 迁移后查询表结构 | 列存在且类型为 JSON/TEXT |
| 创建带 expert_profile 的子智能体 | POST /api/agents 带 expert_profile | 返回 AgentInfo 含 expert_profile |
| 查询专家列表 | GET /api/agents/experts/list | 只返回 expert_profile 非空的活跃子智能体 |
| 更新专家 expert_profile | PUT /api/agents/{id} | expert_profile 字段更新 |
| 删除专家 | DELETE /api/agents/{id} | 级联删除关联记录 |
| expert:read scope 校验 | 无 token / 无效 scope 请求 | 返回 401/403 |
| 子智能体构建 | create_subagents() | 包含 expert_profile 非空的子智能体 |

### 9.2 Web 前端测试

| 测试项 | 方法 | 预期 |
|--------|------|------|
| 专家筛选 | 切换 filterType 为 'expert' | 只显示 expert_profile 非空的智能体 |
| 创建专家表单 | 填写专家配置后提交 | 成功创建，列表刷新 |
| 编辑专家 | 修改 expert_profile 字段 | 更新成功 |
| 删除专家 | 点击删除 | 确认后删除，列表刷新 |

### 9.3 桌面版测试

| 测试项 | 方法 | 预期 |
|--------|------|------|
| 专家同步授权 | 点击"同步专家"→ 浏览器授权 | 返回 authorized 状态 |
| 专家同步拉取 | sync() | 返回 DesktopExpert 列表 |
| 专家页面展示 | ExpertPage.vue | 展示同步的专家卡片 |
| 专家搜索 / 筛选 | 输入关键词 / 切换分类 | 过滤结果正确 |
| 选中专家 → 输入框 | NewTaskPage 点专家召唤 | 提示词插入输入框开头 |
| 专家 → 子智能体注入 | setExperts() | AgentBuilder.subagents 非空 |
| 提交问题 → 任务分配 | 发送消息 | 主智能体将子任务委派给专家子智能体 |
| 离线缓存 | 断网后打开 ExpertPage | 显示上次同步的缓存数据 |

---

## 十、实施步骤与优先级

| 阶段 | 任务 | 优先级 | 依赖 |
|------|------|--------|------|
| P0 | Web 后端：Agent 表新增 expert_profile 列 + 迁移 | 高 | 无 |
| P0 | Web 后端：Schema / Service 扩展 expert_profile | 高 | P0 迁移 |
| P0 | Web 后端：新增 GET /api/agents/experts/list 端点 | 高 | Schema 扩展 |
| P0 | Web 后端：OAuth2 新增 expert:read scope | 高 | 无 |
| P1 | Web 前端：AgentsView 专家筛选 / 创建 / 编辑表单 | 中 | P0 后端 |
| P1 | Web 前端：Expert store + 专家管理 UI | 中 | P1 前端 |
| P1 | 桌面版：ExpertSyncService + IPC handlers | 中 | P0 后端 API |
| P1 | 桌面版：Preload 类型声明 + IPC 暴露 | 中 | ExpertSyncService |
| P1 | 桌面版：catalog store 改造（静态 → 动态） | 中 | Preload |
| P2 | 桌面版：ExpertPage.vue 改造（同步 / 展示 / 搜索） | 中 | Store |
| P2 | 桌面版：AgentManager.setExperts() + expertToSubAgent() | 中 | Store |
| P2 | 桌面版：NewTaskPage 专家选择 → 子智能体注入 | 中 | AgentManager |
| P3 | 桌面版：专家数据本地 SQLite 缓存 | 低 | ExpertSyncService |
| P3 | 桌面版：动态子智能体 / 异步子智能体集成 | 低 | AgentManager |

---

## 十一、假设与约定

1. 专家在 Web 版中是 `type=sub` 且 `expert_profile IS NOT NULL` 的 Agent 记录，与主智能体（`type=main`）通过 `parent_id` 关联。
2. Web 版专家管理复用现有 `/api/agents` 全套 CRUD，不新建独立专家管理端点（只新增只读列表端点供桌面版同步）。
3. 桌面版专家数据是 Web 版的缓存副本，桌面版不直接修改专家——修改在 Web 版进行，桌面版重新同步。
4. 桌面版 `ExpertSyncService` 复用 `SkillSyncService` 的 OAuth2 授权架构，使用独立 token key 前缀避免冲突。
5. 专家子智能体的工具和模型在桌面版中的解析需要对接本地工具注册表和 `ModelService`，这是后续迭代的接入点。
6. `selectedExpertId` 从 `number` 改为 `string`（Web UUID），需要数据迁移兼容 localStorage 中的旧值。
7. DeepAgents 的 `SubAgent` 接口在 TypeScript npm 包与 Python 包之间结构一致，本方案据此设计跨端对齐的转换逻辑。
8. 动态子智能体和异步子智能体在初始版本中预留接口但不默认启用，待专家功能稳定后按需打开。
