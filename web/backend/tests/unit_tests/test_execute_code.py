"""代码执行工具单元测试。"""

from agent.tools.execute_code import execute_code


def test_execute_code_runs_python_code():
    """正常执行 Python 代码并返回标准输出。"""
    result = execute_code(code="print('hello')")

    assert result["success"] is True
    assert result["returncode"] == 0
    assert result["stdout"].strip() == "hello"
    assert result["stderr"] == ""


def test_execute_code_reports_failure():
    """代码抛出异常时 success 应为 False 且包含错误信息。"""
    result = execute_code(code="raise RuntimeError('boom')")

    assert result["success"] is False
    assert "boom" in result["stderr"]


def test_execute_code_rejects_unsupported_language():
    """不支持的编程语言应直接返回错误。"""
    result = execute_code(code="console.log('hi')", language="javascript")

    assert result["success"] is False
    assert "不支持" in result["error"]