"""会话交付目录（/artifacts/<thread>/turn-<n>/）单元测试。"""

from pathlib import Path

import pytest

from agent.sandbox.delivery import (
    delivery_host_dir,
    delivery_hint,
    delivery_thread_root,
    delivery_virtual_dir,
    is_delivery_path,
    list_turn_dirs,
    next_turn_dir,
    normalize_delivery_rel,
    safe_segment,
)


def _use_tmp_root(monkeypatch, tmp_path: Path) -> None:
    """把交付目录根指向临时目录。"""
    monkeypatch.setattr("core.storage.agent_staging.agent_staging_root", lambda: tmp_path)


def test_safe_segment_and_relative_path() -> None:
    """会话目录名安全化；相对路径拒绝越界与空值。"""
    assert safe_segment("thread-1") == "thread-1"
    assert safe_segment("../etc") == "etc"
    assert safe_segment("") == "session"

    assert normalize_delivery_rel("文章标题/figure-1.png") == "文章标题/figure-1.png"
    assert normalize_delivery_rel("文章标题" + chr(92) + "figure-1.png") == "文章标题/figure-1.png"
    with pytest.raises(ValueError):
        normalize_delivery_rel("../secret.png")
    with pytest.raises(ValueError):
        normalize_delivery_rel("")


def test_virtual_paths_and_hint() -> None:
    """交付目录虚拟路径与提示包含会话与轮次。"""
    assert is_delivery_path("/artifacts/t1/turn-1/文章.md") is True
    assert is_delivery_path("/workspace/文章.md") is False
    assert delivery_virtual_dir("t1", "turn-2") == "/artifacts/t1/turn-2"

    hint = delivery_hint("t1", "turn-2")
    assert "/artifacts/t1/turn-2/" in hint
    assert "交付目录" in hint


def test_turn_dirs_and_host_path(monkeypatch, tmp_path: Path) -> None:
    """轮次目录按已有目录推导，宿主路径落在用户目录下。"""
    _use_tmp_root(monkeypatch, tmp_path)
    assert next_turn_dir("u1", "t1") == "turn-1"
    assert list_turn_dirs("u1", "t1") == []

    first = delivery_host_dir("u1", "t1", "turn-1")
    assert first == tmp_path / "u1" / "t1" / "turn-1"
    assert first.is_dir()

    (tmp_path / "u1" / "t1" / "turn-3").mkdir(parents=True)
    assert list_turn_dirs("u1", "t1") == ["turn-1", "turn-3"]
    assert next_turn_dir("u1", "t1") == "turn-4"
    assert delivery_thread_root("u1", "t1") == tmp_path / "u1" / "t1"


def test_turn_from_path() -> None:
    """从交付路径解析轮次目录名。"""
    from agent.sandbox.delivery import turn_from_path

    assert turn_from_path("/artifacts/t1/turn-1/文章.md") == "turn-1"
    assert turn_from_path("/artifacts/t1/turn-12/文章/figure-1.png") == "turn-12"
    assert turn_from_path("/artifacts/t1/文章.md") == ""
    assert turn_from_path("/workspace/文章.md") == ""
