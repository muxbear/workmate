# ke-hermes 后端

基于 FastAPI + LangGraph 的 Python 智能体后端。

## 技术栈

FastAPI + Uvicorn、DeepAgents/LangGraph、DeepSeek LLM、DashScope Embeddings、SQLAlchemy async + aiosqlite（可换 PostgreSQL）、OpenSandbox 沙箱、JWT + bcrypt + RSA 加密、Redis（可选，自动降级 MemoryStore）、uv 包管理。

## 常用命令

在 `web/backend/` 目录下执行：

```bash
uv sync                    # 安装依赖
uv run python run.py       # 启动开发服务器（含热重载）
uv run pytest              # 测试
uv run ruff check .        # lint
uv run ruff format .       # 格式化
uv run mypy --strict src/  # 类型检查
```

## 目录结构

`src/` 下：`server.py`（FastAPI 入口）、`api/`（路由层）、`core/`（JWT/bcrypt/RSA、Store、响应格式）、`agent/`（LangGraph 图与工具）、`db/`（ORM 模型与种子数据）。

## 规范

- 命名 snake_case（文件/函数/变量）、PascalCase（类）。
- ruff（pycodestyle + pyflakes + isort + pydocstyle），Google 风格 docstring，首行为祈使句。
- mypy strict，所有函数标注返回类型。
- 导入顺序：标准库 → 第三方 → 本地。

## 环境变量

参考 `.env.example`。关键项：`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`、`DATABASE_URL`、`JWT_SECRET_KEY`（留空则自动生成并持久化到 `.jwt_secret`）、`REDIS_URL`、`RSA_KEY_SIZE`。切勿提交 `.env`、`.jwt_secret`、`.rsa_key`、`.fernet_key`。
