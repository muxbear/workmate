from pydantic import BaseModel, EmailStr, Field


class AccountLoginRequest(BaseModel):
    account: str = Field(min_length=2, max_length=64)
    password: str
    captchaTicket: str | None = None
    captchaRandstr: str | None = None


class PhoneLoginRequest(BaseModel):
    phone: str = Field(pattern=r"^1[3-9]\d{9}$")
    smsCode: str = Field(min_length=4, max_length=6)


class RegisterRequest(BaseModel):
    phone: str = Field(pattern=r"^1[3-9]\d{9}$")
    smsCode: str = Field(min_length=4, max_length=6)
    nickname: str = Field(min_length=1, max_length=32)
    password: str
    agreedProtocolVersion: str


class EmailRegisterRequest(BaseModel):
    email: EmailStr
    emailCode: str
    nickname: str = Field(min_length=1, max_length=32)
    password: str
    agreedProtocolVersion: str


class AuthTokens(BaseModel):
    accessToken: str
    refreshToken: str
    expiresIn: int = 7200


class RoleInfo(BaseModel):
    """角色下拉展示所需的精简角色信息."""

    key: str
    name: str
    sortOrder: int = 0


class UserInfo(BaseModel):
    id: str
    nickname: str
    avatar: str
    phone: str
    email: str
    workspaceId: str
    roles: list[str] = Field(default_factory=list)
    roleList: list[RoleInfo] = Field(default_factory=list)
    activeRole: str | None = None


class AuthResponse(BaseModel):
    tokens: AuthTokens
    user: UserInfo
    needProtocolAgreement: str | None = None


class RefreshRequest(BaseModel):
    refreshToken: str


class SwitchRoleRequest(BaseModel):
    """切换当前会话的活动角色."""

    roleKey: str = Field(min_length=1, max_length=64)


class MyRolesResponse(BaseModel):
    """当前账号的角色列表与活动角色."""

    roles: list[RoleInfo] = Field(default_factory=list)
    activeRole: str | None = None


class LoginFailInfo(BaseModel):
    failCount: int
    lockedUntil: int | None = None


class ChangePasswordRequest(BaseModel):
    oldPassword: str
    newPassword: str
