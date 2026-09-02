"""文件读写工具."""

from pathlib import Path

from agent.config import settings


def _resolve_path(path: str) -> Path:
    """将相对路径解析到工作区根目录下的绝对路径."""
    p = Path(path)
    if p.is_absolute():
        return p
    return Path(settings.WORKSPACE) / p


def read_file(path: str = "", encoding: str = "utf-8") -> dict:
    """读取文件内容并返回结果字典.

    Args:
        path: 文件路径，支持工作区相对路径或绝对路径。
        encoding: 文件编码，默认 utf-8。

    Returns:
        包含 path、content、size 的字典；读取失败时返回 error。
    """
    try:
        p = _resolve_path(path)
        if not p.exists():
            return {"error": f"File not found: {path}", "content": ""}
        content = p.read_text(encoding=encoding)
        return {"path": str(p), "content": content, "size": p.stat().st_size}
    except Exception as e:
        return {"error": f"Failed to read file: {e}", "content": ""}


def write_file(
    path: str = "",
    content: str = "",
    mode: str = "overwrite",
    encoding: str = "utf-8",
) -> dict:
    """将文本内容写入文件，支持覆盖或追加，并自动创建父目录.

    Args:
        path: 文件路径，支持工作区相对路径或绝对路径。
        content: 要写入的文本内容。
        mode: 写入模式，overwrite/w 表示覆盖，append/a 表示追加。
        encoding: 文件编码，默认 utf-8。

    Returns:
        包含 path、size、success 的字典；写入失败时返回 error。
    """
    try:
        p = _resolve_path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        write_mode = "a" if str(mode).strip().lower() in ("append", "a") else "w"
        with p.open(write_mode, encoding=encoding) as f:
            f.write(content)
        return {"path": str(p), "size": len(content), "success": True}
    except Exception as e:
        return {"error": f"Failed to write file: {e}", "success": False}


__all__ = ["read_file", "write_file"]