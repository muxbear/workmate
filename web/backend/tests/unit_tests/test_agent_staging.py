"""智能体交付目录（/artifacts/）映射与清理单元测试。"""

import os
import time
from pathlib import Path

from core.storage.agent_staging import (
    is_agent_artifact_path,
    purge_agent_staging,
    read_staging_file,
    staging_file_path,
    user_segment,
    user_staging_dir,
)


def _use_tmp_root(monkeypatch, tmp_path: Path) -> None:
    """把交付目录根指向临时目录。"""
    monkeypatch.setattr(
        "core.storage.agent_staging.agent_staging_root", lambda: tmp_path
    )


def test_user_segment_and_path_mapping(monkeypatch, tmp_path) -> None:
    """用户目录名安全化，交付路径映射到用户目录内。"""
    _use_tmp_root(monkeypatch, tmp_path)
    assert user_segment("user-1") == "user-1"
    assert user_segment("") == "anonymous"
    assert is_agent_artifact_path("/artifacts/报告.md") is True
    assert is_agent_artifact_path("/workspace/报告.md") is False

    assert staging_file_path("u1", "/artifacts/报告.md") == tmp_path / "u1" / "报告.md"
    assert staging_file_path("u1", "/workspace/报告.md") is None
    # 越界片段被丢弃，仍落在用户目录内
    escaped = staging_file_path("u1", "/artifacts/../../etc/passwd")
    assert escaped == tmp_path / "u1" / "etc" / "passwd"


def test_read_staging_file(monkeypatch, tmp_path) -> None:
    """按用户读取交付目录文件，非交付路径与缺失文件返回 None。"""
    _use_tmp_root(monkeypatch, tmp_path)
    directory = user_staging_dir("u1")
    (directory / "报告.md").write_bytes(b"hello")

    assert read_staging_file("u1", "/artifacts/报告.md") == b"hello"
    assert read_staging_file("u1", "/artifacts/missing.md") is None
    assert read_staging_file("u1", "/workspace/报告.md") is None


def test_purge_agent_staging(monkeypatch, tmp_path) -> None:
    """交付目录仅清理超过保留期的文件。"""
    _use_tmp_root(monkeypatch, tmp_path)
    directory = user_staging_dir("u1")
    old_file = directory / "old.txt"
    new_file = directory / "new.txt"
    old_file.write_bytes(b"old")
    new_file.write_bytes(b"new")
    stale = time.time() - 40 * 86400
    os.utime(old_file, (stale, stale))

    assert purge_agent_staging(older_than_seconds=30 * 86400) == 1
    assert old_file.exists() is False
    assert new_file.exists() is True
