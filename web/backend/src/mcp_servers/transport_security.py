"""内置 MCP 服务的传输层安全设置（Host 白名单）。

FastMCP 默认按构造时的 ``host``（127.0.0.1）推导 DNS 重绑定防护的设置，
白名单**只含回环地址**。挂载进 FastAPI 后真正监听的是 uvicorn，但白名单仍是这一份。

后果：部署到真实域名（配了 ``MCP_PUBLIC_BASE_URL``）后，外部客户端请求带的
``Host`` 不在白名单里，一律被拒成 ``400 Invalid Host header``——表现为
"服务挂着、地址也对，就是连不上"。这类失败没有堆栈、只在传输层拦下，
排查成本高，因此在这里按对外基址显式补齐白名单。

未配置对外基址时，白名单与从前完全一致（仅回环），行为不变。
"""

from __future__ import annotations

import logging
from urllib.parse import urlparse

from mcp.server.transport_security import TransportSecuritySettings

logger = logging.getLogger(__name__)

#: 回环地址。带端口的通配形式与不带端口的裸主机都要放行——
#: ``Host`` 在默认端口下不带端口号（如 https 的 443 会被省略）。
_LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")


def _host_patterns(hostname: str) -> list[str]:
    """把主机名展开成白名单条目（裸主机 + 任意端口两种写法）。"""
    if ":" in hostname and not hostname.startswith("["):
        # IPv6 字面量在 Host 头里带方括号
        hostname = f"[{hostname}]"
    return [hostname, f"{hostname}:*"]


def transport_security_settings() -> TransportSecuritySettings:
    """构造内置 MCP 服务的传输层安全设置：回环地址 + 对外基址的主机名。"""
    from agent.config import settings

    allowed: list[str] = []
    for host in _LOOPBACK_HOSTS:
        allowed.extend(_host_patterns(host))

    base = (settings.mcp_public_base_url or "").strip()
    hostname = urlparse(base).hostname if base else None
    if hostname and hostname not in _LOOPBACK_HOSTS:
        allowed.extend(_host_patterns(hostname))
        logger.info("MCP 服务已放行对外主机名: %s", hostname)

    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=allowed,
    )


__all__ = ["transport_security_settings"]
