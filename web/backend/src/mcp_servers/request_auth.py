"""从 MCP 请求上下文解析调用方身份。

MCP 服务被外部客户端（桌面端、Claude Desktop、Cursor 等）以 HTTP 方式调用时，
进程里没有 LangGraph 运行时上下文，身份只能来自请求头的
``Authorization: Bearer <jwt>``——与 REST 接口同一枚 access token、同一套校验，
不引入第二套凭据体系。

约定：**解析不出来就返回空串，由调用方拒绝**。这里绝不返回"默认用户"或直接放行，
否则等于把按用户授权的资源（如知识库）开放给任何能连上端口的人。
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_BEARER_PREFIX = "bearer "


def authorization_header() -> str:
    """读取当前 MCP 调用的 Authorization 头；非 HTTP 调用返回空串。"""
    try:
        from mcp.server.lowlevel.server import request_ctx

        ctx = request_ctx.get()
    except LookupError:
        # 进程内内存传输（register_local_mcp_server 注册的自托管服务）没有 HTTP 请求
        return ""
    except Exception:  # noqa: BLE001 - 取不到上下文一律按"无身份"处理
        logger.debug("读取 MCP 请求上下文失败", exc_info=True)
        return ""

    # streamable_http / sse 两种传输都会把 Starlette Request 挂在这里
    # （mcp.server.streamable_http 与 mcp.server.sse 的 ServerMessageMetadata）。
    # 内存传输下这里是 None。
    headers = getattr(getattr(ctx, "request", None), "headers", None)
    if headers is None:
        return ""
    try:
        for key, value in headers.items():
            if str(key).lower() == "authorization":
                return str(value or "")
    except Exception:  # noqa: BLE001 - 头对象形态不可预期，失败按"无身份"处理
        logger.debug("解析 MCP 请求头失败", exc_info=True)
    return ""


def user_id_from_mcp_request() -> str:
    """从 MCP 请求头解析 access token 得到用户 ID；无 token 或 token 无效时返回空串。"""
    auth = authorization_header().strip()
    if not auth.lower().startswith(_BEARER_PREFIX):
        return ""
    token = auth[len(_BEARER_PREFIX) :].strip()
    if not token:
        return ""

    from core.security import decode_token

    try:
        payload = decode_token(token, "access")
    except Exception:  # noqa: BLE001 - 过期/伪造/类型不符都按匿名处理，由调用方拒绝
        logger.debug("MCP 请求头 token 校验失败", exc_info=True)
        return ""
    return str(payload.get("sub") or "")


__all__ = ["authorization_header", "user_id_from_mcp_request"]
