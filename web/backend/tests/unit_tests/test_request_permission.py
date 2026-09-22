"""会话级权限（代码执行拦截 / 网络放行规则）单元测试。"""

from opensandbox.models.sandboxes import NetworkPolicy, NetworkRule

from agent.config import settings
from agent.config.config import (
    SANDBOX_NETWORK_MODE_ALLOW_ALL,
    SANDBOX_NETWORK_MODE_DENY_ALL,
    SANDBOX_NETWORK_MODE_WHITELIST,
)
from agent.middleware.request_permission import is_tool_blocked, is_workspace_blocked
from agent.sandbox.opensandbox_operate import _default_network_policy
from agent.sandbox.sandbox_policy import allow_targets, apply_network_policy
from agent.sandbox.workspace import is_within_workspace, normalize_workspace_id


def test_shell_tools_blocked_when_disabled() -> None:
    """未开启代码执行时，命令/代码类工具应被拦截。"""
    assert is_tool_blocked("execute_code", False) is True
    assert is_tool_blocked("shell_command", False) is True
    assert is_tool_blocked("run_command", False) is True
    assert is_tool_blocked("CODE_INTERPRETER", False) is True


def test_shell_tools_allowed_when_enabled() -> None:
    """开启代码执行后不再拦截。"""
    assert is_tool_blocked("execute_code", True) is False


def test_other_tools_never_blocked() -> None:
    """仅拦截命令/代码类工具，其余工具不受影响。"""
    assert is_tool_blocked("write_file", False) is False
    assert is_tool_blocked("kb_search", False) is False
    assert is_tool_blocked("", False) is False


def test_allow_targets_filters_allow_rules() -> None:
    """仅提取 allow 规则的目标域名（关闭联网时用于逐条撤销）。"""
    policy = NetworkPolicy(
        defaultAction="deny",
        egress=[
            NetworkRule(action="allow", target="pypi.org"),
            NetworkRule(action="deny", target="evil.com"),
            NetworkRule(action="allow", target="*.github.com"),
        ],
    )
    assert allow_targets(policy) == ["pypi.org", "*.github.com"]


def test_allow_targets_handles_empty_policy() -> None:
    """空策略返回空列表。"""
    assert allow_targets(NetworkPolicy(defaultAction="deny", egress=[])) == []


def test_normalize_workspace_id() -> None:
    """工作区 id 规范化：合法值小写化，非法值被忽略。"""
    assert normalize_workspace_id("My-Files") == "my-files"
    assert normalize_workspace_id("proj_1") == "proj_1"
    assert normalize_workspace_id("../etc") is None
    assert normalize_workspace_id("a b") is None
    assert normalize_workspace_id("") is None
    assert normalize_workspace_id(None) is None


def test_is_within_workspace() -> None:
    """同工作区内路径通过，其它工作区路径不通过。"""
    assert is_within_workspace("/workspace/proj-1/a.md", "proj-1") is True
    assert is_within_workspace("/workspace/proj-1", "proj-1") is True
    assert is_within_workspace("/workspace/proj-2/a.md", "proj-1") is False
    assert is_within_workspace("/chat_upload/x.pdf", "proj-1") is True
    assert is_within_workspace("/workspace/proj-2/a.md", None) is True


def test_workspace_block_only_for_cross_workspace_writes() -> None:
    """跨工作区写入被拦截，其余路径不受影响。"""
    assert is_workspace_blocked({"path": "/workspace/other/a.md"}, "mine") is True
    assert is_workspace_blocked({"path": "/workspace/mine/a.md"}, "mine") is False
    assert is_workspace_blocked({"path": "/tmp/a.md"}, "mine") is False
    assert is_workspace_blocked({"path": "/workspace/other/a.md"}, None) is False
    assert is_workspace_blocked("not-a-dict", "mine") is False


def test_default_network_policy_uses_configured_domains(monkeypatch) -> None:
    """默认出网策略的放行域名完全来自 SANDBOX_ALLOWED_DOMAINS 配置。"""
    monkeypatch.setattr(settings, "SANDBOX_ALLOWED_DOMAINS", "example.com, *.test.com")
    policy = _default_network_policy()
    assert allow_targets(policy) == ["example.com", "*.test.com"]


