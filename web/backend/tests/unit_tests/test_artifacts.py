"""会话产物路径解析与元信息单元测试。"""

import json

from api.agent.artifacts import Artifact, extract_artifact_paths, guess_mime_type


def _input(**kwargs: str) -> str:
    """构造工具入参 JSON 字符串。"""
    return json.dumps(kwargs)


def test_write_tool_yields_artifact() -> None:
    """写文件类工具按 file_path 提取产物。"""
    payload = _input(file_path="/workspace/report.md", content="hi")
    assert extract_artifact_paths("write_file", payload) == ["/workspace/report.md"]


def test_edit_tool_and_alias() -> None:
    """edit 与 file_ops:write_file 命名均可识别，并支持 path 字段。"""
    assert extract_artifact_paths("edit_file", _input(path="/workspace/a.txt")) == [
        "/workspace/a.txt"
    ]
    assert extract_artifact_paths(
        "file_ops:write_file", _input(path="/workspace/b.md")
    ) == ["/workspace/b.md"]


def test_shell_redirect_yields_artifact() -> None:
    """shell 重定向目标视为产物。"""
    command = "python gen.py > /workspace/out.csv"
    assert extract_artifact_paths("execute", _input(command=command)) == [
        "/workspace/out.csv"
    ]


def test_system_paths_and_read_tools_are_ignored() -> None:
    """系统目录与只读类工具不产生产物。"""
    assert extract_artifact_paths("write_file", _input(file_path="/usr/lib/x.py")) == []
    assert extract_artifact_paths("read_file", _input(file_path="/workspace/a.txt")) == []
    assert extract_artifact_paths("write_file", "not-json") == []


def test_guess_mime_type() -> None:
    """按扩展名推断产物 MIME 类型，未知类型回落为二进制。"""
    assert guess_mime_type("/workspace/report.md") == "text/markdown"
    assert guess_mime_type("/workspace/photo.PNG") == "image/png"
    assert guess_mime_type("/workspace/data.unknownext") == "application/octet-stream"
    assert guess_mime_type("/workspace/noext") == "application/octet-stream"


def test_artifact_to_dict() -> None:
    """产物字典包含路径、名称、类型、大小与来源工具。"""
    item = Artifact(
        path="/workspace/report.md",
        name="report.md",
        source_tool="write_file",
        mime_type="text/markdown",
        size=128,
        created_at=1.0,
    )
    payload = item.to_dict()
    assert payload["name"] == "report.md"
    assert payload["mime_type"] == "text/markdown"
    assert payload["size"] == 128


def test_artifact_to_dict_contains_persistence_fields() -> None:
    """产物字典包含持久化标识与状态，供前端区分就绪 / 过期。"""
    item = Artifact(
        path="/workspace/report.md",
        name="report.md",
        source_tool="write_file",
        mime_type="text/markdown",
        size=128,
        created_at=1.0,
        artifact_id="aid-1",
        status="ready",
        storage_key="u/t/a/report.md",
    )
    payload = item.to_dict()
    assert payload["artifact_id"] == "aid-1"
    assert payload["status"] == "ready"
