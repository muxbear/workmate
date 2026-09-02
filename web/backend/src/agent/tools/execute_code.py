"""Python 代码执行工具（当前在后端本机进程内运行）."""

import subprocess
import sys


def execute_code(
    code: str = "",
    language: str = "python",
    timeout: int = 30,
) -> dict:
    """执行 Python 代码并返回标准输出与错误信息（当前在后端本机进程内执行）.

    Args:
        code: 要执行的 Python 源代码。
        language: 编程语言，当前仅支持 python。
        timeout: 执行超时时间（秒），默认 30。

    Returns:
        包含 stdout、stderr、returncode、success 的字典；执行失败时返回 error。
    """
    if str(language).strip().lower() != "python":
        return {
            "error": f"不支持的编程语言: {language}（当前仅支持 python）",
            "stdout": "",
            "stderr": "",
            "success": False,
        }
    try:
        result = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "returncode": result.returncode,
            "success": result.returncode == 0,
        }
    except subprocess.TimeoutExpired:
        return {"error": f"代码执行超时（{timeout}s）", "stdout": "", "stderr": ""}
    except Exception as e:
        return {"error": str(e), "stdout": "", "stderr": ""}


__all__ = ["execute_code"]