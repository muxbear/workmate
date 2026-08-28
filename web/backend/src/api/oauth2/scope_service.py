"""OAuth2 scope 解析与校验."""

from fastapi import HTTPException

from api.oauth2.oauth2_schemas import OAuth2ScopeInfo

SCOPE_LABELS: dict[str, str] = {
    "skill:read": "读取并同步技能列表",
    "skill:write": "创建、修改、删除技能",
    "user:read": "读取用户资料（昵称、头像）",
    "agent:read": "读取智能体配置",
    "expert:read": "读取并同步专家列表",
    "agent:write": "修改智能体配置",
    "conversation:read": "读取会话",
    "conversation:write": "创建和修改会话",
    "workspace:read": "读取工作区",
}


def parse_scopes(scope: str) -> list[str]:
    """将空格分隔的 scope 字符串解析为去重列表."""
    return list(dict.fromkeys([item for item in scope.split(" ") if item]))


def join_scopes(scopes: list[str]) -> str:
    """将 scope 列表格式化为 OAuth2 标准空格分隔字符串."""
    return " ".join(scopes)


def validate_scope_subset(requested: list[str], allowed: list[str]) -> None:
    """校验请求 scope 是客户端允许 scope 的子集."""
    allowed_set = set(allowed)
    disallowed = [scope for scope in requested if scope not in allowed_set]
    if disallowed:
        raise HTTPException(
            status_code=400,
            detail=f"Scopes not allowed for this client: {', '.join(disallowed)}",
        )


def to_scope_infos(scopes: list[str]) -> list[OAuth2ScopeInfo]:
    """转换为前端展示用的 scope 信息列表."""
    return [
        OAuth2ScopeInfo(key=scope, label=SCOPE_LABELS.get(scope, scope))
        for scope in scopes
    ]
