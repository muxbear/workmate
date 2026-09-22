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
        delivery_dir: 本轮交付目录虚拟绝对路径（/artifacts/<thread>/turn-<n>），
            由服务端按会话 + 轮次计算，工具与提示词共用同一份约定。
        expert_id: 本次会话选择的专家 ID（未选择时为空串）。
        expert_name: 本次会话选择的专家名称；中间件据此注入强制委派指令。
        platform: 客户端平台（desktop / web / mobile），用于按平台渲染运行环境说明。
    """

    server_info: str
    user_id: str
    org_id: str = "default-org"
    # 会话级权限（由网页版输入卡下发；缺省保持历史行为 = 允许）
    allow_network: bool = True
    allow_shell: bool = True
    # 会话工作区（沙箱内 /workspace/<id>）；None 表示默认工作区
    workspace_id: str | None = None
    # 本轮交付目录（/artifacts/<thread>/turn-<n>）；空串表示未启用交付目录约定
    delivery_dir: str = ""
    # 会话选择的专家（由网页版输入卡下发）；空串表示未选择专家
    expert_id: str = ""
    expert_name: str = ""
    # 客户端平台（desktop / web / mobile）；未知值由服务端回退为 web
    platform: str = "web"
