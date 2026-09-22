"""会话产物路径解析与元信息单元测试。"""

import json

from api.agent.artifacts import (
    Artifact,
    extract_artifact_paths,
    guess_mime_type,
    pick_turn_artifacts,
)


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


def test_turn_of_path() -> None:
    """交付路径解析出轮次，非交付路径与无轮次路径返回空串。"""
    from api.agent.artifacts import turn_of

    assert turn_of("/artifacts/t1/turn-2/文章.md") == "turn-2"
    assert turn_of("/artifacts/t1/turn-2/文章/figure-1.png") == "turn-2"
    assert turn_of("/artifacts/t1/文章.md") == ""
    assert turn_of("/workspace/a.md") == ""


def test_artifact_to_dict_contains_turn() -> None:
    """产物字典包含交付轮次，供前端按轮分组展示。"""
    item = Artifact(
        path="/artifacts/t1/turn-3/文章.md",
        name="文章.md",
        source_tool="write_file",
        mime_type="text/markdown",
        size=10,
        created_at=1.0,
        turn="turn-3",
    )
    assert item.to_dict()["turn"] == "turn-3"


def _artifact(path: str, artifact_id: str = "") -> Artifact:
    """构造用例产物（仅用于本轮交付物挑选用例）。"""
    return Artifact(
        path=path,
        name=path.rsplit("/", 1)[-1],
        source_tool="download_asset",
        mime_type=guess_mime_type(path),
        size=10,
        created_at=1.0,
        artifact_id=artifact_id,
    )


def test_pick_turn_artifacts_returns_unpushed_items_of_current_turn() -> None:
    """按「交付目录 + 已推送集合」求差集，工具内直登的交付物也能被推送。"""
    items = [
        _artifact("/artifacts/t1/turn-1/文章/figure-1.png", "a1"),
        _artifact("/artifacts/t1/turn-1/文章.md", "a2"),
        _artifact("/artifacts/t1/turn-2/下一轮.md", "a3"),
        _artifact("/workspace/other.md", "a4"),
    ]
    emitted: set[str] = set()

    picked = pick_turn_artifacts(items, "/artifacts/t1/turn-1", emitted)
    assert [item.artifact_id for item in picked] == ["a1", "a2"]
    assert emitted == {"a1", "a2"}

    # 幂等：同一批再次调用不再重复推送
    assert pick_turn_artifacts(items, "/artifacts/t1/turn-1", emitted) == []

    # 进入下一轮后只推送该轮产物
    picked_next = pick_turn_artifacts(items, "/artifacts/t1/turn-2", emitted)
    assert [item.artifact_id for item in picked_next] == ["a3"]


def test_pick_turn_artifacts_without_delivery_dir_is_noop() -> None:
    """未提供交付目录（非交付场景）时不推送任何事件。"""
    items = [_artifact("/artifacts/t1/turn-1/文章.md", "a1")]
    emitted: set[str] = set()

    assert pick_turn_artifacts(items, "", emitted) == []
    assert emitted == set()


def test_pick_turn_artifacts_falls_back_to_path_as_key() -> None:
    """缺少 artifact_id 的存量数据按路径去重，避免重复推送。"""
    items = [_artifact("/artifacts/t1/turn-1/文章.md")]
    emitted: set[str] = set()

    assert len(pick_turn_artifacts(items, "/artifacts/t1/turn-1", emitted)) == 1
    assert pick_turn_artifacts(items, "/artifacts/t1/turn-1", emitted) == []
