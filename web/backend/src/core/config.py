"""应用配置：pydantic-settings 读取 .env（单例模式，lru_cache）."""

import os
from functools import lru_cache
from pathlib import Path

from dotenv import dotenv_values
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# .env 绝对路径：不依赖启动目录（config.py 位于 src/core/，.env 在 parents[2]）
_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"

# 先确定运行环境：系统环境变量优先，其次 .env 中的 APP_ENV，缺省为 dev
# 用 dotenv_values 仅读取不注入 os.environ，避免环境专属文件无法覆盖 .env
_ENV_VALUES = dotenv_values(_ENV_FILE)
_APP_ENV = (os.getenv("APP_ENV") or _ENV_VALUES.get("APP_ENV") or "dev").strip().lower()

# 环境专属配置文件：存在时覆盖 .env（如 .env.prod），实现按环境差异化配置
_ENV_FILE_BY_ENV = _ENV_FILE.with_name(f".env.{_APP_ENV}")
_ENV_FILES: tuple[Path, ...] = (
    (_ENV_FILE, _ENV_FILE_BY_ENV) if _ENV_FILE_BY_ENV.exists() else (_ENV_FILE,)
)


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
    LLM_DEFAULT_MODEL: str = ""
    LLM_BASE_URL: str = ""
    LLM_DEFAULT_API_KEY: str = ""
    CORS_ORIGINS: str = ""

    @field_validator("APP_ENV", mode="before")
    @classmethod
    def _normalize_app_env(cls, value: object) -> str:
        """将 APP_ENV 归一化为小写，保证环境判断不受大小写影响."""
        return str(value).strip().lower() if value else "dev"

    @property
    def cors_origins_list(self) -> list[str]:
        """将 CORS_ORIGINS 逗号分隔字符串解析为列表."""
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    """返回全局唯一的 Settings 实例."""
    return Settings()
