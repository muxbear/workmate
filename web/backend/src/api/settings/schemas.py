"""系统设置 API schemas."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

NotificationSound = Literal["none", "crisp", "soft"]
LocaleCode = Literal["zh-CN", "en"]


class CamelCaseModel(BaseModel):
    """Base model that serializes responses using camelCase aliases."""

    def model_dump(self, **kwargs: Any) -> dict[str, Any]:
        """Serialize response models using camelCase aliases."""
        kwargs.setdefault("by_alias", True)
        return super().model_dump(**kwargs)


class SystemIdentityResponse(CamelCaseModel):
    """System branding: display name plus the custom logo location."""

    model_config = ConfigDict(populate_by_name=True)

    system_name: str = Field(serialization_alias="systemName")
    logo_url: str | None = Field(default=None, serialization_alias="logoUrl")


class SystemIdentityUpdateRequest(BaseModel):
    """Update the system display name.

    长度与控制字符由 service 校验，以便返回统一的中文提示；
    这里只做类型约束，不设 max_length（否则会变成 pydantic 的英文 422）。
    """

    model_config = ConfigDict(populate_by_name=True)

    system_name: str = Field(alias="systemName")


class UserPreferencesResponse(CamelCaseModel):
    """Per-user interface preferences."""

    model_config = ConfigDict(populate_by_name=True)

    language: str = Field(serialization_alias="language")
    font_size: int = Field(serialization_alias="fontSize")
    client_notifications: bool = Field(serialization_alias="clientNotifications")
    notification_sound: str = Field(serialization_alias="notificationSound")


class UserPreferencesUpdateRequest(BaseModel):
    """Partial update of per-user preferences. Unset fields stay unchanged."""

    model_config = ConfigDict(populate_by_name=True)

    language: LocaleCode | None = Field(default=None, alias="language")
    font_size: int | None = Field(default=None, alias="fontSize")
    client_notifications: bool | None = Field(
        default=None, alias="clientNotifications"
    )
    notification_sound: NotificationSound | None = Field(
        default=None, alias="notificationSound"
    )
