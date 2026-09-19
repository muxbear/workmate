"""会话级权限（代码执行拦截 / 网络放行规则）单元测试。"""

from opensandbox.models.sandboxes import NetworkPolicy, NetworkRule

from agent.middleware.request_permission import is_tool_blocked, is_workspace_blocked
from agent.sandbox.sandbox_policy import allow_targets
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
