"""系统命令执行工具（当前在后端本机进程内运行）."""

import subprocess


def shell_command(
    command: str = "",
    cwd: str = "",
    timeout: int = 30,
) -> dict:
    """执行系统命令并返回标准输出与错误信息（本机进程内执行）.

    Args:
        command: 要执行的系统命令，由系统 shell 解析。
        cwd: 可选工作目录，为空时使用后端进程当前目录。
        timeout: 执行超时时间（秒），默认 30。

    Returns:
        包含 stdout、stderr、returncode、success 的字典；执行失败时返回 error。
    """
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=cwd or None,
        )
        return {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "returncode": result.returncode,
            "success": result.returncode == 0,
        }
    except subprocess.TimeoutExpired:
        return {"error": f"命令执行超时（{timeout}s）", "stdout": "", "stderr": ""}
    except Exception as e:
        return {"error": str(e), "stdout": "", "stderr": ""}


__all__ = ["shell_command"]