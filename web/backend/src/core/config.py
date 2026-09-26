"""应用配置：pydantic-settings 读取 .env（单例模式，lru_cache）."""

import os
from functools import lru_cache
from pathlib import Path

from dotenv import dotenv_values
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# 后端包根目录（backend/）：默认路径以它为锚，不依赖启动目录
_BACKEND_ROOT = Path(__file__).resolve().parents[2]

# .env 绝对路径：config.py 位于 src/core/，.env 在 parents[2]
_ENV_FILE = _BACKEND_ROOT / ".env"

# 先确定运行环境：系统环境变量优先，其次 .env 中的 APP_ENV，缺省为 dev
# 用 dotenv_values 仅读取不注入 os.environ，避免环境专属文件无法覆盖 .env
_ENV_VALUES = dotenv_values(_ENV_FILE)
_APP_ENV = (os.getenv("APP_ENV") or _ENV_VALUES.get("APP_ENV") or "dev").strip().lower()

# 环境专属配置文件：存在时覆盖 .env（如 .env.prod），实现按环境差异化配置
_ENV_FILE_BY_ENV = _ENV_FILE.with_name(f".env.{_APP_ENV}")
_ENV_FILES: tuple[Path, ...] = (
    (_ENV_FILE, _ENV_FILE_BY_ENV) if _ENV_FILE_BY_ENV.exists() else (_ENV_FILE,)
)


def get_default_workspace() -> str:
    """返回工作目录（``WORKSPACE``）：环境变量非空时用它，否则落在 ``backend/workspace``。

    放在 core 而不是 agent：知识库的上传目录兜底路径（``{WORKSPACE}/docs_upload``）
    也要用它——同一条规则各算一遍，迟早会算出两个不同的路径。
    """
    env = os.getenv("WORKSPACE", "").strip()
    if env:
        return os.path.abspath(env)
    return str(_BACKEND_ROOT / "workspace")


class Settings(BaseSettings):
    """从 .env 读取的应用配置."""

    model_config = SettingsConfigDict(
        env_file=_ENV_FILES,
        env_file_encoding="utf-8",
        extra="ignore",
    )

    HOST: str = "127.0.0.1"
    PORT: int = 8001
    APP_ENV: str = _APP_ENV
    DATABASE_URL: str = "postgresql+psycopg://<user>:<password>@<ip>:<port>/spes"
    JWT_SECRET_KEY: str = "please-change-me"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 120
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    CORS_ORIGINS: str = ""

    # ---- 知识库 / 向量库（迭代 5 T5.7）----
    # 这些项此前定义在 ``agent/config/config.py``，但读取方全在 ``api/knowledge_base/``。
    # 两套配置并存的实际后果是 ``.env.{APP_ENV}`` 的环境覆盖对知识库不生效（agent 那套
    # 只读 .env），且同一个开关有两个出处。现统一到这里，agent 侧不再保留副本。
    VECTOR_DB_BACKEND: str = "milvus"
    MILVUS_URI: str = "http://localhost:19530"
    MILVUS_USER: str = "root"
    #: **故意没有默认值**：Milvus 的出厂口令（root/Milvus）是公开的，把它留作默认值
    #: 等于让每一次"忘了配"的部署都用弱口令跑起来。缺失时初始化向量库会带明确指引
    #: 地失败（见 ``facade``），而不是静默连上一个弱口令实例。
    MILVUS_PASSWORD: str = ""
    MILVUS_DEFAULT_DB: str = "ke_hermes"
    CHROMA_HOST: str = "localhost"
    #: Chroma 服务端默认端口就是 8000。这里曾写 8001，恰好与本应用自身端口
    #: （``PORT``，默认 8001）重合——本地起一个 Chroma 会直接把应用端口抢走。
    CHROMA_PORT: int = 8000
    CHROMA_PERSIST_DIR: str = "./chroma_data"
    #: 文档上传根目录；留空按 ``{WORKSPACE}/docs_upload`` 解析（见 doc_upload_dir）
    DOC_UPLOAD_DIR: str = ""
    INDEXING_MAX_CONCURRENT: int = 3
    # ---- 知识库配额（T5.3）----
    # 0 表示不限。默认放宽：限额是"按部署环境决定"的策略，升级时默认收紧会把存量
    # 用户直接挡在门外；需要限额的部署在 .env 里显式配置。
    KB_MAX_PER_USER: int = 0
    KB_MAX_DOCS_PER_KB: int = 0
    #: 每用户知识库总占用上限（MB）
    KB_MAX_STORAGE_MB_PER_USER: int = 0
    #: 单个文件大小上限（MB）
    KB_MAX_FILE_MB: int = 100
    #: 粘贴文本建文档的大小上限（KB）。与"文件大小"分开：粘贴是手输入，1MB 文本
    #: 已约合 50 万汉字，远超任何真实场景
    KB_MAX_PASTE_KB: int = 1024

    # ---- URL / 网页导入（T6.1）----
    #: 允许导入的域名白名单（逗号分隔，支持 *.example.com）。
    #: **留空 = 该功能不可用（默认拒绝）**——与 SANDBOX_ALLOWED_DOMAINS 同取向，
    #: 而**与 `asset_fetcher._host_allowed`（空即放行）相反**：那是素材代理下载，
    #: 自建部署合法地从内网拉图是常态；这里是"让服务器去访问用户给的任意网址"，
    #: 性质不同，别为了"一致"把这条改成放行。
    KB_URL_IMPORT_ALLOWED_HOSTS: str = ""
    #: 单页字节上限（MB）
    KB_URL_IMPORT_MAX_MB: int = 10
    #: 单次抓取的墙钟上限（秒，含全部重定向跳）
    KB_URL_IMPORT_TIMEOUT_SECONDS: float = 15.0
    #: 重定向跳数上限
    KB_URL_IMPORT_MAX_REDIRECTS: int = 3
    #: 允许访问的端口（逗号分隔），默认仅 80/443
    KB_URL_IMPORT_ALLOWED_PORTS: str = "80,443"

    @field_validator("APP_ENV", mode="before")
    @classmethod
    def _normalize_app_env(cls, value: object) -> str:
        """将 APP_ENV 归一化为小写，保证环境判断不受大小写影响."""
        return str(value).strip().lower() if value else "dev"

    @property
    def cors_origins_list(self) -> list[str]:
        """将 CORS_ORIGINS 逗号分隔字符串解析为列表."""
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def doc_upload_dir(self) -> str:
        """解析后的文档上传根目录（留空时落在 ``{WORKSPACE}/docs_upload``）."""
        raw = self.DOC_UPLOAD_DIR.strip()
        if raw:
            return os.path.abspath(raw)
        return os.path.join(get_default_workspace(), "docs_upload")

    @property
    def kb_url_import_allowed_hosts_list(self) -> list[str]:
        """URL 导入的域名白名单列表；**为空表示该功能不可用**."""
        return [h.strip() for h in self.KB_URL_IMPORT_ALLOWED_HOSTS.split(",") if h.strip()]

    @property
    def kb_url_import_allowed_ports_list(self) -> list[int]:
        """URL 导入允许的端口列表（解析失败或为空时回退默认 80/443）."""
        ports = [
            int(p) for p in self.KB_URL_IMPORT_ALLOWED_PORTS.split(",")
            if p.strip().isdigit()
        ]
        return ports or [80, 443]


@lru_cache
def get_settings() -> Settings:
    """返回全局唯一的 Settings 实例."""
    return Settings()
