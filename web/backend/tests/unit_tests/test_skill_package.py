"""Unit tests for skill package manifest and zip building."""
import hashlib
import io
import zipfile
from pathlib import Path

import pytest

from api.skill import service
from db.models.skill import Skill


def _make_skill(name: str = "web-search", prompt: str = "") -> Skill:
    """构造未入库的技能记录（只用于纯函数测试）。"""
    skill = Skill(name=name, description="demo", prompt=prompt, category="custom")
    skill.id = "abcdef12-3456-7890-abcd-ef1234567890"
    return skill


def _write_package(root: Path, skill_dir_name: str) -> Path:
    """在临时目录写入一个符合 Agent Skills 规范的技能包。"""
    skill_dir = root / skill_dir_name
    (skill_dir / "scripts").mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {skill_dir_name}\ndescription: demo\n---\n", encoding="utf-8"
    )
    (skill_dir / "scripts" / "run.py").write_text("print(1)\n", encoding="utf-8")
    return skill_dir


def test_manifest_keeps_layout_and_hash_matches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """清单保持技能目录结构，且指纹与文件 sha256 可复算一致。"""
    monkeypatch.setattr(service, "SKILLS_DIR", str(tmp_path))
    skill = _make_skill()
    _write_package(tmp_path, "web-search")

    manifest = service.build_skill_manifest(skill)

    assert manifest.id == skill.id
    assert manifest.dir_name == "web-search"
    assert [item.path for item in manifest.files] == ["SKILL.md", "scripts/run.py"]

    hasher = hashlib.sha256()
    for item in manifest.files:
        hasher.update(item.path.encode("utf-8"))
        hasher.update(item.sha256.encode("ascii"))
    assert manifest.hash == hasher.hexdigest()


def test_zip_keeps_relative_paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """下载 zip 内为技能根目录下的相对路径。"""
    monkeypatch.setattr(service, "SKILLS_DIR", str(tmp_path))
    skill = _make_skill()
    _write_package(tmp_path, "web-search")

    filename, content = service.build_skill_zip(skill)

    assert filename == "web-search.zip"
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        assert sorted(archive.namelist()) == ["SKILL.md", "scripts/run.py"]


def test_non_ascii_name_generates_minimal_package(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """中文等不合规名称回退 skill-<id 前 8 位> 并生成最小 SKILL.md。"""
    monkeypatch.setattr(service, "SKILLS_DIR", str(tmp_path))
    skill = _make_skill(name="网络搜索", prompt="你是搜索专家")

    manifest = service.build_skill_manifest(skill)

    assert manifest.dir_name == "skill-abcdef12"
    assert [item.path for item in manifest.files] == ["SKILL.md"]
    skill_md = tmp_path / "skill-abcdef12" / "SKILL.md"
    assert skill_md.is_file()
    assert "name: skill-abcdef12" in skill_md.read_text(encoding="utf-8")


def test_runtime_dir_excluded_from_package(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """技能私有 .runtime/ 运行环境不进入 manifest 与 zip。"""
    monkeypatch.setattr(service, "SKILLS_DIR", str(tmp_path))
    skill = _make_skill()
    skill_dir = _write_package(tmp_path, "web-search")
    runtime_dir = skill_dir / ".runtime"
    runtime_dir.mkdir()
    (runtime_dir / "runtime.json").write_text("{}", encoding="utf-8")

    manifest = service.build_skill_manifest(skill)
    _, content = service.build_skill_zip(skill)

    assert [item.path for item in manifest.files] == ["SKILL.md", "scripts/run.py"]
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        assert sorted(archive.namelist()) == ["SKILL.md", "scripts/run.py"]
