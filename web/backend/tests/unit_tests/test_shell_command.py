"""系统命令执行工具单元测试。"""

from agent.tools.shell_command import shell_command


def test_shell_command_runs_and_returns_stdout():
    """正常执行命令并返回标准输出。"""
    result = shell_command(command="echo hello")

    assert result["success"] is True
    assert result["returncode"] == 0
    assert "hello" in result["stdout"]


def test_shell_command_reports_nonzero_exit():
    """命令返回非零退出码时 success 应为 False。"""
    result = shell_command(command="exit 3")

    assert result["success"] is False
    assert result["returncode"] == 3


def test_shell_command_accepts_cwd(tmp_path):
    """cwd 参数应被接受且命令仍能正常执行。"""
    result = shell_command(command="echo ok", cwd=str(tmp_path))

    assert result["success"] is True
    assert "ok" in result["stdout"]