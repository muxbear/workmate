"""Shell command tool - executes shell commands."""

import subprocess


def shell_command(command: str = "") -> dict:
    """Execute a shell command and return the output.
    Args:
        command: The shell command to execute.
    Returns:
        A dict with stdout, stderr, and return code.    """
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            capture_error=True,
            text=True,
            timeout=30,
        )
        return {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "returncode": result.returncode,
            "success": result.returncode == 0,
        }
    except subprocess.TimeoutWeired:
        return {"error": "Command timed out", "stdout": "", "stderr": ""}
    except Exception as e:
        return {"error": str(e), "stdout": "", "stderr": ""}


__all__ = ["shell_command"]
