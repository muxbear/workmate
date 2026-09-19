"""沙箱网络策略的会话级开关（网页版「联网访问」权限）。"""

from __future__ import annotations

import logging

from opensandbox.models.sandboxes import NetworkPolicy

from agent.sandbox.opensandbox_backend import OpenSandBoxBackend
from agent.sandbox.opensandbox_operate import _default_network_policy

logger = logging.getLogger(__name__)


def allow_targets(policy: NetworkPolicy) -> list[str]:
    """提取策略中显式放行的域名（用于关闭联网时逐条撤销）。"""
    return [rule.target for rule in (policy.egress or []) if rule.action == "allow"]


def apply_network_policy(
    backend: OpenSandBoxBackend,
    allow_network: bool,
    extra_domains: list[str] | None = None,
) -> None:
    """按会话开关调整沙箱出网策略：开启时下发配置内允许域名，关闭时撤销全部放行规则。"""
    sandbox = backend.sandbox
    if allow_network:
        rules = _default_network_policy(extra_domains).egress or []
        if rules:
            sandbox.patch_egress_rules(rules)
        return

    current = sandbox.get_egress_policy()
    targets = allow_targets(current)
    if targets:
        sandbox.delete_egress_rules(targets)
