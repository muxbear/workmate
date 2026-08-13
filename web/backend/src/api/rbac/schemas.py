"""RBAC API schemas — request and response models."""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class CamelCaseModel(BaseModel):
    """Base model that serializes using aliases (camelCase output)."""

    def model_dump(self, **kwargs: Any) -> dict[str, Any]:
        kwargs.setdefault("by_alias", True)
        return super().model_dump(**kwargs)


# ── Permission Resource schemas ──────────────────────────────────


class PermResourceResponse(CamelCaseModel):
    """Permission resource node."""

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    parent_id: str | None = Field(default=None, serialization_alias="parentId")
    type: str  # catalog | menu | button
    label: str
    perm_key: str = Field(serialization_alias="permKey")
    path: str | None = None
    icon: str = "Folder"
    sort_order: int = Field(default=0, serialization_alias="sortOrder")
    status: str = "active"  # active | hidden | disabled
    is_builtin: bool = Field(default=False, serialization_alias="isBuiltin")
    description: str = ""
    btn_variant: str | None = Field(default=None, serialization_alias="btnVariant")
    danger: bool = False


class ResourceCreateRequest(BaseModel):
    """Create a permission resource."""

    parent_id: str | None = Field(default=None, alias="parentId")
    type: str = Field(pattern=r"^(catalog|menu|button)$")
    label: str = Field(min_length=1, max_length=128)
    perm_key: str = Field(min_length=1, max_length=128, alias="permKey")
    path: str | None = None
    icon: str = "Folder"
    sort_order: int = Field(default=0, alias="sortOrder")
    status: str = Field(default="active", pattern=r"^(active|hidden|disabled)$")
    description: str = ""
    btn_variant: str | None = Field(default=None, alias="btnVariant")
    danger: bool = False


class ResourceUpdateRequest(BaseModel):
    """Update a permission resource. Only non-None fields are applied."""

    parent_id: str | None = Field(default=None, alias="parentId")
    type: str | None = Field(default=None, pattern=r"^(catalog|menu|button)$")
    label: str | None = Field(default=None, min_length=1, max_length=128)
    perm_key: str | None = Field(default=None, min_length=1, max_length=128, alias="permKey")
    path: str | None = None
    icon: str | None = None
    sort_order: int | None = Field(default=None, alias="sortOrder")
    status: str | None = Field(default=None, pattern=r"^(active|hidden|disabled)$")
    description: str | None = None
    btn_variant: str | None = Field(default=None, alias="btnVariant")
    danger: bool | None = None


# ── Role schemas ─────────────────────────────────────────────────


class RoleResponse(CamelCaseModel):
    """Role definition."""

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    key: str
    name: str
    description: str = ""
    is_builtin: bool = Field(default=False, serialization_alias="isBuiltin")
    is_active: bool = Field(default=True, serialization_alias="isActive")
    parent_role_id: str | None = Field(default=None, serialization_alias="parentRoleId")
    sort_order: int = Field(default=0, serialization_alias="sortOrder")
    user_count: int = Field(default=0, serialization_alias="userCount")
    created_at: datetime = Field(serialization_alias="createdAt")


class RoleCreateRequest(BaseModel):
    """Create a new role."""

    key: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=64)
    description: str = ""
    parent_role_id: str | None = Field(default=None, alias="parentRoleId")
    sort_order: int = Field(default=0, alias="sortOrder")
    copy_permissions_from: str | None = Field(default=None, alias="copyPermissionsFrom")


class RoleUpdateRequest(BaseModel):
    """Update a role. Only non-None fields are applied."""

    name: str | None = Field(default=None, min_length=1, max_length=64)
    description: str | None = None
    is_active: bool | None = Field(default=None, alias="isActive")
    parent_role_id: str | None = Field(default=None, alias="parentRoleId")
    sort_order: int | None = Field(default=None, alias="sortOrder")


# ── Role-Permission schemas ──────────────────────────────────────


class DataScopeItem(BaseModel):
    """Data scope for a single resource."""

    model_config = ConfigDict(populate_by_name=True)

    resource_key: str = Field(alias="resourceKey")
    scope: str = Field(pattern=r"^(all|dept_and_children|dept|self|custom|none)$")


class RolePermissionsResponse(CamelCaseModel):
    """Role's permission state."""

    role_id: str = Field(serialization_alias="roleId")
    granted: list[str]  # list of permKey strings
    data_scopes: list[DataScopeItem] = Field(default_factory=list, serialization_alias="dataScopes")


class RolePermissionsUpdateRequest(BaseModel):
    """Set a role's permissions and data scopes."""

    granted: list[str] = Field(default_factory=list)
    data_scopes: list[DataScopeItem] = Field(default_factory=list, alias="dataScopes")


# ── User-Role schemas ────────────────────────────────────────────


class UserRolesResponse(CamelCaseModel):
    """User's role assignments."""

    user_id: str = Field(serialization_alias="userId")
    roles: list[RoleResponse] = Field(default_factory=list)


class UserRolesUpdateRequest(BaseModel):
    """Set a user's roles."""

    role_ids: list[str] = Field(default_factory=list, alias="roleIds")


# ── Current-user permissions schemas ─────────────────────────────


class MyMenuNode(CamelCaseModel):
    """Lightweight menu node for sidebar rendering."""

    id: str
    parent_id: str | None = Field(default=None, serialization_alias="parentId")
    type: str  # catalog | menu
    label: str
    path: str | None = None
    icon: str = "Folder"
    sort_order: int = Field(default=0, serialization_alias="sortOrder")


class MyPermissionsResponse(CamelCaseModel):
    """Current user's effective permissions."""

    user_id: str = Field(serialization_alias="userId")
    roles: list[str]  # role keys
    perm_keys: list[str] = Field(default_factory=list, serialization_alias="permKeys")
    menus: list[MyMenuNode] = Field(default_factory=list)
    data_scopes: list[DataScopeItem] = Field(default_factory=list, serialization_alias="dataScopes")
