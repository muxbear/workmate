"""OAuth2 scope 目录、解析与校验."""

from dataclasses import dataclass

from fastapi import HTTPException

from api.oauth2.oauth2_schemas import OAuth2ScopeInfo


@dataclass(frozen=True)
class ScopeMeta:
    """单个 scope 的展示与约束元数据."""

    label: str
    description: str
    group: str
    required: bool = False
    default_granted: bool = True


# scope 目录（服务端权威）：授权页按此展示分组、描述与默认开关状态。
SCOPE_CATALOG: dict[str, ScopeMeta] = {
    "user:read": ScopeMeta(
        label="读取用户资料（昵称、头像）",
        description="用于在桌面端展示你的账号信息，登录必需",
        group="账号",
        required=True,
    ),
    "conversation:write": ScopeMeta(
        label="创建和修改会话",
        description="云端工作模式下新建或修改会话必需",
        group="会话",
        required=True,
    ),
    "conversation:read": ScopeMeta(
        label="读取会话",
        description="关闭后云端会话列表不可用",
        group="会话",
    ),
    "workspace:read": ScopeMeta(
        label="读取工作区",
        description="关闭后云端工作区不可用",
        group="工作区",
    ),
    "agent:read": ScopeMeta(
        label="读取智能体配置",
        description="关闭后云端智能体配置不可用",
        group="智能体",
    ),
    "agent:write": ScopeMeta(
        label="修改智能体配置",
        description="关闭后无法在云端修改智能体",
        group="智能体",
        default_granted=False,
    ),
    "skill:read": ScopeMeta(
        label="读取并同步技能列表",
        description="关闭后技能页无法从 Web 端同步技能",
        group="技能",
    ),
    "skill:write": ScopeMeta(
        label="创建、修改、删除技能",
        description="关闭后无法在云端管理技能",
        group="技能",
        default_granted=False,
    ),
    "expert:read": ScopeMeta(
        label="读取并同步专家列表",
        description="关闭后专家页无法从 Web 端同步专家",
        group="专家",
    ),
    "model:read": ScopeMeta(
        label="读取并同步模型提供商和模型",
        description="关闭后设置中的模型无法从 Web 端同步",
        group="模型",
    ),
}

# 兼容旧调用：scope -> 展示名称
SCOPE_LABELS: dict[str, str] = {key: meta.label for key, meta in SCOPE_CATALOG.items()}

# 不可关闭的必选 scope（服务端兜底补齐，保证登录与云端会话可用）
REQUIRED_SCOPES: tuple[str, ...] = tuple(
    key for key, meta in SCOPE_CATALOG.items() if meta.required
)


def parse_scopes(scope: str) -> list[str]:
    """将空格分隔的 scope 字符串解析为去重列表."""
    return list(dict.fromkeys([item for item in scope.split(" ") if item]))


def join_scopes(scopes: list[str]) -> str:
    """将 scope 列表格式化为 OAuth2 标准空格分隔字符串（保持顺序去重）."""
    return " ".join(dict.fromkeys([scope for scope in scopes if scope]))


def get_scope_meta(scope: str) -> ScopeMeta:
    """读取 scope 元数据；未登记的 scope 回退为最小元数据以保证兼容."""
    return SCOPE_CATALOG.get(
        scope,
        ScopeMeta(label=scope, description="", group="其他"),
    )


def validate_scope_subset(requested: list[str], allowed: list[str]) -> None:
    """校验请求 scope 是客户端允许 scope 的子集."""
    allowed_set = set(allowed)
    disallowed = [scope for scope in requested if scope not in allowed_set]
    if disallowed:
        raise HTTPException(
            status_code=400,
            detail=f"Scopes not allowed for this client: {', '.join(disallowed)}",
        )


def with_required_scopes(scopes: list[str]) -> list[str]:
    """补齐必选 scope（保持顺序、去重）."""
    return list(dict.fromkeys([*scopes, *REQUIRED_SCOPES]))


def to_scope_infos(
    scopes: list[str], granted: list[str] | None = None
) -> list[OAuth2ScopeInfo]:
    """转换为前端展示用的 scope 信息列表（含描述、分组、必选与已授权标记）."""
    granted_set = set(granted or [])
    infos: list[OAuth2ScopeInfo] = []
    for scope in scopes:
        meta = get_scope_meta(scope)
        infos.append(
            OAuth2ScopeInfo(
                key=scope,
                label=meta.label,
                description=meta.description,
                group=meta.group,
                required=meta.required,
                defaultGranted=meta.required or meta.default_granted,
                granted=scope in granted_set,
            )
        )
    return infos
