# WorkMate 桌面版（ke-work）

Electron 39 + Vue 3 + DeepAgents 的桌面 AI 智能体工作台。本地优先（SQLite），可选云端模式（PostgreSQL + HTTP API）。

## 常用命令

在 `desktop/` 目录下执行：

```bash
npm install            # 安装依赖
npm run dev            # 开发模式（HMR）
npm run typecheck      # tsc（main/preload）+ vue-tsc（renderer）
npm run lint           # ESLint
npm run format         # Prettier（无分号、单引号、无尾逗号）
npm test               # vitest：unit + integration + security
npm run test:e2e       # 先 build 再跑 Playwright
npm run build          # typecheck + electron-vite build -> out/
npm run build:unpack   # 未打包产物（本地验证）
```

## 架构要点

- 严格三层：`src/renderer`（Vue 3 + Pinia）→ `src/preload`（contextBridge 暴露 `window.api`）→ `src/main`（Node）。
- 主进程是权威：会话校验、工作空间解析、agent 执行都在主进程；渲染层只传 ID，不传路径或权限。
- Repository 策略模式：业务服务依赖 `src/main/database/interfaces/` 接口，`DataSourceFactory` 按工作模式（`src/main/mode/work-mode.ts`）注入 SQLite 或云端实现。
- Agent 管线：`AgentManager`（生命周期单例）→ `AgentBuilder` → `invokeSendMessage`；消息体存于 LangGraph checkpoint，`thread_id = buildThreadId(userId, conversationId)`。
- 流式 IPC：`agent:send` 校验入参 → `AbortController` 按窗口 id 管理 → `agent:stream-*` 事件流。
- 安全：密码 bcrypt + JWT（secret 存 `secrets.bin`，safeStorage 加密）；受保护 IPC 路由经 `session.requireUserId()`。

## 测试约定

- `tests/unit` 镜像 `src/main` 目录；`tests/integration/database` 覆盖真实 SQLite；`tests/security` 是安全回归。
- 单元测试不得访问网络或真实用户目录。
- e2e 用 Playwright `_electron`，通过 `KE_WORK_HOME` + `KE_WORK_USER_DATA` 隔离到临时目录。

## 环境变量

参考 `.env.sample`：`DEEPSEEK_BASE_URL`、`DEEPSEEK_API_KEY` 必填；云端模式可选 `CLOUD_API_BASE_URL`、`CLOUD_POSTGRES_CONN_STRING`。切勿提交真实密钥。
