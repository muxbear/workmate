# Ke-Hermes 智能体架构升级优化方案

> 本文档基于对 DeepAgents / LangChain / LangGraph 官方文档的深度学习，结合 WorkMate Web 后端现有代码的逐文件分析，针对智能体存储模型与构建链路中的系统性问题，提出完整的优化升级方案。

---

## 一、现状评估

### 1.1 当前架构概览

```
┌─────────────────────────────────────────────────────────┐
│                      数据库层（关系型 DB）                 │
│                                                         │
│  agents          ── 主智能体 + 子智能体（type 字段区分）     │
│  tools           ── 工具元数据（builtin + third_party）    │
│  skills          ── 技能包元数据                            │
│  mcp_tools       ── MCP 广场目录                           │
│  mcp_installations ── 用户级 MCP 安装记录                  │
│  agent_tools     ── Agent ↔ Tool 多对多关联               │
│  agent_skills    ── Agent ↔ Skill 多对多关联               │
└──────────────────────────────┬──────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │   AgentBuilder 链    │
                    │  (agent_builder.py)  │
                    ├─────────────────────┤
                    │ with_agent_from_db   │ ← DB 查询配置
                    │ with_model           │ ← resolve_model()
                    │ with_tools           │ ← get_tool_registry()  ⚠️ 硬编码
                    │ with_subagents       │ ← create_subagents()    ⚠️ 同样硬编码工具
                    │ with_system_prompt   │
                    │ with_memory         │ ← infer_scope() → Store
                    │ with_sandbox        │
                    │ with_backend        │ ← CompositeBackend
                    │ with_middleware     │ ← SkillSandboxSyncMiddleware
                    │ build()             │ → create_deep_agent()
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   LangGraph Store    │ ← 记忆文件内容
                    │  (InMemoryStore /    │    (AGENTS.md, SOUL.md...)
                    │   AsyncPostgresStore) │
                    └─────────────────────┘
```

### 1.2 合理的设计（保留）

| 设计 | 评价 | 对标 |
|------|------|------|
| Agent 单表 + type=main/sub + parent_id 自引用 | 合理，DeepAgents 主/子智能体本质同构 | Dify / Coze / CrewAI |
| 工具/技能多对多关联表 | 合理，支持跨 Agent 复用与统一管理 | Dify / LangSmith |
| 记忆文件用 LangGraph Store | 优秀，四作用域（AGENT/USER/MIXTURE/ORG）namespace 隔离完全符合 DeepAgents 文档 | LangGraph 官方推荐 |
| CompositeBackend 路由 | 合理，/memories/ → StoreBackend、/skills/ → FilesystemBackend | DeepAgents backend composition |
| 子智能体构建 `create_subagents()` | 基本合理，从 DB 查询 → 组装 dict | DeepAgents subagents 文档 |

### 1.3 存在的系统性问题

**问题总览图：**

```
配置写入 DB ─────────────── 配置读取/构建运行时
    │                              │
    │  ✅ Agent CRUD               │  ✅ AgentBuilder 读取 agent 配置
    │  ✅ Tool CRUD                │  ⚠️ get_tool_registry() 硬编码，不读 DB
    │  ✅ Skill CRUD               │  ✅ skills 通过路径加载
    │  ✅ MCP 广场 CRUD            │  ❌ MCP 工具未接入运行时
    │  ✅ 关联表管理               │  ⚠️ 子智能体工具解析只查硬编码注册表
    │  ✅ 记忆文件写入 Store       │  ⚠️ files 列表与 Store 内容可能漂移
    │                              │
    │                              │  ❌ Agent 单例缓存，配置变更不生效
    │                              │  ❌ 工具定义三处重复
    │                              │  ❌ 无版本管理
    └──────────────────────────────┘
```

**6 个核心问题详细说明：**

---

#### 问题 1：工具注册表硬编码，与 DB 严重脱节

`get_tool_registry()` 只返回 `agent/tools/__init__.py` 中硬编码导入的 5 个工具：

```python
# 当前实现 — agent/common.py
def get_tool_registry() -> dict[str, object]:
    registry: dict[str, object] = {}
    for name in agent_tools.__all__:  # 只有 5 个
        tool = getattr(agent_tools, name, None)
        if callable(tool):
            registry[name] = tool
    return registry
```

而 `tools` 表种子数据定义了 12 个内置工具（`execute_code`、`shell_command`、`web_scraper`、`read_file`、`write_file`、`sql_query`、`image_generate`、`text_embedding` 等），运行时全部不可用。

**影响：** 用户在 Web 管理页面给子智能体配置了 `execute_code`，运行时 `tool_registry.get("execute_code")` 返回 `None`，静默跳过，工具不可用。

---

#### 问题 2：MCP 工具与 Agent 运行时完全断开

`mcp_tools` + `mcp_installations` 实现了完整的 MCP 广场（浏览、安装、卸载），但 `AgentBuilder.with_tools()` 和 `create_subagents()` 都不读取已安装的 MCP 工具。

**影响：** 用户安装了 MCP 工具，但 Agent 构建时完全不知道它们的存在。MCP 工具变成"展示性功能"。

LangChain 官方的 MCP 集成方式是 `langchain-mcp-adapters` 将 MCP server 工具转为 `BaseTool`。

---

#### 问题 3：工具定义三处重复

| 位置 | 内容 | 运行时是否使用 |
|------|------|---------------|
| `agent/tools/__init__.py` `__all__` | Python 函数实现列表 | ✅ 唯一真相源 |
| `tools` 表 `BUILTIN_TOOLS` 种子 | 名称、描述、分类、参数、版本 | ❌ 仅前端展示 |
| `Tool.params` JSON 字段 | 参数 schema | ❌ 运行时不读取 |

参数定义在 Python 函数的 type hint / docstring 中，DB 中的 `params` 字段只是"装饰品"。

---

#### 问题 4：Agent 构建是单例缓存，配置变更不生效

```python
# agent/graph.py
_graph = None  # 全局单例

async def init_graph():
    global _graph
    _graph = await create_main_agent(...)  # 启动时构建一次
    # 之后永远不重建
```

运行时通过 Web 管理页面修改 Agent 配置后，不自动重建——需重启服务。

---

#### 问题 5：记忆文件清单与 Store 内容可能漂移

`agent.files`（DB JSON 数组）记录文件名清单，文件内容在 LangGraph Store 中。两处无约束保证一致。`add_agent_config(type=file)` 正常路径下同时操作两处，但缺乏校验兜底。

---

#### 问题 6：无 Agent 版本管理

`update_agent()` 直接覆盖配置，无版本快照。企业场景中修改系统提示词后可能需要回滚。

---

## 二、升级目标架构

### 2.1 目标全景图

```
┌────────────────────────────────────────────────────────────────┐
│                     数据库层（关系型 DB — 配置唯一真相源）          │
│                                                                │
│  agents (v2)      ── 主/子智能体 + expert_profile + version      │
│  tools (v2)       ── 工具元数据 + implementation 路径 + source    │
│  skills           ── 技能包元数据（不变）                          │
│  mcp_tools        ── MCP 广场目录（不变）                          │
│  mcp_installations ── 用户级 MCP 安装（不变）                      │
│  agent_tools      ── Agent ↔ Tool 关联（含 MCP 工具）              │
│  agent_skills     ── Agent ↔ Skill 关联（不变）                    │
│  agent_versions   ── 新增：Agent 配置版本快照                      │
│  agent_mcp_configs ── 新增：Agent ↔ MCP 工具关联                   │
└──────────────────────────────┬─────────────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  AgentBuilder v2    │
                    │ (动态工具注册表)     │
                    ├─────────────────────┤
                    │ with_agent_from_db   │ ← DB 查询配置 + 版本校验
                    │ with_model           │ ← resolve_model()
                    │ with_tools           │ ← 动态工具注册表（DB 驱动）
                    │  ├─ builtin tools    │   ← Python 模块动态导入
                    │  ├─ mcp tools        │   ← langchain-mcp-adapters 桥接
                    │  └─ third_party     │   ← 插件路径动态加载
                    │ with_subagents       │ ← create_subagents()（同样用动态注册表）
                    │ with_system_prompt   │
                    │ with_memory          │ ← infer_scope() + Store 一致性校验
                    │ with_sandbox         │
                    │ with_backend         │ ← CompositeBackend
                    │ with_middleware      │
                    │ build()             │ → create_deep_agent()
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  GraphManager v2     │ ← 缓存 + 失效机制
                    │  (热重载)            │
                    ├─────────────────────┤
                    │ get_graph()          │ ← 版本号比对，按需重建
                    │ invalidate()         │ ← 配置变更时触发
                    └─────────────────────┘
```

