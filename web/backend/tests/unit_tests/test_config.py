"""Settings 配置行为测试。

对话模型配置（原 ``DEEPSEEK_API_KEY`` / ``DEEPSEEK_MODEL`` / ``DEEPSEEK_BASE_URL``）
已移除：模型来源改为 Web 端「模型」页面（providers / ai_models），
由 ``agent.models.resolver`` 解析。这里既测通用配置行为，也充当
「模型配置不得再回到环境变量」的回归护栏。
"""

import pytest

from agent.config.config import Settings

REMOVED_MODEL_ENV_FIELDS = (
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_MODEL",
    "DEEPSEEK_BASE_URL",
)


@pytest.mark.parametrize("field", REMOVED_MODEL_ENV_FIELDS)
def test_model_env_fields_are_gone(field):
    """回归护栏：这些字段不得重新出现在 Settings 中。"""
    assert field not in Settings.model_fields


def test_residual_model_env_var_is_ignored(monkeypatch):
    """即使部署环境的 .env 里残留 DEEPSEEK_*，Settings 也不再接受它们。"""
    monkeypatch.setenv("DEEPSEEK_MODEL", "deepseek-v4-pro")

    s = Settings()

    for field in REMOVED_MODEL_ENV_FIELDS:
        assert not hasattr(s, field)


def test_server_env_override(monkeypatch):
    """HOST / PORT 可被环境变量覆盖。

    注意：不要断言内置默认值（8000 / 127.0.0.1）——字段默认值是在
    ``agent.config.config`` 导入时由 ``os.getenv`` 计算出来的，彼时
    ``load_dotenv()`` 已把本地 .env 写进 ``os.environ``，因此默认值会被
    部署环境改写。这里只断言「环境变量优先」这一稳定契约。
    """
    monkeypatch.setenv("HOST", "0.0.0.0")
    monkeypatch.setenv("PORT", "9999")

    s = Settings()

    assert s.HOST == "0.0.0.0"
    assert s.PORT == 9999


def test_env_override(monkeypatch):
    """环境变量仍能覆盖 embedding 等未移除的配置项。"""
    monkeypatch.setenv("DASHSCOPE_API_KEY", "sk-dashscope-key")
    monkeypatch.setenv("DASHSCOPE_EMBEDDING", "text-embedding-v9")

    s = Settings()

    assert s.DASHSCOPE_API_KEY == "sk-dashscope-key"
    assert s.DASHSCOPE_EMBEDDING == "text-embedding-v9"


def test_base_url_defaults(monkeypatch):
    """DASHSCOPE_BASE_URL 等地址类配置可显式覆盖。"""
    monkeypatch.delenv("DASHSCOPE_BASE_URL", raising=False)

    s = Settings(
        DASHSCOPE_API_KEY="test",
        DASHSCOPE_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1",
    )

    assert s.DASHSCOPE_BASE_URL == "https://dashscope.aliyuncs.com/compatible-mode/v1"
