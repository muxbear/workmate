"""专家管理 API 的请求与响应 Schema 定义。."""
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class McpConfigItem(BaseModel):
    """单个 MCP 配置项。."""
    mcp_tool_id: str
    config: dict = {}
    enabled: bool = True


class ToolBrief(BaseModel):
    """工具简要信息。."""
    id: str
    name: str
    display_name: str
    tool_type: str  # function | mcp | plugin
    category: str
    icon: str = ""

    model_config = ConfigDict(from_attributes=True)


class ExpertSkillBrief(BaseModel):
    """技能简要信息。."""
    id: str
    name: str
    description: str
    category: str
    icon: str
    enabled: bool

    model_config = ConfigDict(from_attributes=True)


class McpConfigBrief(BaseModel):
    """MCP 配置简要信息。."""
    mcp_tool_id: str
    mcp_tool_name: str
    config: dict
    enabled: bool


class ExpertInfo(BaseModel):
    """专家完整信息（列表 + 详情共用）。."""
    id: str
    name: str
    title: str
    description: str
    category: str
    tags: list[str]
    icon: str
    color: str
    initials: str
    avatar_url: str | None = None
    rating: float
    usage_count: int
    featured: bool
    scene: str | None = None
    sort_order: int
    is_published: bool
    status: str
    system_prompt: str
    provider_id: str | None = None
    model_id: str | None = None
    model_name: str | None = None
    model_type: str | None = None
    prompt_template: str = ""
    expertise_areas: list[str] = []
    tools: list[ToolBrief] = []
    skills: list[ExpertSkillBrief] = []
    mcp_configs: list[McpConfigBrief] = []
    files: list[str] = []
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ExpertListResponse(BaseModel):
    """分页列表响应。."""
    items: list[ExpertInfo]
    total: int
    page: int
    page_size: int


class ExpertCreateRequest(BaseModel):
    """创建专家请求。."""
    name: str = Field(min_length=1, max_length=128)
    title: str = Field(max_length=128)
    description: str = ""
    system_prompt: str = ""
    category: str = "custom"
    tags: list[str] = []
    icon: str = ""
    color: str = ""
    initials: str = ""
    provider_id: str | None = None
    model_id: str | None = None
    tool_names: list[str] = []
    skill_ids: list[str] = []
    mcp_configs: list[McpConfigItem] = []
    featured: bool = False
    scene: str | None = None


class ExpertUpdateRequest(BaseModel):
    """更新专家基础信息。."""
    name: str = Field(min_length=1, max_length=128)
    title: str = Field(max_length=128)
    description: str = ""
    system_prompt: str = ""
    provider_id: str | None = None
    model_id: str | None = None


class ExpertProfileUpdateRequest(BaseModel):
    """更新展示元数据（部分更新，仅传入字段被更新）。."""
    title: str | None = None
    category: str | None = None
    tags: list[str] | None = None
    icon: str | None = None
    color: str | None = None
    initials: str | None = None
    avatar_url: str | None = None
    featured: bool | None = None
    scene: str | None = None
    sort_order: int | None = None
    is_published: bool | None = None


class ExpertConfigUpdateRequest(BaseModel):
    """批量更新配置（模型 + 提示词 + 工具 + 技能 + MCP）。.

    None 表示不更新该字段，[] 表示清空。
    """
    system_prompt: str | None = None
    provider_id: str | None = None
    model_id: str | None = None
    tool_names: list[str] | None = None
    skill_ids: list[str] | None = None
    mcp_configs: list[McpConfigItem] | None = None


class ExpertCategoryInfo(BaseModel):
    """分类信息。."""
    key: str
    label: str
    count: int


class FeaturedScene(BaseModel):
    """精选场景定义。."""
    id: str
    label: str
    color: str
    expert_ids: list[str] = []


class FeaturedSceneResponse(BaseModel):
    """精选场景响应。."""
    scenes: list[FeaturedScene]
    experts: list[ExpertInfo]


class ExpertSyncItem(BaseModel):
    """同步用专家数据（适配桌面版 ExpertPage）。."""
    id: str
    name: str
    title: str
    desc: str
    category: str
    tags: list[str]
    color: str
    initials: str
    icon: str
    avatar_url: str | None = None
    rating: float
    users: str
    system_prompt: str
    scene: str | None = None
    sort_order: int
    provider_id: str | None = None
    model_id: str | None = None
    model_name: str | None = None
    model_type: str | None = None
    tools: list[ToolBrief] = []
    skills: list[ExpertSkillBrief] = []
    mcp_configs: list[McpConfigBrief] = []
    prompt_template: str = ""
    expertise_areas: list[str] = []


class ExpertSyncListResponse(BaseModel):
    """同步列表响应。."""
    items: list[ExpertSyncItem]
    total: int
    synced_at: int