### 2.2 升级原则

1. **DB 即唯一真相源** — 所有配置以 DB 为准，运行时从 DB 动态读取，不再硬编码
2. **工具统一入口** — 内置工具、MCP 工具、第三方工具统一通过 `ToolRegistry` 动态加载
3. **配置热重载** — Agent 配置变更后无需重启，自动按需重建
4. **渐进式改造** — 每个改进独立可交付，不破坏现有功能

---

## 三、改进 1：工具注册表改为 DB 驱动（高优先）

### 3.1 问题回顾

`get_tool_registry()` 硬编码 5 个工具，DB 中 12 个工具只有 5 个可用。

### 3.2 方案：Tool 模型新增 implementation 字段 + 动态注册表

#### 3.2.1 Tool 模型扩展

**文件：`web/backend/src/db/models/tool.py`**

```python
class Tool(Base):
    # ... 现有字段保持不变 ...

    # 新增字段
    implementation: Mapped[str | None] = mapped_column(
        String(256), nullable=True,
        comment="工具实现路径，格式: module_path:func_name，如 agent.tools.http_request:http_request"
    )
    tool_type: Mapped[str] = mapped_column(
        String(32), default="function",
        comment="工具类型: function(内置函数) | mcp(MCP工具) | plugin(第三方插件)"
    )
```

#### 3.2.2 种子数据补全

**文件：`web/backend/src/api/tools/service.py`** — 更新 `BUILTIN_TOOLS`

为每个内置工具补充 `implementation` 和 `tool_type` 字段：

```python
BUILTIN_TOOLS: list[dict] = [
    {
        "name": "http_request",
        "display_name": "HTTP 请求",
        # ... 现有字段 ...
        "tool_type": "function",
        "implementation": "agent.tools.http_request:http_request",
    },
    {
        "name": "get_datetime",
        "display_name": "当前时间",
        # ... 现有字段 ...
        "tool_type": "function",
        "implementation": "agent.tools.get_datetime:get_datetime",
    },
    {
        "name": "tavily_search",
        "display_name": "Tavily 网络搜索",
        # ... 现有字段 ...
        "tool_type": "function",
        "implementation": "agent.tools.tavily_search:tavily_search",
    },
    {
        "name": "kb_search",
        "display_name": "知识库搜索",
        # ... 现有字段 ...
        "tool_type": "function",
        "implementation": "agent.tools.kb_search:kb_search",
    },
    {
        "name": "list_knowledge_bases",
        "display_name": "列出知识库",
        # ... 现有字段 ...
        "tool_type": "function",
        "implementation": "agent.tools.kb_search:list_knowledge_bases",
    },
    # 以下工具需要新增 Python 实现：
    {
        "name": "execute_code",
        "display_name": "代码执行",
        # ... 现有字段 ...
        "tool_type": "function",
        "implementation": "agent.tools.execute_code:execute_code",  # 新建实现
    },
    {
        "name": "read_file",
        "display_name": "文件读取",
        "tool_type": "function",
        "implementation": "agent.tools.file_ops:read_file",  # 新建实现
    },
    {
        "name": "write_file",
        "display_name": "文件写入",
        "tool_type": "function",
        "implementation": "agent.tools.file_ops:write_file",
    },
    # ... 其余工具同理 ...
]
```

#### 3.2.3 动态工具注册表

**新建文件：`web/backend/src/agent/tools/registry.py`**

```python
"""DB 驱动的动态工具注册表。

替代原有 agent/common.py 中的硬编码 get_tool_registry()，
所有工具加载均以 tools 表为唯一真相源。
"""
import importlib
import logging
from typing import Any

from langchain_core.tools import BaseTool
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.models.tool import Tool

logger = logging.getLogger(__name__)

# 内置工具实现缓存（module_path:func_name → callable）
_builtin_cache: dict[str, Any] = {}


def _load_builtin_tool(implementation: str) -> Any | None:
    """通过 module_path:func_name 动态导入工具函数。

    Args:
        implementation: 如 "agent.tools.http_request:http_request"

    Returns:
        可调用的工具函数，或 None（导入失败时记录警告并返回 None）
    """
    if implementation in _builtin_cache:
        return _builtin_cache[implementation]

    if ":" not in implementation:
        logger.warning("工具实现路径格式错误（缺少冒号分隔）: %s", implementation)
        return None

    module_path, func_name = implementation.split(":", 1)
    try:
        module = importlib.import_module(module_path)
        fn = getattr(module, func_name, None)
        if fn is None:
            logger.warning("工具函数 '%s' 在模块 '%s' 中未找到", func_name, module_path)
            return None
        _builtin_cache[implementation] = fn
        return fn
    except ImportError:
        logger.warning("工具模块 '%s' 导入失败", module_path, exc_info=True)
        return None


async def get_tool_registry(db: AsyncSession) -> dict[str, Any]:
    """从 DB 动态构建工具注册表。

    查询所有 status=enabled 的工具，按 tool_type 分别加载：
    - function: 动态导入 Python 函数
    - mcp: 通过 langchain-mcp-adapters 加载（见改进 2）
    - plugin: 从插件路径动态加载（预留）

    Returns:
        工具名称 → 可调用对象的映射
    """
    stmt = select(Tool).where(Tool.status == "enabled")
    tools = (await db.execute(stmt)).scalars().all()

    registry: dict[str, Any] = {}
    for tool in tools:
        if tool.tool_type == "function":
            if not tool.implementation:
                logger.warning("工具 '%s' 为 function 类型但未配置 implementation", tool.name)
                continue
            fn = _load_builtin_tool(tool.implementation)
            if fn is not None:
                registry[tool.name] = fn
        elif tool.tool_type == "mcp":
            # MCP 工具加载逻辑见改进 2（延迟加载，构建时单独处理）
            logger.debug("MCP 工具 '%s' 将在构建时单独加载", tool.name)
        elif tool.tool_type == "plugin":
            logger.debug("第三方插件工具 '%s' 加载预留", tool.name)

    logger.info("动态工具注册表加载完成：%d 个工具可用", len(registry))
    return registry


async def resolve_agent_tools(
    db: AsyncSession,
    agent_id: str,
    tool_names: list[str],
) -> list[Any]:
    """为指定 Agent 解析工具列表。

    合并内置工具和 MCP 工具，按 DB 关联顺序返回。
    """
    # 1. 加载内置工具注册表
    registry = await get_tool_registry(db)

    # 2. 加载该 Agent 的 MCP 工具（见改进 2）
    from agent.tools.mcp_loader import load_mcp_tools_for_agent
    mcp_tools = await load_mcp_tools_for_agent(db, agent_id)
    for mcp_tool in mcp_tools:
        registry[mcp_tool.name] = mcp_tool

    # 3. 按名称解析
    resolved: list[Any] = []
    for name in tool_names:
        fn = registry.get(name)
        if fn is not None:
            resolved.append(fn)
        else:
            logger.warning("工具 '%s' 在注册表中未找到，已跳过", name)

    return resolved
```

#### 3.2.4 迁移：替换旧 get_tool_registry

**文件：`web/backend/src/agent/common.py`**

