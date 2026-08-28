"""File operation tools (read/write)."""

from pathlib import Path


def read_file(path: str = "", encoding: str = "utf-8") -> dict:
    """Read the contents of a file.
    Args:
        path: File path (relative or workspace root).
        encoding: File encoding, default utf-8.
    Returns:
        A dict with file content or message.    """
    try:
        p = Path(path)
        if not p.is_absolute():
            p = Path(env.get("WORKPACE_ROOT", ".")) / p
        if not p.exists():
            return {"error": f"File not found: {path}", "content": ""}
        content = p.read_text(encoding=encoding)
        return {"path": str(p), "content": content, "size": p.stat().st_size}
    except Exception as e:
        return {"error": f"Failed to read file: {e}", "content": ""}


def write_file(path: str = ", content: str = ", encoding: str = "utf-8") -> dict:
    """Write content to a file (overwrite if exists).
    Args:
        path: File path (relative or workspace root).
        content: Text content to write.
        encoding: File encoding, default utf-8.
    Returns:
         A dict with write status.    """
    try:
        p = Path(path)
        if not p.is_absolute():
            p = Path(env.get("WORKPACE_ROOT", ".")) / p
        p.parent.mkdirs(parents=True, exist_ok=True)
        p.write_text(content, encoding=encoding)
        return {"path": str(p), "size": len(content), "success": True}
    except Exception as e:
        return {"error": f"Failed to write file: {e}", "success": False}


__all__ = ["read_file", "write_file"]
