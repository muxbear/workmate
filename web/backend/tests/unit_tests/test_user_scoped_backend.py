"""按用户隔离的交付目录文件后端单元测试。"""

from pathlib import Path
from types import SimpleNamespace

from agent.backends.user_scoped_filesystem_backend import UserScopedFilesystemBackend


def _runtime(user_id: str):
    """构造带用户上下文的最小 runtime。"""
    return SimpleNamespace(context=SimpleNamespace(user_id=user_id))


def test_writes_are_isolated_per_user(monkeypatch, tmp_path: Path) -> None:
    """不同用户的 /artifacts/ 读写落在各自目录，互不可见。"""
    from agent.backends import user_scoped_filesystem_backend as module

    monkeypatch.setattr(
        "core.storage.agent_staging.agent_staging_root", lambda: tmp_path
    )
    current = {"user": "u1"}
    monkeypatch.setattr(module, "get_runtime", lambda: _runtime(current["user"]))

    backend = UserScopedFilesystemBackend(str(tmp_path))
    backend.write("/报告.md", "u1 内容")
    assert (tmp_path / "u1" / "报告.md").read_text(encoding="utf-8") == "u1 内容"

    current["user"] = "u2"
    assert backend.read("/报告.md").file_data is None
    backend.write("/报告.md", "u2 内容")
    assert (tmp_path / "u2" / "报告.md").read_text(encoding="utf-8") == "u2 内容"
    assert (tmp_path / "u1" / "报告.md").read_text(encoding="utf-8") == "u1 内容"


def test_write_without_runtime_falls_back_to_root(monkeypatch, tmp_path: Path) -> None:
    """缺少运行时上下文时回退到基础根目录，不抛异常。"""
    from agent.backends import user_scoped_filesystem_backend as module

    monkeypatch.setattr(
        "core.storage.agent_staging.agent_staging_root", lambda: tmp_path
    )
    monkeypatch.setattr(module, "get_runtime", lambda: None)

    backend = UserScopedFilesystemBackend(str(tmp_path))
    backend.write("/fallback.md", "content")

    assert (tmp_path / "fallback.md").read_text(encoding="utf-8") == "content"
