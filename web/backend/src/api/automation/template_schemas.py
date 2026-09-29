"""定时任务模板 API Schema.

模板是自动化任务的一份完整预设，字段与 `AutomationTaskDraft` 基本一致（复用
`PromptPart` / `AutomationSchedule`，排期校验口径不会分叉），额外多了：

- ``category``：类型，取值来自「参数配置」的 ``schedule_template_type`` 分组；
- ``version``：语义化版本号，编辑时默认递增次版本、也允许手工指定。

请求体里的 ``version`` 允许缺省：缺省表示「由服务端兜底递增次版本」，显式传值
（包括手工改过的号）则以传入值为准——与专家版本的落地语义一致。
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from api.automation.schemas import AutomationSchedule, CamelModel, PromptPart

#: 语义化版本号：主版本.次版本.修订号，允许预发布标识与构建元数据
_VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+([-+].+)?$")


class AutomationTemplateDraft(CamelModel):
    """新建或更新定时任务模板的请求体."""

    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=2000)
    icon: str = Field(default="⏰", max_length=16)
    category: str = Field(default="", max_length=32)
    version: str | None = Field(default=None, max_length=32)
    prompt_text: str = Field(default="", max_length=20000)
    prompt_parts: list[PromptPart] = Field(default_factory=list, max_length=50)
    schedule: AutomationSchedule
    model: str | None = Field(default=None, max_length=128)
    custom_model_id: str | None = Field(default=None, max_length=128)
    provider_id: str | None = Field(default=None, max_length=36)
    model_id: str | None = Field(default=None, max_length=36)
    expert_id: str | None = Field(default=None, max_length=36)
    expert_name: str | None = Field(default=None, max_length=128)
    context_mode: Literal["default", "files", "knowledge"] = "default"
    skill_ids: list[str] = Field(default_factory=list, max_length=50)
    kb_ids: list[str] = Field(default_factory=list, max_length=20)
    workspace_id: str | None = Field(default=None, max_length=128)
    workspace_name: str | None = Field(default=None, max_length=128)
    allow_network: bool = False
    allow_shell: bool = False
    full_access: bool = False

    @field_validator("version")
    @classmethod
    def _validate_version(cls, value: str | None) -> str | None:
        """版本号要么不传（服务端兜底），要么必须是合法的语义化版本号。."""
        if value is None or value == "":
            return None
        if not _VERSION_PATTERN.match(value):
            raise ValueError("版本号需为「主版本.次版本.修订号」格式，如 1.0.0")
        return value

    @model_validator(mode="after")
    def _validate_content(self) -> AutomationTemplateDraft:
        """模板要能直接生成任务，因此提示词与任务草稿同口径地非空。."""
        has_text = bool((self.prompt_text or "").strip())
        has_file = any(
            part.type == "file" and part.attachment_id for part in self.prompt_parts
        )
        if not has_text and not has_file:
            raise ValueError("请先填写模板描述或提示词")
        return self


class AutomationTemplateResponse(AutomationTemplateDraft):
    """定时任务模板响应体."""

    id: str
    version: str
    created_by: str = ""
    freq_summary: str
    validity_summary: str
    created_at: int
    updated_at: int


class AutomationTemplateListResponse(BaseModel):
    """分页列表响应.

    分页信封用 snake_case ``page_size``（与专家/工具/技能列表一致，前端也按这个名字读），
    里面的 `items` 仍是 camelCase 的领域对象——请求参数同样是 ``page_size``，
    整套分页口径保持统一。
    """

    model_config = ConfigDict(from_attributes=True)

    items: list[AutomationTemplateResponse]
    total: int
    page: int
    page_size: int
