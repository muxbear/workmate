"""桌面端模型同步接口契约."""

from pydantic import BaseModel, Field


class ModelSyncPlan(BaseModel):
    """桌面端提供商计划."""
    type: str = '自定义 API'


class ModelSyncProvider(BaseModel):
    """桌面端提供商记录."""
    id: str
    name: str
    logo: str
    default_url: str = Field(serialization_alias='defaultUrl')
    response_url: str = Field(default='', serialization_alias='responseUrl')
    anthropic_url: str = Field(default='', serialization_alias='anthropicUrl')
    plans: list[ModelSyncPlan] = []
    models: list[str] = []


class ModelSyncModel(BaseModel):
    """桌面端自定义模型记录."""
    id: str
    name: str
    vendor: str
    url: str
    api_key: str = Field(serialization_alias='apiKey')
    protocol: str = 'openai-chat'
    supports_tool_call: bool = Field(serialization_alias='supportsToolCall')
    supports_images: bool = Field(serialization_alias='supportsImages')
    supports_reasoning: bool = Field(serialization_alias='supportsReasoning')


class ModelSyncResponse(BaseModel):
    """模型同步完整快照."""
    version: int
    providers: list[ModelSyncProvider]
    models: list[ModelSyncModel]
    synced_at: int
