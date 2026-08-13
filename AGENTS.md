# WorkMate

WorkMate 是一个多端 AI 智能体项目，包含桌面版、移动版和 Web 版三个客户端。

## 项目结构

- `desktop/`：桌面版（Electron 39 + Vue 3 + TypeScript + DeepAgents），本地优先（SQLite），可选云端模式（PostgreSQL + HTTP API）。
- `mobile/`：移动版（HarmonyOS / DevEco Studio + hvigor）。
- `web/`：Web 版（前后端分离）。
  - `frontend/`：Vue 3 + Vite + TypeScript + Element Plus + Pinia。
  - `backend/`：Python FastAPI + LangGraph + DeepAgents。

各子项目有独立的 `AGENTS.md`，进入对应目录开发时请优先遵循其中的技术栈、命令和约定。

## 通用约定

- 始终使用中文与用户交流。
- 仓库内的代码注释、文档、提交信息以中文为主。
- 修改前先阅读目标子目录的 `AGENTS.md` 与 `README`。
- 不要提交密钥、环境变量文件、构建产物和依赖目录。
