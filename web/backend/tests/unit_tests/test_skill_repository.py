import asyncio
import io
import pathlib
import tarfile
import zipfile

import pytest
from fastapi import HTTPException
from starlette.datastructures import UploadFile

from api.skill import repository, service


class _FakeDb:
    """记录 db.add 调用的最小替身."""

    def __init__(self) -> None:
        self.added: list[object] = []

    def add(self, obj: object) -> None:
        self.added.append(obj)


def _zip_bytes(files: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return buffer.getvalue()


def _upload(data: bytes, filename: str) -> UploadFile:
    return UploadFile(file=io.BytesIO(data), filename=filename)


def _tar_bytes(entries: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, content in entries.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
    return buffer.getvalue()


def test_upload_rejects_invalid_skill_without_persisting(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """缺陷 DEF-01：校验失败的技能不落盘、不入库."""
    monkeypatch.setattr(service, "SKILLS_DIR", str(tmp_path / "skills_upload"))
    package = _zip_bytes(
        {
            "bad-skill/SKILL.md": "---\nname: bad-skill\n---\n",
            "bad-skill/scripts/run.py": "print(1)\n",
        }
    )
    db = _FakeDb()

    result = asyncio.run(service.process_skills_upload(_upload(package, "bad.zip"), db))

    assert result.invalid_count == 1
    assert result.valid_count == 0
    assert db.added == []
    assert not (tmp_path / "skills_upload" / "bad-skill").exists()


def test_upload_keeps_valid_skill(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """校验通过的技能仍然正常落盘入库."""
    monkeypatch.setattr(service, "SKILLS_DIR", str(tmp_path / "skills_upload"))
    package = _zip_bytes(
        {
            "good-skill/SKILL.md": "---\nname: good-skill\ndescription: demo\n---\n",
            "good-skill/scripts/run.py": "print(1)\n",
        }
    )
    db = _FakeDb()

    result = asyncio.run(service.process_skills_upload(_upload(package, "good.zip"), db))

    assert result.valid_count == 1
    assert len(db.added) == 1
    assert (tmp_path / "skills_upload" / "good-skill" / "SKILL.md").is_file()


def test_repository_sources_registered() -> None:
    """默认注册权威技能仓库来源."""
    sources = repository.list_sources()
    ids = {item.id for item in sources}
    assert {"anthropic-official", "superpowers"} <= ids
    assert all(item.repository and item.homepage for item in sources)


def test_scan_tarball_only_returns_skill_dirs_with_skill_md() -> None:
    """只有包含 SKILL.md 的目录才算技能，并保留其文件清单."""
    data = _tar_bytes(
        {
            "repo-main/skills/alpha/SKILL.md": b"---\nname: alpha\ndescription: demo\n---\n",
            "repo-main/skills/alpha/scripts/run.py": b"print(1)\n",
            "repo-main/skills/beta/README.md": b"not a skill\n",
        }
    )

    skill_md, dir_files = repository._scan_tarball(data, "skills")

    assert list(skill_md) == ["alpha"]
    assert dir_files == {"alpha": ["SKILL.md", "scripts/run.py"]}


def test_extract_skill_files_rejects_path_traversal(tmp_path: pathlib.Path) -> None:
    """仓库快照中的路径穿越条目必须被拒绝."""
    data = _tar_bytes(
        {
            "repo-main/skills/alpha/SKILL.md": b"---\nname: alpha\ndescription: demo\n---\n",
            "repo-main/skills/alpha/../../evil.txt": b"evil\n",
        }
    )

    with pytest.raises(HTTPException):
        repository._extract_skill_files(data, "skills", "alpha", str(tmp_path))


def test_extract_skill_files_writes_relative_layout(tmp_path: pathlib.Path) -> None:
    """正常技能包按相对路径落盘."""
    data = _tar_bytes(
        {
            "repo-main/skills/alpha/SKILL.md": b"---\nname: alpha\ndescription: demo\n---\n",
            "repo-main/skills/alpha/scripts/run.py": b"print(1)\n",
        }
    )

    total = repository._extract_skill_files(data, "skills", "alpha", str(tmp_path))

    assert total > 0
    assert (tmp_path / "SKILL.md").is_file()
    assert (tmp_path / "scripts" / "run.py").is_file()


def test_parse_metadata_reads_frontmatter() -> None:
    """frontmatter 中的名称、描述、许可证与分类被正确解析."""
    markdown = (
        "---\nname: alpha\ndescription: demo skill\nlicense: MIT\ncategory: code\n---\n"
    )

    display, description, license_name, category = repository._parse_metadata(
        markdown, "fallback"
    )

    assert display == "alpha"
    assert description == "demo skill"
    assert license_name == "MIT"
    assert category == "code"


def test_parse_metadata_falls_back_to_dir_name() -> None:
    """无法解析 frontmatter 时回退目录名与默认分类."""
    display, description, license_name, category = repository._parse_metadata(
        "no frontmatter", "fallback"
    )

    assert display == "fallback"
    assert description == ""
    assert license_name == ""
    assert category == "custom"