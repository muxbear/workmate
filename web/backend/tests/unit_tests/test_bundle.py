"""交付目录打包（bundle.zip）与代理下载落盘单元测试。"""

import asyncio
import io
import zipfile
from pathlib import Path

import pytest

from api.agent.artifacts import (
    Artifact,
    build_bundle_zip,
    delivery_turn_prefix,
    ingest_remote_asset,
)
from core.storage.asset_fetcher import FetchedAsset

PNG_BYTES = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) + bytes(8)


def _use_tmp_root(monkeypatch, tmp_path: Path) -> None:
    """把交付目录根指向临时目录。"""
    monkeypatch.setattr("core.storage.agent_staging.agent_staging_root", lambda: tmp_path)


def _seed_turn(tmp_path: Path, turn: str) -> Path:
    """在临时交付目录里造一轮「文章 + 同名配图目录」。"""
    base = tmp_path / "u1" / "t1" / turn
    (base / "文章标题").mkdir(parents=True, exist_ok=True)
    (base / "文章标题.md").write_text("# 标题", encoding="utf-8")
    (base / "文章标题" / "figure-1.png").write_bytes(PNG_BYTES)
    return base


def test_delivery_turn_prefix() -> None:
    """轮次前缀与整会话前缀都以 / 结尾。"""
    assert delivery_turn_prefix("t1", "turn-1") == "/artifacts/t1/turn-1/"
    assert delivery_turn_prefix("t1") == "/artifacts/t1/"


def test_build_bundle_zip_turn_scope(monkeypatch, tmp_path: Path) -> None:
    """按轮次打包只含本轮文件，且保留目录结构。"""
    _use_tmp_root(monkeypatch, tmp_path)
    _seed_turn(tmp_path, "turn-1")
    _seed_turn(tmp_path, "turn-2")

    packed = build_bundle_zip("u1", "t1", scope="turn", turn="turn-1")
    assert packed is not None
    name, content = packed
    assert name == "turn-1-bundle.zip"

    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        assert sorted(archive.namelist()) == ["文章标题.md", "文章标题/figure-1.png"]
        assert archive.read("文章标题/figure-1.png") == PNG_BYTES


def test_build_bundle_zip_thread_scope_and_empty(monkeypatch, tmp_path: Path) -> None:
    """整会话打包包含全部轮次；无内容返回 None。"""
    _use_tmp_root(monkeypatch, tmp_path)
    _seed_turn(tmp_path, "turn-1")
    _seed_turn(tmp_path, "turn-2")

    packed = build_bundle_zip("u1", "t1", scope="thread")
    assert packed is not None
    name, content = packed
    assert name.endswith("-bundle.zip")
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        names = sorted(archive.namelist())
    assert "turn-1/文章标题.md" in names
    assert "turn-2/文章标题/figure-1.png" in names

    assert build_bundle_zip("u1", "no-such-thread", scope="turn") is None


def test_ingest_remote_asset_writes_staging(monkeypatch, tmp_path: Path) -> None:
    """代理下载写入交付目录宿主目录并登记（不依赖沙箱）。"""
    _use_tmp_root(monkeypatch, tmp_path)
    captured: dict[str, object] = {}

    async def fake_fetch(url: str, **kwargs: object) -> FetchedAsset:
        captured["url"] = url
        return FetchedAsset(content=PNG_BYTES, mime_type="image/png", source_url=url)

    async def fake_upsert(thread_id, user_id, file_path, source_tool, mime_type):
        captured["upsert"] = (thread_id, user_id, file_path, source_tool, mime_type)
        return "aid-1"

    async def fake_persist(user_id, thread_id, artifact_id, *, force=False):
        captured["persist"] = (artifact_id, force)
        upsert = captured["upsert"]
        return Artifact(
            path=str(upsert[2]),
            name="figure-1.png",
            source_tool="download_asset",
            mime_type="image/png",
            size=len(PNG_BYTES),
            created_at=0.0,
            artifact_id=artifact_id,
            status="ready",
            storage_key="k",
        )

    monkeypatch.setattr("core.storage.asset_fetcher.fetch_image", fake_fetch)
    monkeypatch.setattr("api.agent.artifacts._upsert_artifact_row", fake_upsert)
    monkeypatch.setattr("api.agent.artifacts.persist_artifact", fake_persist)

    artifact = asyncio.run(
        ingest_remote_asset(
            "u1",
            "t1",
            "https://cdn.example.com/a.png",
            "文章标题/figure-1.png",
            delivery_dir="/artifacts/t1/turn-2",
        )
    )

    assert artifact.storage_key == "k"
    saved = tmp_path / "u1" / "t1" / "turn-2" / "文章标题" / "figure-1.png"
    assert saved.read_bytes() == PNG_BYTES
    assert captured["upsert"][2] == "/artifacts/t1/turn-2/文章标题/figure-1.png"
    assert captured["upsert"][3] == "download_asset"
    assert captured["persist"] == ("aid-1", True)


def test_ingest_remote_asset_rejects_bad_rel_path(monkeypatch, tmp_path: Path) -> None:
    """越界的相对路径被拒绝，不写任何文件。"""
    _use_tmp_root(monkeypatch, tmp_path)
    with pytest.raises(ValueError):
        asyncio.run(ingest_remote_asset("u1", "t1", "https://x/a.png", "../escape.png"))
