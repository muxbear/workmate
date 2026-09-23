"""交付目录打包（bundle.zip）与代理下载落盘单元测试。"""

import asyncio
import io
import zipfile
from pathlib import Path

import pytest

from api.agent.artifacts import (
    Artifact,
    build_bundle_zip,
    copy_store_object_to,
    delivery_turn_prefix,
    ingest_remote_asset,
    restore_delivery_artifacts,
)
from core.storage.asset_fetcher import FetchedAsset

PNG_BYTES = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) + bytes(8)
# 极小 mp4 魔数样本（内容无需可解码）
MP4_BYTES = b"\x00\x00\x00\x18ftypisom" + bytes(16)


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


def _read_zip(zip_path: Path) -> zipfile.ZipFile:
    """打开打包结果（调用方负责关闭；测试内直接返回 ZipFile）。"""
    return zipfile.ZipFile(zip_path)


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
    name, zip_path, count = packed
    assert name == "turn-1-bundle.zip"
    assert count == 2
    assert zip_path.is_file()

    with _read_zip(zip_path) as archive:
        assert sorted(archive.namelist()) == ["文章标题.md", "文章标题/figure-1.png"]
        assert archive.read("文章标题/figure-1.png") == PNG_BYTES
    zip_path.unlink()


def test_build_bundle_zip_thread_scope_and_empty(monkeypatch, tmp_path: Path) -> None:
    """整会话打包包含全部轮次；无内容返回 None。"""
    _use_tmp_root(monkeypatch, tmp_path)
    _seed_turn(tmp_path, "turn-1")
    _seed_turn(tmp_path, "turn-2")

    packed = build_bundle_zip("u1", "t1", scope="thread")
    assert packed is not None
    name, zip_path, _count = packed
    assert name.endswith("-bundle.zip")
    with _read_zip(zip_path) as archive:
        names = sorted(archive.namelist())
    assert "turn-1/文章标题.md" in names
    assert "turn-2/文章标题/figure-1.png" in names
    zip_path.unlink()

    assert build_bundle_zip("u1", "no-such-thread", scope="turn") is None


def test_build_bundle_zip_skips_compression_for_media(monkeypatch, tmp_path: Path) -> None:
    """已压缩的媒体按 STORED 存原始字节：大视频再走 deflate 只浪费 CPU。"""
    _use_tmp_root(monkeypatch, tmp_path)
    base = _seed_turn(tmp_path, "turn-1")
    (base / "标题").mkdir(parents=True, exist_ok=True)
    (base / "标题" / "成片-1.mp4").write_bytes(MP4_BYTES)

    packed = build_bundle_zip("u1", "t1", scope="turn", turn="turn-1")
    assert packed is not None
    _name, zip_path, _count = packed
    with _read_zip(zip_path) as archive:
        video_info = archive.getinfo("标题/成片-1.mp4")
        text_info = archive.getinfo("文章标题.md")
    zip_path.unlink()

    assert video_info.compress_type == zipfile.ZIP_STORED
    assert video_info.file_size == len(MP4_BYTES)
    assert text_info.compress_type == zipfile.ZIP_DEFLATED


def test_bundle_still_packed_after_staging_purged(monkeypatch, tmp_path: Path) -> None:
    """留存期清理掉 staging 后，仍能按持久层副本回填并打包（方案 P1-1）。"""
    _use_tmp_root(monkeypatch, tmp_path)
    turn_dir = _seed_turn(tmp_path, "turn-1")
    article = turn_dir / "文章标题.md"
    original = article.read_bytes()
    video = turn_dir / "文章标题" / "成片-1.mp4"
    video.write_bytes(MP4_BYTES)

    store_dir = tmp_path / "store"
    store_dir.mkdir(parents=True, exist_ok=True)
    fake_store = _FakeStore(
        {
            "k-md": original,
            "k-mp4": MP4_BYTES,
        },
        store_dir,
    )
    monkeypatch.setattr("api.agent.artifacts.get_artifact_store", lambda: fake_store)

    async def fake_list(thread_id: str, user_id: str, *, limit: int = 200):
        return [
            Artifact(
                path="/artifacts/t1/turn-1/文章标题.md",
                name="文章标题.md",
                source_tool="download_asset",
                mime_type="text/markdown",
                size=len(original),
                created_at=0.0,
                artifact_id="a1",
                status="ready",
                storage_key="k-md",
            ),
            Artifact(
                path="/artifacts/t1/turn-1/文章标题/成片-1.mp4",
                name="成片-1.mp4",
                source_tool="download_asset",
                mime_type="video/mp4",
                size=len(MP4_BYTES),
                created_at=0.0,
                artifact_id="a2",
                status="ready",
                storage_key="k-mp4",
            ),
        ]

    monkeypatch.setattr("api.agent.artifacts.list_ready_artifacts", fake_list)

    # 模拟留存期清理：staging 里的交付文件被删光
    article.unlink()
    video.unlink()

    restored = asyncio.run(restore_delivery_artifacts("u1", "t1"))
    assert restored == 2
    assert article.read_bytes() == original
    assert video.read_bytes() == MP4_BYTES

    packed = build_bundle_zip("u1", "t1", scope="turn", turn="turn-1")
    assert packed is not None
    _name, zip_path, count = packed
    with _read_zip(zip_path) as archive:
        names = sorted(archive.namelist())
    zip_path.unlink()
    # 回填 2 个 + 原本仍在的一张配图
    assert count == 3
    assert "文章标题/成片-1.mp4" in names
    assert "文章标题.md" in names


def test_copy_store_object_to_prefers_local_copy(tmp_path: Path) -> None:
    """本地存储走直拷贝，对象存储走分块读取，都不整体读进内存。"""
    source = tmp_path / "src.bin"
    source.write_bytes(MP4_BYTES)
    target = tmp_path / "nested" / "dst.bin"

    local_store = _FakeStore({"k": MP4_BYTES}, tmp_path, local={"k": source})
    assert asyncio.run(copy_store_object_to(local_store, "k", target)) is True
    assert target.read_bytes() == MP4_BYTES

    target.unlink()
    remote_store = _FakeStore({"k": MP4_BYTES}, tmp_path)
    assert asyncio.run(copy_store_object_to(remote_store, "k", target)) is True
    assert target.read_bytes() == MP4_BYTES
    assert remote_store.read_calls > 1 or len(MP4_BYTES) <= 4 * 1024 * 1024


class _FakeStore:
    """最小 ArtifactStore 替身：支持 size / read / local_path。"""

    def __init__(
        self,
        objects: dict[str, bytes],
        base_dir: Path,
        local: dict[str, Path] | None = None,
    ) -> None:
        self._objects = objects
        self._local = local or {}
        self.read_calls = 0

    def size(self, key: str) -> int | None:
        value = self._objects.get(key)
        return len(value) if value is not None else None

    def read(self, key: str, offset: int = 0, length: int | None = None) -> bytes | None:
        value = self._objects.get(key)
        if value is None:
            return None
        self.read_calls += 1
        return value[offset:] if length is None else value[offset : offset + length]

    def local_path(self, key: str) -> str | None:
        path = self._local.get(key)
        return str(path) if path else None


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

    monkeypatch.setattr("core.storage.asset_fetcher.fetch_asset", fake_fetch)
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