```python
# 旧实现保留为兼容入口（标记 deprecated）
def get_tool_registry() -> dict[str, object]:
    """[已废弃] 使用 agent.tools.registry.get_tool_registry(db) 替代。"""
    # 过渡期：仍返回硬编码的 5 个工具，但新增日志提示
    import warnings
    warnings.warn(
        "get_tool_registry() 已废弃，请使用 agent.tools.registry.get_tool_registry(db)",
        DeprecationWarning,
    )
    registry: dict[str, object] = {}
    for name in agent_tools.__all__:
        tool = getattr(agent_tools, name, None)
        if callable(tool):
            registry[name] = tool
    return registry
```

#### 3.2.5 AgentBuilder.with_tools() 改造

**文件：`web/backend/src/agent/builders/agent_builder.py`**

```python
async def with_tools(self, db: AsyncSession) -> "AgentBuilder":
    """将工具名称解析为可调用函数（DB 驱动动态加载）。"""
    if self._agent_info is None:
        raise RuntimeError("必须先调用 with_agent_from_db()")

    from agent.tools.registry import resolve_agent_tools
    self._tools = await resolve_agent_tools(db, self._agent_id, self._agent_info.tools)
    return self
```

#### 3.2.6 子智能体工具解析同步改造

**文件：`web/backend/src/agent/subagents/subagents_operate.py`**

```python
async def create_subagents(db: AsyncSession) -> list[dict]:
    """从数据库读取子智能体并组装为 subagents 配置。"""
    from agent.tools.registry import resolve_agent_tools

    # ... 查询逻辑不变 ...
    for info in sub_agent_infos:
        # 替换：tools = [tool_registry.get(name) for name in info.tools]
        tools = await resolve_agent_tools(db, info.id, info.tools)
        tools = [t for t in tools if t is not None]

        subagents.append({
            "name": info.name,
            "description": info.description or "",
            "tools": tools,
            "model": await resolve_model(info.provider_id, info.model_id),
            "system_prompt": info.system_prompt or "",
            "skills": [f"/skills/{info.id}/"],
        })
    return subagents
```

### 3.3 数据库迁移

```sql
-- Tool 表新增字段
ALTER TABLE tools ADD COLUMN implementation TEXT DEFAULT NULL;
ALTER TABLE tools ADD COLUMN tool_type TEXT DEFAULT 'function';

-- 回填现有工具的 implementation 字段
UPDATE tools SET implementation = 'agent.tools.http_request:http_request', tool_type = 'function' WHERE name = 'http_request';
UPDATE tools SET implementation = 'agent.tools.get_datetime:get_datetime', tool_type = 'function' WHERE name = 'get_datetime';
UPDATE tools SET implementation = 'agent.tools.tavily_search:tavily_search', tool_type = 'function' WHERE name = 'tavily_search';
UPDATE tools SET implementation = 'agent.tools.kb_search:kb_search', tool_type = 'function' WHERE name = 'kb_search';
UPDATE tools SET implementation = 'agent.tools.kb_search:list_knowledge_bases', tool_type = 'function' WHERE name = 'list_knowledge_bases';
```

## 四、改进 2：MCP 工具接入运行时

### 4.1 问题回顾

当前系统中 MCP 相关数据存储在两张表中：

- `mcp_tools`（目录表）：存储 MCP 工具的元数据、配置 schema、分类等，模型文件位于 `db/models/mcp_tool.py`。
- `mcp_installations`（安装表）：按用户维度记录已安装的 MCP 工具及配置值，模型文件位于 `db/models/mcp_installation.py`。

这两张表完全独立于 Agent 运行时——`AgentBuilder.with_tools()` 只从 `get_tool_registry()` 获取硬编码的 5 个 Python 函数工具，MCP 工具从未被加载到 Agent 的 `tools` 列表中。用户在 MCP 市场安装了工具，但 Agent 实际无法调用它们。

### 4.2 目标

将 MCP 工具纳入 Agent 的统一工具体系，使得：

1. MCP 工具和内置函数工具对 Agent 透明——Agent 只看到统一的 `BaseTool` 接口。
2. 通过 `agent_tools` 关联表即可为 Agent 配置 MCP 工具，无需单独的关联表。
3. MCP 连接的生命周期由运行时管理，支持多传输模式（stdio / SSE / streamable-http）。

### 4.3 技术选型

`pyproject.toml` 中已包含 `mcp>=1.0.0`，但缺少 `langchain-mcp-adapters`——这是将 MCP 工具适配为 LangChain `BaseTool` 的官方适配库。

需新增依赖：

```toml
# pyproject.toml [project].dependencies
"langchain-mcp-adapters>=0.1.0",
```

### 4.4 数据模型扩展

#### 4.4.1 Tool 模型扩展（与改进 1 一致）

在改进 1 中已为 `Tool` 模型添加了 `tool_type` 字段（默认 `'function'`）和 `implementation` 字段。对于 MCP 工具，`tool_type = 'mcp'`，`implementation` 字段存储 MCP 服务器的连接标识（对应 `mcp_tools.name`）。

#### 4.4.2 MCP 工具自动注册到 tools 表

当 MCP 目录中的工具被首次为某 Agent 配置时，系统自动在 `tools` 表中创建一条 `tool_type='mcp'` 的记录：

```python
# api/agents/service.py — 新增辅助函数
async def _ensure_mcp_tool_record(db: AsyncSession, mcp_name: str) -> Tool:
    """确保 MCP 工具在 tools 表中有对应记录。"""
    tool = (await db.execute(
        select(Tool).where(Tool.name == f"mcp__{mcp_name}", Tool.tool_type == "mcp")
    )).scalar_one_or_none()

    if tool is not None:
        return tool

    # 从 mcp_tools 表读取元数据
    mcp_tool = (await db.execute(
        select(McpTool).where(McpTool.name == mcp_name)
    )).scalar_one_or_none()
    if mcp_tool is None:
        raise HTTPException(404, f"MCP 工具不存在: {mcp_name}")

    tool = Tool(
        name=f"mcp__{mcp_name}",
        display_name=mcp_tool.name,
        description=mcp_tool.description,
        category="ai",
        source="third_party",
        status="enabled",
        tool_type="mcp",
        implementation=mcp_name,
        params=mcp_tool.config_schema,
    )
    db.add(tool)
    await db.flush()
    return tool
```

### 4.5 MCP 工具加载器

新建 `agent/tools/mcp_loader.py`，负责根据 Agent 关联的 MCP 工具记录，建立连接并返回 LangChain `BaseTool` 列表。

