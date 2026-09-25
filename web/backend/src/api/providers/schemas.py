"""Request and response schemas for provider and model management."""
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator

# ---- 模型参数 ----

class ModelParamSchema(BaseModel):
    """单个模型默认参数。"""

    key: str
    label: str
    value: float | str
    min: float | None = None
    max: float | None = None
    step: float | None = None
    type: str  # number | text | select
    options: list[str] | None = None


# ---- 模型请求 ----

class ModelCreateRequest(BaseModel):
    """创建模型的请求体。

    下列规格字段均为可选：留空表示未声明，不做推断。
    """

    name: str = Field(min_length=1, max_length=128)
    display_name: str = Field(min_length=1, max_length=128)
    type: str = Field(min_length=1, max_length=16)
    status: str = "active"
    context_window: int | None = None
    max_input_tokens: int | None = Field(default=None, ge=0)
    max_output_tokens: int | None = Field(default=None, ge=0)
    #: 向量维度——仅 embedding 模型有意义；留空时知识库首次调用会探测并落库（T4.4）
    dim: int | None = Field(default=None, ge=1, le=65536)
    rpm: int | None = Field(default=None, ge=0)
    tpm: int | None = Field(default=None, ge=0)
    api_base: str | None = Field(default=None, max_length=512)
    description: str = ""
    release_date: str | None = None
    params: list[ModelParamSchema] = []


class ModelUpdateRequest(BaseModel):
    """更新模型的请求体。"""

    name: str = Field(min_length=1, max_length=128)
    display_name: str = Field(min_length=1, max_length=128)
    type: str = Field(min_length=1, max_length=16)
    status: str = "active"
    context_window: int | None = None
    max_input_tokens: int | None = Field(default=None, ge=0)
    max_output_tokens: int | None = Field(default=None, ge=0)
    #: 向量维度——仅 embedding 模型有意义；留空时知识库首次调用会探测并落库（T4.4）
    dim: int | None = Field(default=None, ge=1, le=65536)
    rpm: int | None = Field(default=None, ge=0)
    tpm: int | None = Field(default=None, ge=0)
    api_base: str | None = Field(default=None, max_length=512)
    call_count: int = 0
    description: str = ""
    release_date: str | None = None
    params: list[ModelParamSchema] = []


# ---- 模型响应 ----

class ModelResponse(BaseModel):
    """模型响应体（与前端 AIModel 接口对齐）。"""

    id: str
    name: str
    display_name: str
    type: str
    status: str
    context_window: int | None = None
    max_input_tokens: int | None = None
    max_output_tokens: int | None = None
    dim: int | None = Field(default=None, ge=1, le=65536)
    rpm: int | None = None
    tpm: int | None = None
    api_base: str | None = None
    call_count: int = 0
    description: str
    release_date: str | None = None
    params: list[ModelParamSchema] = []
    sort_order: int = 0
    # 是否为全局默认对话模型。仅由 PATCH .../models/{id}/default 设置，
    # 不接受在创建/更新请求体里传入（避免绕过单默认不变式）。
    is_default: bool = False
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# ---- 提供商请求 ----

class ProviderCreateRequest(BaseModel):
    """创建提供商的请求体。"""

    name: str = Field(min_length=1, max_length=128)
    logo: str = "🤖"
    api_base: str = Field(default="", max_length=512)
    response_url: str = Field(default="", max_length=512)
    anthropic_url: str = Field(default="", max_length=512)
    api_key: str = ""
    description: str = ""
    website: str = ""

    @model_validator(mode="after")
    def _check_endpoint(self) -> "ProviderCreateRequest":
        if not (self.api_base.strip() or self.response_url.strip() or self.anthropic_url.strip()):
            raise ValueError("至少配置一个协议地址")
        return self


class ProviderUpdateRequest(BaseModel):
    """更新提供商的请求体。"""

    name: str = Field(min_length=1, max_length=128)
    logo: str = "🤖"
    api_base: str = Field(default="", max_length=512)
    response_url: str = Field(default="", max_length=512)
    anthropic_url: str = Field(default="", max_length=512)
    api_key: str = ""
    status: str = "unconfigured"
    description: str = ""
    website: str = ""

    @model_validator(mode="after")
    def _check_endpoint(self) -> "ProviderUpdateRequest":
        if not (self.api_base.strip() or self.response_url.strip() or self.anthropic_url.strip()):
            raise ValueError("至少配置一个协议地址")
        return self


# ---- 提供商响应 ----

class ProviderReorderRequest(BaseModel):
    """提供商排序请求体。"""

    provider_ids: list[str] = Field(min_length=1)


class ModelReorderRequest(BaseModel):
    """模型排序请求体。"""

    model_ids: list[str] = Field(min_length=1)


class ProviderResponse(BaseModel):
    """提供商响应体（含嵌套模型列表，与前端 Provider 接口对齐）。"""

    id: str
    name: str
    logo: str
    status: str
    api_base: str
    response_url: str
    anthropic_url: str
    sort_order: int
    api_key: SecretStr
    description: str
    website: str
    models: list[ModelResponse] = []
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
