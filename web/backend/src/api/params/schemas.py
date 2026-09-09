"""Parameter management API schemas."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

ParamType = Literal["group", "string", "number", "boolean", "json"]


class CamelCaseModel(BaseModel):
    """Base model that serializes responses using camelCase aliases."""

    def model_dump(self, **kwargs: Any) -> dict[str, Any]:
        """Serialize response models using camelCase aliases."""
        kwargs.setdefault("by_alias", True)
        return super().model_dump(**kwargs)


class ParamCreateRequest(BaseModel):
    """Create a system parameter."""

    model_config = ConfigDict(populate_by_name=True)

    param_code: str = Field(min_length=1, max_length=128, alias="paramCode")
    parent_code: str | None = Field(default=None, alias="parentCode")
    param_label: str = Field(min_length=1, max_length=128, alias="paramLabel")
    param_name: str = Field(min_length=1, max_length=128, alias="paramName")
    param_value: str | None = Field(default=None, alias="paramValue")
    param_type: ParamType = Field(default="string", alias="paramType")
    description: str = Field(default="", max_length=512)


class ParamUpdateRequest(BaseModel):
    """Update a system parameter. Only provided fields are applied."""

    model_config = ConfigDict(populate_by_name=True)

    param_code: str | None = Field(
        default=None, min_length=1, max_length=128, alias="paramCode"
    )
    parent_code: str | None = Field(default=None, alias="parentCode")
    param_label: str | None = Field(
        default=None, min_length=1, max_length=128, alias="paramLabel"
    )
    param_name: str | None = Field(
        default=None, min_length=1, max_length=128, alias="paramName"
    )
    param_value: str | None = Field(default=None, alias="paramValue")
    param_type: ParamType | None = Field(default=None, alias="paramType")
    description: str | None = Field(default=None, max_length=512)


class ParamReorderRequest(BaseModel):
    """Reorder sibling parameters within the same level."""

    model_config = ConfigDict(populate_by_name=True)

    scope: Literal["parents", "children"]
    parent_code: str | None = Field(default=None, alias="parentCode")
    ids: list[str] = Field(min_length=1)


class ParamResponse(CamelCaseModel):
    """System parameter response projection."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    param_code: str = Field(serialization_alias="paramCode")
    parent_code: str | None = Field(default=None, serialization_alias="parentCode")
    param_label: str = Field(serialization_alias="paramLabel")
    param_name: str = Field(serialization_alias="paramName")
    param_value: str | None = Field(default=None, serialization_alias="paramValue")
    param_type: str = Field(serialization_alias="paramType")
    description: str = Field(default="", serialization_alias="description")
    child_count: int = Field(default=0, serialization_alias="childCount")
    sort_order: int = Field(default=0, serialization_alias="sortOrder")
    created_at: datetime = Field(serialization_alias="createdAt")
    updated_at: datetime = Field(serialization_alias="updatedAt")
