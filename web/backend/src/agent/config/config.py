import os

from dotenv import load_dotenv
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings

# 工作目录的解析规则统一在 core：知识库的上传目录兜底路径（{WORKSPACE}/docs_upload）
# 也要用它，同一条规则各算一遍迟早会算出两个不同的路径。
from core.config import get_default_workspace

load_dotenv()


def _env_bool(name: str, default: bool = False) -> bool:
    """读取布尔型环境变量（1/true/yes/on 视为真，留空回退默认值）。"""
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


# 沙箱出网模式：仅白名单 / 不受限制 / 完全禁网
SANDBOX_NETWORK_MODE_WHITELIST = "whitelist"
SANDBOX_NETWORK_MODE_ALLOW_ALL = "allow_all"
SANDBOX_NETWORK_MODE_DENY_ALL = "deny_all"
SANDBOX_NETWORK_MODES: tuple[str, ...] = (
    SANDBOX_NETWORK_MODE_WHITELIST,
    SANDBOX_NETWORK_MODE_ALLOW_ALL,
    SANDBOX_NETWORK_MODE_DENY_ALL,
)


class Settings(BaseSettings):
    # ---- Server ----
    HOST: str = os.getenv("HOST", "127.0.0.1")
    PORT: int = int(os.getenv("PORT") or 8000)
    # MCP 广场内置服务的对外基址：客户端（桌面版 / 移动端）要能访问到本服务。
    # 留空则按 HOST/PORT 推导；部署到远端时务必显式配置，否则同步给客户端的
    # MCP 地址是回环地址、客户端根本连不上（方案 P1-5）。
    MCP_PUBLIC_BASE_URL: str = os.getenv("MCP_PUBLIC_BASE_URL", "")

    @property
    def mcp_public_base_url(self) -> str:
        """MCP 服务对外基址（已去尾斜杠）。"""
        configured = (self.MCP_PUBLIC_BASE_URL or "").strip()
        if configured:
            return configured.rstrip("/")
        host = (self.HOST or "127.0.0.1").strip() or "127.0.0.1"
        return f"http://{host}:{self.PORT}"

    # ---- LLM ----
    # 对话模型不再从环境变量读取：提供商与模型由 Web 端「模型」页面维护
    # （providers / ai_models 表），默认模型可在该页面显式指定。
    # 解析入口见 agent/models/resolver.py。

    # ---- Image generation ----
    IMAGE_GEN_API_KEY: str = os.getenv("IMAGE_GEN_API_KEY", "")
    IMAGE_GEN_BASE_URL: str = os.getenv("IMAGE_GEN_BASE_URL", "")
    IMAGE_GEN_MODEL: str = os.getenv("IMAGE_GEN_MODEL", "")

    # ---- Video generation (阿里云百炼 wan3.0-video) ----
    VIDEO_GEN_API_KEY: str = os.getenv("VIDEO_GEN_API_KEY", "")
    VIDEO_GEN_BASE_URL: str = os.getenv("VIDEO_GEN_BASE_URL", "")
    VIDEO_GEN_MODEL: str = os.getenv("VIDEO_GEN_MODEL", "")

    # ---- Embeddings (DashScope) ----
    DASHSCOPE_API_KEY: str = os.getenv("DASHSCOPE_API_KEY", "")
    DASHSCOPE_EMBEDDING: str = os.getenv("DASHSCOPE_EMBEDDING", "")
    DASHSCOPE_BASE_URL: str = os.getenv("DASHSCOPE_BASE_URL", "")

    # ---- Tavily ----
    TAVILY_API_KEY: str = os.getenv("TAVILY_API_KEY", "")

    # ---- Workspace ----
    WORKSPACE: str = Field(default_factory=get_default_workspace)

    @field_validator("WORKSPACE", mode="before")
    @classmethod
    def _workspace_use_default_when_empty(cls, value: object) -> str:
        if value is None or (isinstance(value, str) and not value.strip()):
            return get_default_workspace()
        return str(value)

    SKILLS_ROOT: str = f"{WORKSPACE}/skills/"

    # ---- OpenSandBox
    OPENSANDBOX_DOMAIN: str = os.getenv("OPENSANDBOX_DOMAIN", "http://127.0.0.1:8080")
    OPENSANDBOX_API_KEY: str = os.getenv("OPENSANDBOX_API_KEY", "")
    SANDBOX_TTL_SECONDS: int = int(os.getenv("SANDBOX_TTL_SECONDS", "1800"))
    SANDBOX_CLEANUP_INTERVAL: int = int(os.getenv("SANDBOX_CLEANUP_INTERVAL", "300"))
    SANDBOX_IMAGE: str = os.getenv(
        "SANDBOX_IMAGE",
        "sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/code-interpreter:v1.0.2",
    )
    SANDBOX_CPU: str = os.getenv("SANDBOX_CPU", "2")
    SANDBOX_MEMORY: str = os.getenv("SANDBOX_MEMORY", "3Gi")
    SANDBOX_IDLE_TIMEOUT_MINUTES: int = int(
        os.getenv("SANDBOX_IDLE_TIMEOUT_MINUTES", "10")
    )
    SANDBOX_ALLOWED_DOMAINS: str = os.getenv("SANDBOX_ALLOWED_DOMAINS", "")
    SANDBOX_NETWORK_MODE: str = os.getenv(
        "SANDBOX_NETWORK_MODE", SANDBOX_NETWORK_MODE_WHITELIST
    )

    @property
    def sandbox_allowed_domains_list(self) -> list[str]:
        """解析 SANDBOX_ALLOWED_DOMAINS 为域名列表。"""
        raw = self.SANDBOX_ALLOWED_DOMAINS.strip()
        if not raw:
            return []
        return [d.strip() for d in raw.split(",") if d.strip()]

    @property
    def sandbox_network_mode(self) -> str:
        """规范化沙箱出网模式（非法值回退白名单模式）。"""
        value = (self.SANDBOX_NETWORK_MODE or "").strip().lower()
        if value in SANDBOX_NETWORK_MODES:
            return value
        return SANDBOX_NETWORK_MODE_WHITELIST

    # ---- 产物持久化（生成文件的长期存储）
    ARTIFACT_BACKEND: str = os.getenv("ARTIFACT_BACKEND", "local")
    ARTIFACT_ROOT: str = os.getenv("ARTIFACT_ROOT", "")
    ARTIFACT_MAX_FILE_MB: int = int(os.getenv("ARTIFACT_MAX_FILE_MB", "100"))
    ARTIFACT_USER_QUOTA_MB: int = int(os.getenv("ARTIFACT_USER_QUOTA_MB", "2048"))
    ARTIFACT_RETENTION_DAYS: int = int(os.getenv("ARTIFACT_RETENTION_DAYS", "30"))
    ARTIFACT_GC_INTERVAL_SECONDS: int = int(
        os.getenv("ARTIFACT_GC_INTERVAL_SECONDS", "3600")
    )
    # 后端代理下载（配图等素材）：超时、单文件上限、域名白名单（逗号分隔）
    ARTIFACT_FETCH_TIMEOUT_SECONDS: int = int(
        os.getenv("ARTIFACT_FETCH_TIMEOUT_SECONDS", "60")
    )
    ARTIFACT_FETCH_MAX_MB: int = int(
        os.getenv("ARTIFACT_FETCH_MAX_MB", os.getenv("ARTIFACT_MAX_FILE_MB", "100"))
    )
    ARTIFACT_FETCH_ALLOWED_HOSTS: str = os.getenv("ARTIFACT_FETCH_ALLOWED_HOSTS", "")
    # 视频成片单独的超时与上限（视频体积大、生成端签名有效期长，需放宽；
    # 上限对齐桌面端工作区媒体白名单的 200MB）
    ARTIFACT_FETCH_VIDEO_TIMEOUT_SECONDS: int = int(
        os.getenv("ARTIFACT_FETCH_VIDEO_TIMEOUT_SECONDS", "300")
    )
    ARTIFACT_FETCH_VIDEO_MAX_MB: int = int(
        os.getenv("ARTIFACT_FETCH_VIDEO_MAX_MB", "200")
    )

    @field_validator("ARTIFACT_ROOT", mode="before")
    @classmethod
    def _artifact_root_use_default_when_empty(cls, value: object) -> str:
        """产物存储根目录留空时默认使用 ``{WORKSPACE}/artifacts``。"""
        if value is None or (isinstance(value, str) and not value.strip()):
            return os.path.join(get_default_workspace(), "artifacts")
        return str(value)

    # ---- MinIO 对象存储（ARTIFACT_BACKEND=minio 时生效）
    ARTIFACT_MINIO_ENDPOINT: str = os.getenv("ARTIFACT_MINIO_ENDPOINT", "")
    ARTIFACT_MINIO_ACCESS_KEY: str = os.getenv("ARTIFACT_MINIO_ACCESS_KEY", "")
    ARTIFACT_MINIO_SECRET_KEY: str = os.getenv("ARTIFACT_MINIO_SECRET_KEY", "")
    ARTIFACT_MINIO_BUCKET: str = os.getenv(
        "ARTIFACT_MINIO_BUCKET", "ke-work-artifacts"
    )
    ARTIFACT_MINIO_SECURE: bool = _env_bool("ARTIFACT_MINIO_SECURE", False)
    ARTIFACT_MINIO_REGION: str = os.getenv("ARTIFACT_MINIO_REGION", "")

    # 交付目录（智能体直写 /artifacts/）在宿主上的 staging 根目录
    ARTIFACT_AGENT_ROOT: str = os.getenv("ARTIFACT_AGENT_ROOT", "")

    @field_validator("ARTIFACT_AGENT_ROOT", mode="before")
    @classmethod
    def _artifact_agent_root_use_default_when_empty(cls, value: object) -> str:
        """交付目录留空时默认使用 ``{WORKSPACE}/artifacts_agent``。"""
        if value is None or (isinstance(value, str) and not value.strip()):
            return os.path.join(get_default_workspace(), "artifacts_agent")
        return str(value)

    # ---- Database ----
    DATABASE_BACKEND: str = os.getenv("DATABASE_BACKEND", "sqlite")
    DATABASE_URL: str = os.getenv("DATABASE_URL", "")
    DATABASE_PATH: str = os.getenv("DATABASE_PATH", "")

    # ---- Checkpoint Database
    CHECKPOINT_BACKEND: str = os.getenv("CHECKPOINT_BACKEND", "sqlite")
    CHECKPOINT_DB_URL: str = os.getenv(
        "CHECKPOINT_DB_URL", "postgresql://127.0.0.1:5432/ke_hermes"
    )
    CHECKPOINT_DB_PATH: str = os.getenv("CHECKPOINT_DB_PATH", "./db/ke_hermes.db")

    # ---- Store Database
    STORE_BACKEND: str = os.getenv("STORE_BACKEND", "sqlite")
    STORE_DB_URL: str = os.getenv(
        "STORE_DB_URL", "postgresql://127.0.0.1:5432/ke_hermes"
    )
    STORE_DB_PATH: str = os.getenv("STORE_DB_PATH", "./db/ke_hermes.db")

    # ---- Encryption ----
    ENCRYPTION_KEY: str = os.getenv("ENCRYPTION_KEY", "")

    # ---- JWT ----
    JWT_SECRET_KEY: str = ""
    JWT_ACCESS_EXPIRE: int = int(os.getenv("JWT_ACCESS_EXPIRE") or 7200)
    JWT_REFRESH_EXPIRE: int = int(os.getenv("JWT_REFRESH_EXPIRE") or 604800)

    # ---- RSA ----
    RSA_KEY_SIZE: int = int(os.getenv("RSA_KEY_SIZE") or 2048)

    # ---- Rate Limit ----
    LOGIN_MAX_FAILS: int = int(os.getenv("LOGIN_MAX_FAILS") or 5)
    LOGIN_LOCK_MINUTES: int = int(os.getenv("LOGIN_LOCK_MINUTES") or 30)
    # 失败次数达到阈值后，账号登录必须先通过滑块验证
    LOGIN_CAPTCHA_AFTER_FAILS: int = int(os.getenv("LOGIN_CAPTCHA_AFTER_FAILS") or 3)
    SMS_DAILY_LIMIT: int = int(os.getenv("SMS_DAILY_LIMIT") or 5)

    # ---- Captcha ----
    CAPTCHA_EXPIRE: int = int(os.getenv("CAPTCHA_EXPIRE") or 300)
    # 登录场景验证码票据有效期（秒），一次性使用
    LOGIN_CAPTCHA_TICKET_TTL: int = int(os.getenv("LOGIN_CAPTCHA_TICKET_TTL") or 120)
    SLIDE_THRESHOLD: int = int(os.getenv("SLIDE_THRESHOLD") or 8)

    # ---- Redis ----
    REDIS_URL: str = os.getenv("REDIS_URL", "")

    # ---- OAuth ----
    OAUTH_GITHUB_CLIENT_ID: str = os.getenv("OAUTH_GITHUB_CLIENT_ID", "")
    OAUTH_GITHUB_CLIENT_SECRET: str = os.getenv("OAUTH_GITHUB_CLIENT_SECRET", "")
    OAUTH_GOOGLE_CLIENT_ID: str = ""
    OAUTH_GOOGLE_CLIENT_SECRET: str = os.getenv("OAUTH_GOOGLE_CLIENT_SECRET", "")
    OAUTH_WECHAT_CLIENT_ID: str = os.getenv("OAUTH_WECHAT_CLIENT_ID", "")
    OAUTH_WECHAT_CLIENT_SECRET: str = os.getenv("OAUTH_WECHAT_CLIENT_SECRET", "")
    OAUTH2_FRONTEND_URL: str = os.getenv(
        "OAUTH2_FRONTEND_URL", "http://localhost:5173"
    )

    # ---- SMS ----
    SMS_PROVIDER: str = os.getenv("SMS_PROVIDER", "")
    SMS_ACCESS_KEY: str = os.getenv("SMS_ACCESS_KEY", "")
    SMS_SECRET_KEY: str = os.getenv("SMS_SECRET_KEY", "")
    SMS_SIGN_NAME: str = os.getenv("SMS_SIGN_NAME", "")
    SMS_TEMPLATE_CODE: str = os.getenv("SMS_TEMPLATE_CODE", "")

    # ---- 知识库 / 向量库 ----
    # 迭代 5 T5.7：Milvus / Chroma / 文档上传目录 / 索引并发 / 知识库配额这些项
    # **已迁到 ``core.config.Settings``**（读取方全在 api/knowledge_base/，
    # 且 core 那套支持 .env.{APP_ENV} 覆盖，agent 这套只读 .env）。
    # 此处不再保留副本：同一个开关有两个出处，改一处不生效是迟早的事。
