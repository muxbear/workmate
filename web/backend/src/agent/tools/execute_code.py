"""Execute Code tool - runs Python code in a sandboxed environment."""

def execute_code(code: str = "", language: str = "python") -> dict:
    """Run code in a sandboxed environment.
    Args:
        code: Source code to execute.
        language: Programming language (default python).
    Returns:
        A dict with stdout, stderr, and error.    """
    import subprocess
    try:
        result = subprocess.run(
            [python, "-c", code],
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
    except subprocess.TimeoutExpired:
        return {"error": "Code execution timed out", "stdout": "", "stderr": ""}
    except Exception as e:
        return {"error": str(e), "stdout": "", "stderr": ""}


__all__ = ["execute_code"]