```python
# agent/tools/mcp_loader.py
"""MCP 工具加载器 — 将 MCP 服务器工具适配为 LangChain BaseTool。"""

import logging
from typing import Any

from langchain_core.tools import BaseTool
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.models.agent_tool import AgentTool
from db.models.mcp_installation import McpInstallation
from db.models.mcp_tool import McpTool
from db.models.tool import Tool

logger = logging.getLogger(__name__)

# 缓存已连接的 MCP 客户端，避免重复建连
_mcp_clients: dict[str, Any] = {}


async def _get_mcp_config(
    db: AsyncSession,
    mcp_tool_name: str,
    user_id: str | None = None,
) -> dict[str, Any]:
    """从 mcp_installations 表读取用户配置；无用户上下文时用默认空配置。"""
    if user_id is None:
        return {}

    mcp_tool = (await db.execute(
        select(McpTool).where(McpTool.name == mcp_tool_name)
    )).scalar_one_or_none()
    if mcp_tool is None:
        return {}

    installation = (await db.execute(
        select(McpInstallation).where(
            McpInstallation.user_id == user_id,
            McpInstallation.mcp_tool_id == mcp_tool.id,
        )
    )).scalar_one_or_none()

    return installation.config if installation is not None else {}


async def load_mcp_tools_for_agent(
    db: AsyncSession,
    agent_id: str,
    user_id: str | None = None,
) -> list[BaseTool]:
    """加载 Agent 关联的 MCP 工具，返回适配后的 BaseTool 列表。

    流程：
    1. 查询 agent_tools 关联表中 tool_type='mcp' 的记录。
    2. 对每条记录，从 mcp_installations 获取用户配置。
    3. 建立或复用 MCP 客户端连接，获取工具列表。
    4. 为 MCP 工具名称加上 mcp__ 前缀，避免与内置工具名冲突。
    """
    stmt = (
        select(Tool)
        .join(AgentTool, AgentTool.tool_id == Tool.id)
        .where(AgentTool.agent_id == agent_id, Tool.tool_type == "mcp")
    )
    mcp_tool_rows = (await db.execute(stmt)).scalars().all()
    if not mcp_tool_rows:
        return []

    all_tools: list[BaseTool] = []

    for tool_row in mcp_tool_rows:
        mcp_name = tool_row.implementation
        config = await _get_mcp_config(db, mcp_name, user_id)

        try:
            client = await _get_or_create_client(mcp_name, config)
            mcp_tools = await client.get_tools()
            for t in mcp_tools:
                t.name = f"mcp__{mcp_name}__{t.name}"
                all_tools.append(t)
        except Exception:
            logger.exception("加载 MCP 工具失败，跳过: %s", mcp_name)

    return all_tools


async def _get_or_create_client(mcp_name: str, config: dict) -> Any:
    """获取或创建 MCP 客户端连接（带缓存）。"""
    cache_key = f"{mcp_name}:{hash(frozenset(config.items()))}"

    if cache_key in _mcp_clients:
        return _mcp_clients[cache_key]

    from langchain_mcp_adapters.client import MultiServerMCPClient

    server_config = {
        mcp_name: {
            "command": config.get("command", "npx"),
            "args": config.get("args", []),
            "transport": config.get("transport", "stdio"),
            "env": config.get("env", {}),
        }
    }

    client = MultiServerMCPClient(server_config)
    _mcp_clients[cache_key] = client
    return client


async def close_mcp_clients():
    """关闭所有缓存的 MCP 客户端连接（应用关闭时调用）。"""
    global _mcp_clients
    for key, client in _mcp_clients.items():
        try:
            await client.close()
        except Exception:
            logger.warning("关闭 MCP 客户端失败: %s", key, exc_info=True)
    _mcp_clients.clear()
```

### 4.6 AgentBuilder 集成

在 `AgentBuilder.with_tools()` 中，将 MCP 工具加载与函数工具加载合并：

```python
# agent/builders/agent_builder.py — with_tools() 改造
async def with_tools(self, db: AsyncSession) -> "AgentBuilder":
    """将工具名称解析为可调用函数，包括内置函数工具和 MCP 工具。"""
    if self._agent_info is None:
        raise RuntimeError("必须先调用 with_agent_from_db()")

    from agent.tools.registry import resolve_agent_tools
    from agent.tools.mcp_loader import load_mcp_tools_for_agent

    # 内置函数工具
    self._tools = await resolve_agent_tools(db, self._agent_id, self._agent_info.tools)

    # MCP 工具
    mcp_tools = await load_mcp_tools_for_agent(db, self._agent_id, user_id=None)
    self._tools.extend(mcp_tools)

    return self
```

### 4.7 子智能体 MCP 工具同步

`subagents_operate.py` 中的 `create_subagents()` 同样需要在解析工具时加载 MCP 工具：

```python
# agent/subagents/subagents_operate.py — 改造
async def create_subagents() -> list[dict]:
    """从数据库读取子智能体配置，包括 MCP 工具。"""
    from agent.tools.registry import resolve_agent_tools
    from agent.tools.mcp_loader import load_mcp_tools_for_agent
    from db.engine import async_session

    async with async_session() as session:
        result = await list_agents(session)
        await session.commit()

    sub_agent_infos = [
        a for a in result.agents
        if a.type == "sub" and a.status == "active"
    ]

    subagents: list[dict] = []
    for info in sub_agent_infos:
        # 解析内置 + MCP 工具
        tools = await resolve_agent_tools(session, info.id, info.tools)
        mcp_tools = await load_mcp_tools_for_agent(session, info.id)
        tools = tools + mcp_tools

        subagents.append({
            "name": info.name,
            "description": info.description or "",
            "tools": tools,
            "model": await resolve_model(info.provider_id, info.model_id),
            "system_prompt": info.system_prompt or "",
            "skills": [f"/skills/{info.id}/"],
        })
    return subagents
```

### 4.8 应用关闭时清理

在 `graph.py` 的 `shutdown_graph()` 中，增加 MCP 客户端清理：

```python
# agent/graph.py — shutdown_graph() 扩展
async def shutdown_graph():
    global _conn_pool, _sandbox_manager
    if _sandbox_manager is not None:
        _sandbox_manager.shutdown()
        _sandbox_manager = None
    if _conn_pool is not None:
        await _conn_pool.close()
        _conn_pool = None

    # 清理 MCP 客户端连接
    from agent.tools.mcp_loader import close_mcp_clients
    await close_mcp_clients()
```

### 4.9 数据库迁移

```sql
-- 改进 2 不新增表，仅依赖改进 1 中的 tool_type / implementation 字段
-- 需要运行应用层迁移脚本，将 mcp_tools 表中的活跃工具同步注册到 tools 表
-- 迁移脚本路径: alembic/versions/xxx_sync_mcp_to_tools.py
```

## 五、改进 3：Agent 配置热重载

### 5.1 问题回顾

`agent/graph.py` 中的 `init_graph()` 在应用启动时构建一次 Graph 并存入全局变量 `_graph`，之后通过 `get_graph()` 获取。问题在于：

- 管理员通过 API 修改 Agent 配置（`update_agent`、`add_agent_config`、`toggle_agent_status`）后，`_graph` 不会自动重建。
- 必须重启服务才能让配置生效，这在生产环境中不可接受。
- 多处 service 层函数（`update_agent`、`add_agent_config` 等）没有调用任何失效逻辑。

### 5.2 目标

引入 `GraphManager` 类替代裸全局变量，实现配置变更后的按需重建，同时保持 `get_graph()` 的调用方接口不变。

### 5.3 设计：GraphManager

