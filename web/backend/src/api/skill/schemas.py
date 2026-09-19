"""Request and response schemas for skill upload."""
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class SkillValidationError(BaseModel):
    """A single validation error for a skill."""

    field: str
    message: str


class SkillResult(BaseModel):
    """Validation result for one extracted skill directory."""

    name: str
    valid: bool
    errors: list[SkillValidationError] = []


class SkillsUploadResponse(BaseModel):
    """Overall response from the upload_skills endpoint."""

    skills_dir: str
    total: int
    valid_count: int
    invalid_count: int
    skipped_count: int
    results: list[SkillResult]
    skipped: list[str] = []


class SkillInfo(BaseModel):
    """Single skill record for list/search responses."""

    id: str
    name: str
    valid: bool
    source: str
    description: str
    license: str
    icon: str = ""
    category: str = "custom"
    prompt: str = ""
    enabled: bool = True
    is_builtin: bool = False
    validation_errors: str = ""
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class SkillListResponse(BaseModel):
    """Paginated list of skills."""

    items: list[SkillInfo]
    total: int
    page: int
    page_size: int


class SkillUpdateRequest(BaseModel):
    """Request body for updating a skill's metadata."""

    name: str | None = None
    description: str | None = None
    icon: str | None = None
    category: str | None = None
    source: str | None = None
    prompt: str | None = None
    enabled: bool | None = None


class SkillCreateRequest(BaseModel):
    """Request body for manually creating a single skill."""

    name: str
    description: str = ""
    icon: str = "Zap"
    category: str = "custom"
    prompt: str = ""


class SkillToggleRequest(BaseModel):
    """Request body for toggling skill enabled state."""

    enabled: bool


class SkillBatchDeleteRequest(BaseModel):
    """Request body for batch-deleting skills by ID."""

    ids: list[str]


class SkillDeleteResult(BaseModel):
    """Result detail for a single skill deletion."""

    id: str
    name: str
    deleted: bool
    reason: str = ""


class SkillDeleteResponse(BaseModel):
    """Response for single or batch skill deletion."""

    deleted_count: int
    failed_count: int
    results: list[SkillDeleteResult]

class SkillManifestFile(BaseModel):
    """Single file entry inside a skill package."""

    path: str
    size: int
    sha256: str


class SkillManifestResponse(BaseModel):
    """Skill package manifest for incremental desktop sync."""

    id: str
    name: str
    dir_name: str
    hash: str
    files: list[SkillManifestFile]
    updated_at: str


class SkillRepoSourceItem(BaseModel):
    """技能仓库来源."""

    id: str
    name: str
    description: str
    authority: str
    repository: str
    homepage: str
    skills_path: str


class SkillRepoSourceListResponse(BaseModel):
    """技能仓库来源列表."""

    sources: list[SkillRepoSourceItem]


class SkillRepoSkillItem(BaseModel):
    """技能仓库榜单中的单个技能."""

    id: str
    name: str
    dir_name: str
    description: str
    category: str = "custom"
    license: str = ""
    source: str
    source_name: str
    repository: str
    popularity: int = 0
    rank: int = 0
    install_url: str = ""
    updated_at: str = ""


class SkillRepoListResponse(BaseModel):
    """技能仓库榜单响应."""

    source: str
    source_name: str
    rank_basis: str
    fetched_at: datetime
    total: int
    page: int
    page_size: int
    items: list[SkillRepoSkillItem]


class SkillRepoImportRequest(BaseModel):
    """从技能仓库导入技能的请求."""

    source: str
    skill_ids: list[str]


class SkillRepoImportResponse(BaseModel):
    """从技能仓库导入技能的结果."""

    total: int
    valid_count: int
    invalid_count: int
    skipped_count: int
    results: list[SkillResult]
    skipped: list[str] = []
