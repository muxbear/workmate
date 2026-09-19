from dataclasses import dataclass


@dataclass
class Context:
    """Agent 运行时上下文。

    Attributes:
        server_info: 服务端标识。
        user_id: 当前用户 ID（来自 JWT）。
        org_id: 当前用户所属组织 ID，用于组织级只读记忆隔离；单租户默认 "default-org"。
        allow_network: 本次会话是否允许沙箱出网（缺省允许，仅接受配置内的域名）。
        allow_shell: 本次会话是否允许执行命令与代码（缺省允许）。
        workspace_id: 本次会话工作区 id（沙箱内 /workspace/<id> 目录）。
    """

    server_info: str
    user_id: str
    org_id: str = "default-org"
    # 会话级权限（由网页版输入卡下发；缺省保持历史行为 = 允许）
    allow_network: bool = True
    allow_shell: bool = True
    # 会话工作区（沙箱内 /workspace/<id>）；None 表示默认工作区
    workspace_id: str | None = None