```python
# agent/graph.py — 重构为 GraphManager

import asyncio
import logging
from typing import Any

from agent.mainagents import create_main_agent
from agent.sandbox.sandbox_manager import SandboxManager

logger = logging.getLogger(__name__)


class GraphManager:
    """管理 Agent Graph 的生命周期，支持配置热重载。

    - 首次调用 get_graph() 时懒加载构建。
    - 配置变更后调用 invalidate()，下次 get_graph() 自动重建。
    - 构建过程加锁，防止并发重复构建。
    """

    def __init__(self) -> None:
        self._graph: Any = None
        self._checkpointer: Any = None
        self._store: Any = None
        self._sandbox_manager: SandboxManager | None = None
        self._conn_pool: Any = None
        self._lock = asyncio.Lock()
        self._version: int = 0  # 递增版本号，每次 invalidate +1

    @property
    def version(self) -> int:
        return self._version

    def get_graph(self) -> Any:
        """返回当前 Graph 实例（不触发构建）。"""
        if self._graph is None:
            raise RuntimeError("图未初始化，请先调用 init_graph() 或 ensure_built()")
        return self._graph

    def get_store(self) -> Any:
        if self._store is None:
            raise RuntimeError("Store 未初始化，请先调用 init_graph()")
        return self._store

    def get_checkpointer(self) -> Any:
        if self._checkpointer is None:
            raise RuntimeError("Checkpointer 未初始化")
        return self._checkpointer

    async def init_graph(self) -> None:
        """初始化基础设施（checkpointer / store / sandbox），构建 Graph。"""
        await self._init_infrastructure()
        await self._build_graph()

    async def ensure_built(self) -> Any:
        """确保 Graph 已构建（懒加载入口）。"""
        if self._graph is None:
            async with self._lock:
                if self._graph is None:
                    await self._init_infrastructure()
                    await self._build_graph()
        return self._graph

    async def invalidate(self) -> None:
        """标记 Graph 为过期，下次 get_graph() / ensure_built() 时重建。

        仅标记过期，不立即重建——避免在 API 请求中阻塞。
        """
        self._version += 1
        self._graph = None
        logger.info("Graph 已标记为过期（version=%d），将在下次访问时重建", self._version)

    async def _init_infrastructure(self) -> None:
        """初始化 checkpointer、store、sandbox manager。"""
        from agent.config import settings

        checkpoint_backend = settings.CHECKPOINT_BACKEND

        if checkpoint_backend == "sqlite":
            import aiosqlite
            from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
            from langgraph.store.memory import InMemoryStore

            conn = await aiosqlite.connect(settings.CHECKPOINT_DB_PATH)
            self._checkpointer = AsyncSqliteSaver(conn)
            self._store = InMemoryStore()
        elif checkpoint_backend == "postgres":
            from psycopg.rows import DictRow, dict_row
            from psycopg_pool import AsyncConnectionPool
            from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
            from langgraph.store.postgres.aio import AsyncPostgresStore

            self._conn_pool = AsyncConnectionPool(
                conninfo=settings.CHECKPOINT_DB_URL,
                open=False,
                kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row},
            )
            await self._conn_pool.open()
            self._checkpointer = AsyncPostgresSaver(self._conn_pool)
            await self._checkpointer.setup()
            self._store = AsyncPostgresStore(self._conn_pool)
            await self._store.setup()
        else:
            raise ValueError(f"未知 CHECKPOINT_BACKEND: {checkpoint_backend}")

        self._sandbox_manager = SandboxManager(
            extra_domains=settings.sandbox_allowed_domains_list,
        )
        self._sandbox_manager.start_cleanup()

    async def _build_graph(self) -> None:
        """使用 AgentBuilder 构建 Graph。"""
        self._graph = await create_main_agent(
            checkpointer=self._checkpointer,
            store=self._store,
            sandbox_manager=self._sandbox_manager,
        )

    async def shutdown(self) -> None:
        """关闭所有资源。"""
        if self._sandbox_manager is not None:
            self._sandbox_manager.shutdown()
            self._sandbox_manager = None
        if self._conn_pool is not None:
            await self._conn_pool.close()
            self._conn_pool = None

        from agent.tools.mcp_loader import close_mcp_clients
        await close_mcp_clients()


# 全局单例
_manager = GraphManager()


# 兼容旧接口
def get_graph() -> Any:
    return _manager.get_graph()


def get_store() -> Any:
    return _manager.get_store()


def get_checkpointer() -> Any:
    return _manager.get_checkpointer()


async def init_graph() -> None:
    await _manager.init_graph()


async def shutdown_graph() -> None:
    await _manager.shutdown()


async def invalidate_graph() -> None:
    """供 service 层调用的公共接口，触发 Graph 失效。"""
    await _manager.invalidate()


__all__ = [
    "get_graph", "get_store", "get_checkpointer",
    "init_graph", "shutdown_graph", "invalidate_graph",
]
```

### 5.4 Service 层集成

在所有修改 Agent 配置的 service 函数中，提交事务后调用 `invalidate_graph()`：

```python
# api/agents/service.py — 在 update_agent、add_agent_config、remove_agent_config、
# toggle_agent_status、create_agent、delete_agent 等函数末尾增加：
from agent.graph import invalidate_graph

async def update_agent(db: AsyncSession, agent_id: str, req: AgentUpdateRequest) -> AgentInfo:
    # ... 原有逻辑 ...
    await db.flush()
    # ... 构建 AgentInfo ...

    # 触发 Graph 热重载
    await invalidate_graph()

    return await _agent_to_info(db, agent, sub_ids, skills, tool_names)


async def add_agent_config(db: AsyncSession, agent_id: str, req: AgentConfigRequest, *, user_id=None):
    # ... 原有逻辑 ...
    await db.flush()

    # 触发 Graph 热重载
    await invalidate_graph()

    return await _agent_to_info(...)


async def toggle_agent_status(db: AsyncSession, agent_id: str) -> AgentInfo:
    # ... 原有逻辑 ...
    await db.flush()

    # 触发 Graph 热重载
    await invalidate_graph()

    return await _agent_to_info(...)
```

### 5.5 热重载时序

```
管理员调用 PUT /api/agents/{id}
    -> update_agent() 修改 DB
    -> invalidate_graph() 标记过期（version++，_graph = None）
    -> 返回 API 响应（不阻塞）

下次用户调用 POST /api/chat
    -> get_graph() 检测到 _graph is None
    -> ensure_built() 加锁
    -> _build_graph() 从 DB 重新读取最新配置
    -> 返回新 Graph 实例
    -> 正常处理用户请求
```

### 5.6 边界情况处理

