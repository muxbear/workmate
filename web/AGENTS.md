# WorkMate Web 版（ke-hermes）

通用智能体服务平台，前后端分离架构。

## 目录结构

- `backend/`：Python FastAPI + DeepAgents 智能体后端。
- `frontend/`：Vue 3 + Vite + Element Plus 前端。
- `docs/`：项目文档。

## 启动

| 端 | 包管理 | 启动命令 |
| --- | --- | --- |
| backend | uv（pyproject.toml） | `cd backend && uv run python run.py` |
| frontend | npm | `cd frontend && npm run dev` |

- 前端默认 `http://localhost:5173`，`/api` 代理到后端 `http://127.0.0.1:8001`。

详细约定见 `frontend/AGENTS.md` 与 `backend/AGENTS.md`。
