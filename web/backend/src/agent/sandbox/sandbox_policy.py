"""沙箱网络策略的会话级开关（网页版「联网访问」权限）。"""

from __future__ import annotations

import logging

from opensandbox.models.sandboxes import NetworkPolicy

from agent.config import settings
from agent.config.config import (
    SANDBOX_NETWORK_MODE_ALLOW_ALL,
    SANDBOX_NETWORK_MODE_DENY_ALL,
)
from agent.sandbox.opensandbox_backend import OpenSandBoxBackend
from agent.sandbox.opensandbox_operate import (
    allow_network_rules,
    deny_network_rules,
    merge_allowed_domains,
)

logger = logging.getLogger(__name__)


def allow_targets(policy: NetworkPolicy) -> list[str]:
    """提取策略中显式放行的域名（用于查看当前放行范围）。"""
    return [rule.target for rule in (policy.egress or []) if rule.action == "allow"]


def apply_network_policy(
    backend: OpenSandBoxBackend,
    allow_network: bool,
    extra_domains: list[str] | None = None,
) -> None:
    """按全局出网模式与会话开关调整沙箱出网策略。

    - deny_all：管理员强制完全禁网，会话开关无法放开；
    - allow_all：管理员放开全部出网，会话开关无法收紧（默认动作只能在建沙盒时设定）；
    - whitelist：会话开启时放行白名单域名，关闭时用同域名的 deny 规则覆盖放行。
      这里不做删除规则：当前 OpenSandbox 侧车未实现 ``DELETE /policy``（返回 405），
      而 ``PATCH /policy`` 对相同 target 具备覆盖语义。
    """
    mode = settings.sandbox_network_mode
    if mode == SANDBOX_NETWORK_MODE_DENY_ALL:
        logger.debug("沙箱出网模式为 deny_all，忽略会话联网开关")
        return
    if mode == SANDBOX_NETWORK_MODE_ALLOW_ALL:
        logger.debug("沙箱出网模式为 allow_all，会话开关不做收紧")
        return

    domains = merge_allowed_domains(
        settings.sandbox_allowed_domains_list, extra_domains
    )
    if not domains:
        logger.debug("白名单为空，沙箱保持默认拒绝出网")
        return

    rules = (
        allow_network_rules(domains) if allow_network else deny_network_rules(domains)
    )
    backend.sandbox.patch_egress_rules(rules)