| 场景 | 处理方式 |
|------|---------|
| 并发 invalidate | `_version` 递增是原子操作，多次 invalidate 合并为一次重建 |
| 构建失败 | `_build_graph()` 抛异常时 `_graph` 保持 None，`ensure_built()` 下次重试 |
| Store 数据保留 | 重建时复用已初始化的 `_store` 和 `_checkpointer`，历史对话不丢失 |
| 子智能体变更 | `invalidate_graph()` 触发整个 Graph 重建，包括子智能体重新加载 |
```

## 六、改进 4：Agent 版本管理

### 6.1 问题回顾

当前 `Agent` 模型（`db/models/agent.py`）没有版本字段，也没有历史快照机制。`update_agent()` 直接覆盖原始记录，无法回滚到之前的配置。这在以下场景中存在风险：

- 管理员误修改了 system_prompt 或工具配置，无法恢复。
- 需要对比不同版本的 Agent 配置差异。
- A/B 测试时无法快速切换不同配置。

### 6.2 目标

引入 `agent_versions` 表，在每次更新 Agent 配置时自动创建版本快照，支持版本列表查询和回滚。

### 6.3 数据模型

```python
# db/models/agent_version.py
"""Agent 版本快照模型 — 记录 Agent 配置的每次变更历史。"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class AgentVersion(Base):
    """Agent 配置版本快照。"""

    __tablename__ = "agent_versions"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    agent_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("agents.id", ondelete="CASCADE"),
        nullable=False, index=True, comment="关联的 Agent ID"
    )
    version: Mapped[int] = mapped_column(
        Integer, nullable=False, comment="版本号，从 1 递增"
    )
    snapshot: Mapped[dict] = mapped_column(
        JSON, nullable=False,
        comment="Agent 配置快照 JSON: name, type, status, description, system_prompt, files, provider_id, model_id, tools, skills"
    )
    changed_by: Mapped[str] = mapped_column(
        String(36), default="", comment="操作者用户 ID"
    )
    change_summary: Mapped[str] = mapped_column(
        Text, default="", comment="变更摘要"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=_utcnow, comment="快照创建时间"
    )
```

### 6.4 自动快照逻辑

在 `update_agent()` 中，修改前先创建快照：

```python
# api/agents/service.py — update_agent() 改造
from db.models.agent_version import AgentVersion


async def _create_version_snapshot(
    db: AsyncSession,
    agent: Agent,
    tool_names: list[str],
    skill_ids: list[str],
    changed_by: str = "",
    change_summary: str = "",
) -> AgentVersion:
    """在修改前创建当前配置的版本快照。"""
    # 查询当前最大版本号
    from sqlalchemy import func, select
    max_ver = (await db.execute(
        select(func.max(AgentVersion.version)).where(AgentVersion.agent_id == agent.id)
    )).scalar() or 0

    snapshot = {
        "name": agent.name,
        "type": agent.type,
        "status": agent.status,
        "description": agent.description,
        "system_prompt": agent.system_prompt,
        "files": agent.files if isinstance(agent.files, list) else [],
        "provider_id": agent.provider_id,
        "model_id": agent.model_id,
        "tools": tool_names,
        "skills": skill_ids,
        "parent_id": agent.parent_id,
    }

    version = AgentVersion(
        agent_id=agent.id,
        version=max_ver + 1,
        snapshot=snapshot,
        changed_by=changed_by,
        change_summary=change_summary,
    )
    db.add(version)
    await db.flush()
    return version


async def update_agent(db: AsyncSession, agent_id: str, req: AgentUpdateRequest) -> AgentInfo:
    stmt = select(Agent).where(Agent.id == agent_id)
    agent = (await db.execute(stmt)).scalar_one_or_none()
    if agent is None:
        raise HTTPException(404, "Agent not found")

    # 名称唯一性检查
    dup = (await db.execute(
        select(Agent).where(Agent.name == req.name, Agent.id != agent_id)
    )).scalar_one_or_none()
    if dup is not None:
        raise HTTPException(409, f"Agent name '{req.name}' already exists")

    # 修改前创建快照
    current_tool_names = await _get_agent_tool_names(db, agent_id)
    current_skill_ids = [s.id for s in await _get_agent_skill_briefs(db, agent_id)]
    await _create_version_snapshot(
        db, agent, current_tool_names, current_skill_ids,
        change_summary=f"更新: {req.name}"
    )

    # 应用修改
    agent.name = req.name
    agent.description = req.description
    agent.system_prompt = req.system_prompt
    agent.provider_id = req.provider_id
    agent.model_id = req.model_id

    await db.flush()
    # ... 后续逻辑不变 ...
    await invalidate_graph()
    return await _agent_to_info(db, agent, sub_ids, skills, tool_names)
```

### 6.5 版本查询与回滚 API

```python
# api/agents/agents_api.py — 新增版本管理端点

@router.get("/{agent_id}/versions", response_model=ApiResponse[list[AgentVersionBrief]])
@handle_errors
async def agent_versions_list(agent_id: str, db: AsyncSession = Depends(get_db)):
    """获取 Agent 的版本历史列表。"""
    result = await list_agent_versions(db, agent_id)
    return ok(result)


@router.get("/{agent_id}/versions/{version_id}", response_model=ApiResponse[AgentVersionDetail])
@handle_errors
async def agent_version_detail(
    agent_id: str, version_id: str, db: AsyncSession = Depends(get_db)
):
    """获取某个版本快照的详细内容。"""
    result = await get_agent_version(db, agent_id, version_id)
    return ok(result)


@router.post("/{agent_id}/versions/{version_id}/rollback", response_model=ApiResponse[AgentInfo])
@handle_errors
async def agent_version_rollback(
    agent_id: str, version_id: str, db: AsyncSession = Depends(get_db)
):
    """回滚到指定版本的配置。"""
    result = await rollback_agent_version(db, agent_id, version_id)
    return ok(result)
```

```python
# api/agents/service.py — 回滚逻辑
async def rollback_agent_version(db: AsyncSession, agent_id: str, version_id: str) -> AgentInfo:
    """将 Agent 配置回滚到指定版本。"""
    stmt = select(AgentVersion).where(
        AgentVersion.agent_id == agent_id, AgentVersion.id == version_id
    )
    version = (await db.execute(stmt)).scalar_one_or_none()
    if version is None:
        raise HTTPException(404, "版本不存在")

    agent = (await db.execute(
        select(Agent).where(Agent.id == agent_id)
    )).scalar_one_or_none()
    if agent is None:
        raise HTTPException(404, "Agent not found")

    snap = version.snapshot

    # 回滚前先创建当前配置的快照
    current_tool_names = await _get_agent_tool_names(db, agent_id)
    current_skill_ids = [s.id for s in await _get_agent_skill_briefs(db, agent_id)]
    await _create_version_snapshot(
        db, agent, current_tool_names, current_skill_ids,
        change_summary=f"回滚前自动快照（目标版本 v{version.version}）"
    )

    # 应用快照
    agent.name = snap["name"]
    agent.description = snap.get("description", "")
    agent.system_prompt = snap.get("system_prompt", "")
    agent.provider_id = snap.get("provider_id")
    agent.model_id = snap.get("model_id")
    agent.files = snap.get("files", [])

    await db.flush()
    await invalidate_graph()

    sub_ids = await _get_sub_agent_ids(db, agent_id)
    skills = await _get_agent_skill_briefs(db, agent_id)
    tool_names = await _get_agent_tool_names(db, agent_id)
    return await _agent_to_info(db, agent, sub_ids, skills, tool_names)
```

### 6.6 数据库迁移

```sql
-- 创建 agent_versions 表
CREATE TABLE agent_versions (
    id VARCHAR(36) PRIMARY KEY,
    agent_id VARCHAR(36) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    snapshot JSON NOT NULL,
    changed_by VARCHAR(36) DEFAULT '',
    change_summary TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_agent_versions_agent_id ON agent_versions(agent_id);
CREATE INDEX idx_agent_versions_version ON agent_versions(agent_id, version DESC);
```

## 七、改进 5：记忆文件一致性校验

### 7.1 问题回顾

Agent 的记忆文件存储在两个位置：

- `Agent.files` 字段（JSON 数组）：记录文件名列表，如 `["AGENTS.md", "SOUL.md", "USER.md"]`。
- LangGraph Store：实际文件内容，通过 `namespace + key` 定位，namespace 由 `scope_namespace()` 根据 agent_id 和 user_id 计算。

当前存在不一致风险：

- 删除 Agent.files 中的文件名时，Store 中的内容不会被删除（`remove_agent_config` 只修改 JSON 数组）。
- Store 中的文件可能被其他操作（如 Store 重建）清空，但 `Agent.files` 列表不变。
- `list_agents()` / `get_agent()` 读取文件列表时，尝试从 Store 获取元数据，如果 Store 中不存在则返回空 description，但不会自动清理 `Agent.files` 中的无效引用。

### 7.2 目标

实现一致性校验机制，在读取 Agent 信息时自动修复 `Agent.files` 与 Store 之间的偏差。

### 7.3 设计：_sync_files_with_store()

```python
# api/agents/service.py — 新增一致性校验函数

async def _sync_files_with_store(
    db: AsyncSession,
    agent_id: str,
    files: list[str],
    *,
    user_id: str | None = None,
) -> list[str]:
    """校验 Agent.files 与 Store 中实际内容的一致性，返回修正后的文件列表。

    规则：
    - Agent.files 中存在但 Store 中不存在的文件名 -> 从列表中移除。
    - Store 中存在但 Agent.files 中不存在的文件 -> 不自动添加（可能是临时文件）。
    - 同时持久化修正后的列表到 Agent.files 字段。
    """
    from agent.graph import get_store
    from agent.memory.scopes import MemoryScope, scope_namespace

    try:
        store = get_store()
    except RuntimeError:
        # Store 未初始化，跳过校验
        return files

    valid_files: list[str] = []
    dirty = False  # 是否有变更

    for filename in files:
        scope = infer_scope(filename)
        ns = scope_namespace(scope, agent_id=agent_id, user_id=user_id, org_id=DEFAULT_ORG_ID)

        try:
            item = await store.aget(ns, f"/{filename}")
        except Exception:
            logger.warning("读取 Store 文件失败: %s", filename, exc_info=True)
            item = None

        if item is not None:
            valid_files.append(filename)
        else:
            logger.info("文件 '%s' 在 Store 中不存在，从 Agent.files 中移除", filename)
            dirty = True

    if dirty:
        # 持久化修正
        stmt = select(Agent).where(Agent.id == agent_id)
        agent = (await db.execute(stmt)).scalar_one_or_none()
        if agent is not None:
            agent.files = valid_files
            await db.flush()

    return valid_files
```

### 7.4 集成到读取流程

在 `_agent_to_info()` 中调用一致性校验：

```python
# api/agents/service.py — _agent_to_info() 改造
async def _agent_to_info(
    db: AsyncSession,
    agent: Agent,
    sub_agent_ids: list[str] | None = None,
    skills: list[SkillBrief] | None = None,
    tool_names: list[str] | None = None,
    user_id: str | None = None,
) -> AgentInfo:
    files = agent.files if isinstance(agent.files, list) else []

    # 一致性校验
    files = await _sync_files_with_store(db, agent.id, files, user_id=user_id)

    files_by_scope = await _get_agent_files_by_scope(db, agent.id, files)
    return AgentInfo(
        id=agent.id,
        name=agent.name,
        type=agent.type,
        status=agent.status,
        description=agent.description,
        tools=tool_names if tool_names is not None else [],
        skills=skills if skills is not None else [],
        system_prompt=agent.system_prompt or "",
        files=files,
        files_by_scope=files_by_scope,
        sub_agents=sub_agent_ids if sub_agent_ids is not None else [],
        parent_id=agent.parent_id,
        provider_id=agent.provider_id,
        model_id=agent.model_id,
        last_active=None,
        call_count=0,
        undeletable=agent.undeletable,
        created_at=agent.created_at,
        updated_at=agent.updated_at,
    )
```

### 7.5 删除文件时同步清理 Store

在 `remove_agent_config()` 中，当 `type == "file"` 时，同时从 Store 删除文件内容：

```python
# api/agents/service.py — remove_agent_config() 中的 file 分支改造
elif req.type == "file":
    column = CONFIG_TYPE_TO_COLUMN.get(req.type)
    current = getattr(agent, column, [])
    if req.value in current:
        current = list(current)
        current.remove(req.value)
        setattr(agent, column, current)

        # 同步删除 Store 中的文件内容
        from agent.graph import get_store
        from agent.memory.scopes import infer_scope, scope_namespace

        try:
            store = get_store()
            scope = infer_scope(req.value)
            ns = scope_namespace(scope, agent_id=agent.id, user_id=user_id, org_id=DEFAULT_ORG_ID)
            await store.adelete(ns, f"/{req.value}")
            logger.info("已从 Store 删除文件: %s", req.value)
        except Exception:
            logger.warning("从 Store 删除文件失败: %s", req.value, exc_info=True)
```

### 7.6 校验时机

| 调用点 | 行为 |
|--------|------|
| `list_agents()` | 遍历每个 Agent 时调用 `_sync_files_with_store()` |
| `get_agent()` | 返回 Agent 详情前调用 |
| `remove_agent_config(type="file")` | 同步删除 Store 中的文件内容 |
| Graph 构建（`AgentBuilder.with_memory()`） | 以校验后的 files 列表构建 memory 路径 |

## 八、改进 6：统一工具定义来源

### 8.1 问题回顾

当前工具信息存在于三个独立的定义源中，彼此不关联：

1. **Python 代码层**：`agent/tools/__init__.py` 中的 `__all__` 列表，手动维护导出的工具函数名。
2. **数据库层**：`tools` 表中的 `name`、`display_name`、`description`、`params` 等字段，需手动与代码同步。
3. **运行时注册表**：`agent/common.py` 中的 `get_tool_registry()`，从 `__all__` 遍历构建映射。

这三者之间的同步完全靠人工维护，容易出现：

- 新增工具后忘记更新 `__all__` 或 `tools` 表。
- `tools` 表中的 `params` 定义与实际函数签名的参数不一致。
- `get_tool_registry()` 中的工具列表与 `tools` 表脱节。

### 8.2 目标

以 **数据库 tools 表为唯一真相源（Single Source of Truth）**，代码层不再手动维护工具清单，而是通过 `implementation` 字段动态发现和加载。

### 8.3 Tool.params 升级为 JSON Schema

当前 `Tool.params` 是简单的参数定义数组 `[{key, label, required, type}]`，仅用于前端表单渲染。升级为完整的 JSON Schema，使其同时适用于：

- 前端表单渲染（从 JSON Schema 自动生成表单）
- 运行时参数校验（Pydantic / jsonschema）
- LLM 工具描述（LangChain `args_schema`）

```python
# tools 表中 params 字段升级后的示例（JSON）
{
    "type": "object",
    "properties": {
        "url": {
            "type": "string",
            "description": "请求的 URL 地址",
            "title": "URL"
        },
        "method": {
            "type": "string",
            "description": "HTTP 方法",
            "enum": ["GET", "POST", "PUT", "DELETE"],
            "default": "GET",
            "title": "请求方法"
        },
        "headers": {
            "type": "object",
            "description": "请求头键值对",
            "default": {},
            "title": "请求头"
        },
        "body": {
            "type": "string",
            "description": "请求体",
            "default": "",
            "title": "请求体"
        }
    },
    "required": ["url"]
}
```

### 8.4 从函数签名自动生成 JSON Schema

新建 `agent/tools/schema_gen.py`，提供从 Python 函数签名自动提取 JSON Schema 的工具：

```python
# agent/tools/schema_gen.py
"""从 Python 函数签名自动生成 JSON Schema，用于同步到 tools 表。"""

import inspect
from typing import Any, get_type_hints


_PY_TYPE_MAP = {
    str: "string",
    int: "integer",
    float: "number",
    bool: "boolean",
    dict: "object",
    list: "array",
}


def func_to_json_schema(func: Any) -> dict:
    """从函数签名提取 JSON Schema。

    读取函数的类型注解和 docstring，生成符合 OpenAI function calling 规范的 schema。
    """
    sig = inspect.signature(func)
    hints = get_type_hints(func)

    properties = {}
    required = []

    for param_name, param in sig.parameters.items():
        if param_name == "return":
            continue

        annotation = hints.get(param_name, str)
        json_type = _PY_TYPE_MAP.get(annotation, "string")

        prop = {
            "type": json_type,
            "description": "",
            "title": param_name,
        }

        if param.default is inspect.Parameter.empty:
            required.append(param_name)
        else:
            prop["default"] = param.default

        properties[param_name] = prop

    return {
        "type": "object",
        "properties": properties,
        "required": required,
    }


def sync_tool_schemas_to_db(tools_module: Any) -> dict[str, dict]:
    """扫描 tools 模块中所有工具函数，生成 name -> schema 映射。

    用于初始化种子数据或运行时校验。
    """
    result = {}
    for name in dir(tools_module):
        if name.startswith("_"):
            continue
        obj = getattr(tools_module, name, None)
        if callable(obj) and hasattr(obj, "__module__") and "agent.tools" in str(obj.__module__):
            result[name] = func_to_json_schema(obj)
    return result
```

### 8.5 废弃 __all__ 手动维护

`agent/tools/__init__.py` 中的 `__all__` 不再需要手动维护。改为自动发现：

```python
# agent/tools/__init__.py — 改造后
"""Agent runtime tools — 通过 DB implementation 字段动态发现和加载。"""

# __all__ 已废弃，工具发现改为 DB 驱动
# 以下导入仅为向后兼容，新代码应使用 registry.resolve_agent_tools()

from agent.tools.get_datetime import get_datetime
from agent.tools.http_request import http_request
from agent.tools.kb_search import kb_search, list_knowledge_bases
from agent.tools.tavily_search import tavily_search

# 自动生成 __all__（仅用于向后兼容）
import sys
__all__ = [
    name for name, obj in list(globals().items())
    if callable(obj) and not name.startswith("_")
]
```

### 8.6 启动时同步校验

在 `init_graph()` 中增加工具表一致性校验：

```python
# agent/graph.py — init_graph() 中增加校验
async def _verify_tool_consistency():
    """启动时校验 tools 表中的 implementation 路径是否有效。"""
    from sqlalchemy import select
    from db.engine import async_session
    from db.models.tool import Tool
    from agent.tools.registry import load_tool_by_implementation

    async with async_session() as session:
        tools = (await db.execute(
            select(Tool).where(Tool.tool_type == "function", Tool.status == "enabled")
        )).scalars().all()

        for tool in tools:
            if not tool.implementation:
                logger.warning("工具 '%s' 未配置 implementation 路径", tool.name)
                continue
            fn = load_tool_by_implementation(tool.implementation)
            if fn is None:
                logger.error("工具 '%s' 的 implementation '%s' 无法加载", tool.name, tool.implementation)
```

### 8.7 统一来源后的数据流

```
tools 表（唯一真相源）
    |
    |-- implementation 字段 --> 动态加载 Python 函数 / MCP 客户端
    |-- params 字段（JSON Schema） --> 前端表单渲染 + LLM 工具描述 + 运行时校验
    |-- tool_type 字段 --> 区分 function / mcp，选择加载策略
    |
    v
agent_tools 关联表
    |
    v
AgentBuilder.with_tools() / create_subagents()
    |
    v
DeepAgent tools 参数
```

## 九、实施路线图

### 9.1 优先级与依赖关系

| 优先级 | 改进项 | 涉及文件 | 依赖 | 预估工时 | 风险 |
|--------|--------|----------|------|---------|------|
| P0 | 改进 1：工具注册表改为 DB 驱动 | `db/models/tool.py`, `agent/tools/registry.py`(新), `agent/common.py`, `agent/builders/agent_builder.py`, `agent/subagents/subagents_operate.py` | 无 | 2-3 天 | 低 — 改动范围可控，有回退方案 |
| P0 | 改进 3：Agent 配置热重载 | `agent/graph.py`, `api/agents/service.py` | 改进 1 | 1-2 天 | 中 — 并发重建需充分测试 |
| P1 | 改进 2：MCP 工具接入运行时 | `agent/tools/mcp_loader.py`(新), `agent/builders/agent_builder.py`, `agent/subagents/subagents_operate.py`, `pyproject.toml` | 改进 1 | 3-4 天 | 中 — MCP 连接稳定性、超时处理 |
| P1 | 改进 5：记忆文件一致性校验 | `api/agents/service.py` | 无 | 1-2 天 | 低 — 增量改进，不影响核心流程 |
| P2 | 改进 6：统一工具定义来源 | `agent/tools/__init__.py`, `agent/tools/schema_gen.py`(新), `agent/graph.py` | 改进 1 | 2-3 天 | 低 — 向后兼容，渐进式迁移 |
| P2 | 改进 4：Agent 版本管理 | `db/models/agent_version.py`(新), `api/agents/agents_api.py`, `api/agents/service.py`, `api/agents/schemas.py` | 改进 3 | 3-4 天 | 低 — 纯新增功能，不修改现有逻辑 |

### 9.2 分阶段实施计划

#### 第一阶段（P0，约 1 周）

目标：建立 DB 驱动的工具体系和配置热重载基础。

1. 扩展 `Tool` 模型，添加 `implementation` 和 `tool_type` 字段。
2. 编写迁移脚本，为现有 5 个内置工具填充 `implementation` 值。
3. 新建 `agent/tools/registry.py`，实现 `resolve_agent_tools()` 和 `load_tool_by_implementation()`。
4. 改造 `AgentBuilder.with_tools()` 和 `create_subagents()` 使用新注册表。
5. 重构 `graph.py` 为 `GraphManager`，实现 `invalidate()` 机制。
6. 在 `update_agent`、`add_agent_config`、`remove_agent_config`、`toggle_agent_status` 中调用 `invalidate_graph()`。

#### 第二阶段（P1，约 1.5 周）

目标：MCP 工具接入运行时 + 记忆一致性校验。

1. 添加 `langchain-mcp-adapters` 依赖。
2. 新建 `agent/tools/mcp_loader.py`，实现 MCP 工具加载和客户端缓存。
3. 在 `AgentBuilder` 和 `create_subagents()` 中集成 MCP 工具加载。
4. 在 `shutdown_graph()` 中增加 MCP 客户端清理。
5. 新建 `_sync_files_with_store()` 一致性校验函数。
6. 在 `_agent_to_info()` 和 `remove_agent_config()` 中集成一致性校验。

#### 第三阶段（P2，约 1.5 周）

目标：统一工具定义 + 版本管理。

1. 新建 `agent/tools/schema_gen.py`，实现函数签名到 JSON Schema 的自动生成。
2. 将 `Tool.params` 升级为 JSON Schema 格式，编写迁移脚本转换现有数据。
3. 改造 `agent/tools/__init__.py`，废弃手动 `__all__` 维护。
4. 在 `init_graph()` 中增加工具表一致性校验。
5. 新建 `AgentVersion` 模型和 `agent_versions` 表。
6. 在 `update_agent()` 中增加自动快照逻辑。
7. 实现版本查询和回滚 API。

### 9.3 测试计划

| 测试类型 | 范围 | 验收标准 |
|---------|------|---------|
| 单元测试 | `registry.py`, `mcp_loader.py`, `schema_gen.py` | 工具加载、MCP 连接、Schema 生成的正确性 |
| 集成测试 | `AgentBuilder` + `GraphManager` | 配置变更后 Graph 自动重建，新配置生效 |
| 回归测试 | 所有 Agent API | CRUD 接口行为不变，兼容旧调用方 |
| 压力测试 | `invalidate_graph()` 并发场景 | 多线程同时修改配置不导致死锁或数据损坏 |
| 端到端测试 | MCP 工具调用 | Agent 能成功调用 MCP 工具并返回结果 |

### 9.4 回退方案

每个改进项都设计为可独立部署和回退：

- 改进 1：`get_tool_registry()` 保留为兼容入口，回退时恢复 `__all__` 驱动。
- 改进 2：MCP 加载失败时静默跳过，不影响内置工具。
- 改进 3：`GraphManager` 的接口与旧 `_graph` 全局变量兼容，回退时恢复全局变量模式。
- 改进 4：版本管理是纯新增功能，停用后不影响现有 CRUD。
- 改进 5：一致性校验失败时返回原始列表，不影响读取流程。
- 改进 6：`__all__` 自动生成兼容旧的 `get_tool_registry()`。

## 十、假设与约定

1. **数据库引擎**：当前使用 SQLite（开发）和 PostgreSQL（生产），迁移脚本需同时兼容两者。JSON 类型已通过 `sqlalchemy.dialects.sqlite.JSON` 处理。

2. **DeepAgents 版本**：当前 `deepagents>=0.6.1`，改进方案基于 DeepAgents 的 `create_deep_agent` API，包括 `subagents`、`tools`、`skills`、`memory`、`backend`、`middleware` 参数。

3. **LangGraph Store**：记忆文件存储依赖 LangGraph Store 的 `aget` / `adelete` 接口，要求 `store` 在 `init_graph()` 时已初始化。

4. **MCP 传输模式**：支持 stdio（最常用）、SSE、streamable-http 三种模式，通过 `mcp_installations.config` 中的 `transport` 字段指定。

5. **并发安全**：`GraphManager._build_graph()` 使用 `asyncio.Lock` 保护，确保同一时刻只有一个构建过程。`invalidate()` 仅修改版本号和置空 `_graph`，是原子操作。

6. **向后兼容**：所有改造保留旧接口（`get_graph()`、`get_tool_registry()`），新旧代码可共存，支持渐进式迁移。

7. **Agent 与子智能体的关系**：主智能体（type='main'）通过 `parent_id` 管理子智能体（type='sub'），`create_subagents()` 查询所有 `type='sub' AND status='active'` 的记录并构建为 DeepAgents 的 subagents 参数。

8. **工具命名约定**：内置函数工具使用原始函数名（如 `http_request`），MCP 工具使用 `mcp__{server_name}__{tool_name}` 前缀格式，避免命名冲突。

---

> 本文档基于 Ke-Hermes（web/backend）代码库现状分析，结合 DeepAgents / LangChain / LangGraph 官方文档的最佳实践编写。所有代码示例和文件路径均基于实际代码结构，迁移脚本需根据最终实现进行调整。
