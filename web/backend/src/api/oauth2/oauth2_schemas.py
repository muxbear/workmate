"""OAuth2 authorization API schemas."""

from pydantic import BaseModel, Field


class AuthorizationUrlRequest(BaseModel):
    """创建授权请求."""

    client_id: str = Field(min_length=1, max_length=64)
    redirect_uri: str = Field(min_length=1, max_length=2048)
    scope: str = Field(default="")
    code_challenge: str = Field(min_length=43, max_length=128)
    code_challenge_method: str = Field(default="S256")


class AuthorizationUrlResponse(BaseModel):
    """授权 URL 响应."""

    authorizeUrl: str
    state: str


class OAuth2ClientInfo(BaseModel):
    """OAuth2 客户端信息."""

    client_id: str
    client_name: str


class OAuth2ScopeInfo(BaseModel):
    """OAuth2 scope 信息."""

    key: str
    label: str


class OAuth2UserInfo(BaseModel):
    """OAuth2 用户信息."""

    id: str
    nickname: str
    avatar: str


class AuthorizeContextResponse(BaseModel):
    """授权页上下文响应."""

    state: str
    redirectUri: str
    client: OAuth2ClientInfo
    scopes: list[OAuth2ScopeInfo]
    user: OAuth2UserInfo


class AuthorizeApproveRequest(BaseModel):
    """授权确认请求."""

    state: str = Field(min_length=1)


class AuthorizeApproveResponse(BaseModel):
    """授权确认响应."""

    redirectUrl: str


class TokenRequest(BaseModel):
    """授权码兑换 token 请求."""

    grant_type: str = Field(default="authorization_code")
    client_id: str = Field(min_length=1, max_length=64)
    redirect_uri: str = Field(min_length=1, max_length=2048)
    code: str = Field(min_length=1)
    code_verifier: str = Field(min_length=43, max_length=128)


class TokenResponse(BaseModel):
    """授权码兑换 token 响应."""

    accessToken: str
    refreshToken: str
    expiresIn: int
    scope: str
    user: OAuth2UserInfo