def test_default_network_policy_merges_and_dedupes_extra_domains(monkeypatch) -> None:
    """附加域名追加在配置域名之后，重复项只保留一次。"""
    monkeypatch.setattr(settings, "SANDBOX_ALLOWED_DOMAINS", "example.com")
    policy = _default_network_policy(["example.com", " extra.com ", ""])
    assert allow_targets(policy) == ["example.com", "extra.com"]


def test_default_network_policy_denies_all_when_unconfigured(monkeypatch) -> None:
    """未配置白名单时不产生放行规则，等价于完全禁止出网。"""
    monkeypatch.setattr(settings, "SANDBOX_ALLOWED_DOMAINS", "")
    assert allow_targets(_default_network_policy()) == []


class _FakeSandbox:
    """记录 patch_egress_rules 调用的假沙箱。"""

    def __init__(self) -> None:
        self.patched: list[list[tuple[str, str]]] = []

    def patch_egress_rules(self, rules) -> None:
        self.patched.append([(rule.action, rule.target) for rule in rules])

    def delete_egress_rules(self, targets) -> None:
        raise AssertionError("不应调用 delete_egress_rules（当前侧车返回 405）")


class _FakeBackend:
    """只暴露 sandbox 属性的假后端。"""

    def __init__(self) -> None:
        self.sandbox = _FakeSandbox()


def _set_network(monkeypatch, mode: str, domains: str) -> None:
    """设置沙箱出网模式与白名单配置。"""
    monkeypatch.setattr(settings, "SANDBOX_NETWORK_MODE", mode)
    monkeypatch.setattr(settings, "SANDBOX_ALLOWED_DOMAINS", domains)


def test_network_mode_whitelist_policy(monkeypatch) -> None:
    """whitelist 模式：默认拒绝出网，只放行白名单域名。"""
    _set_network(monkeypatch, SANDBOX_NETWORK_MODE_WHITELIST, "a.com, *.b.com")
    policy = _default_network_policy()
    assert policy.default_action == "deny"
    assert [(rule.action, rule.target) for rule in (policy.egress or [])] == [
        ("allow", "a.com"),
        ("allow", "*.b.com"),
    ]


def test_network_mode_allow_all_policy(monkeypatch) -> None:
    """allow_all 模式：默认放行全部域名，白名单不再限制范围。"""
    _set_network(monkeypatch, SANDBOX_NETWORK_MODE_ALLOW_ALL, "a.com")
    policy = _default_network_policy()
    assert policy.default_action == "allow"
    assert not policy.egress


def test_network_mode_deny_all_policy(monkeypatch) -> None:
    """deny_all 模式：默认拒绝且不下发任何规则，完全不可出网。"""
    _set_network(monkeypatch, SANDBOX_NETWORK_MODE_DENY_ALL, "a.com")
    policy = _default_network_policy()
    assert policy.default_action == "deny"
    assert not policy.egress


def test_network_mode_invalid_falls_back_to_whitelist(monkeypatch) -> None:
    """非法模式值回退 whitelist。"""
    _set_network(monkeypatch, "no-such-mode", "a.com")
    assert settings.sandbox_network_mode == SANDBOX_NETWORK_MODE_WHITELIST
    assert _default_network_policy().default_action == "deny"


def test_apply_network_policy_toggles_whitelist(monkeypatch) -> None:
    """whitelist 模式：开启下发 allow 规则，关闭用 deny 规则覆盖同一批域名。"""
    _set_network(monkeypatch, SANDBOX_NETWORK_MODE_WHITELIST, "a.com, b.com")
    backend = _FakeBackend()
    apply_network_policy(backend, True)
    apply_network_policy(backend, False)
    assert backend.sandbox.patched == [
        [("allow", "a.com"), ("allow", "b.com")],
        [("deny", "a.com"), ("deny", "b.com")],
    ]


def test_apply_network_policy_allow_all_ignores_session_toggle(monkeypatch) -> None:
    """allow_all 模式：会话关闭联网不会收紧策略。"""
    _set_network(monkeypatch, SANDBOX_NETWORK_MODE_ALLOW_ALL, "a.com")
    backend = _FakeBackend()
    apply_network_policy(backend, False)
    assert backend.sandbox.patched == []


def test_apply_network_policy_deny_all_ignores_session_toggle(monkeypatch) -> None:
    """deny_all 模式：会话开启联网也无法放开。"""
    _set_network(monkeypatch, SANDBOX_NETWORK_MODE_DENY_ALL, "a.com")
    backend = _FakeBackend()
    apply_network_policy(backend, True)
    assert backend.sandbox.patched == []
