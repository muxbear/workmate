"""产物回灌中间件单元测试。"""

import asyncio
from types import SimpleNamespace

from agent.middleware.artifact_restore import ArtifactRestoreMiddleware
from api.agent.artifacts import STATUS_READY, Artifact
from core.storage import LocalArtifactStore, build_storage_key


class _FakeBackend:
    """记录上传与探测调用的沙箱后端替身。"""

    def __init__(self, sandbox_id: str = "sbx-1", existing: tuple[str, ...] = ()) -> None:
        self.id = sandbox_id
        self.existing = set(existing)
        self.uploaded: list[tuple[str, bytes]] = []
        self.commands: list[str] = []

    def execute(self, command: str, *, timeout: int | None = None):
        self.commands.append(command)
        path = command[len("test -e ") :].strip().strip("'")
        code = 0 if path in self.existing else 1
        return SimpleNamespace(exit_code=code, output="")

    async def aupload_files(self, files):
        """记录上传的产物并返回成功响应。"""
        self.uploaded.extend(files)
        return [SimpleNamespace(path=path, error=None) for path, _ in files]


class _FakeSandboxManager:
    """返回固定后端替身的沙箱管理器。"""

    def __init__(self, backend: _FakeBackend) -> None:
        self._backend = backend

    def get_or_create_backend(self, user_id: str) -> _FakeBackend:
        return self._backend


def _artifact(storage_key: str, path: str = "/workspace/w1/报告.md") -> Artifact:
    return Artifact(
        path=path,
        name="报告.md",
        source_tool="write_file",
        mime_type="text/markdown",
        size=7,
        created_at=1.0,
        artifact_id="a1",
        status=STATUS_READY,
        storage_key=storage_key,
    )


def _prepare(tmp_path, monkeypatch, items: list[Artifact], backend: _FakeBackend):
    store = LocalArtifactStore(str(tmp_path))
    monkeypatch.setattr("core.storage.get_artifact_store", lambda: store)

    async def _list(thread_id: str, user_id: str, *, limit: int = 20) -> list[Artifact]:
        return items

    monkeypatch.setattr("api.agent.artifacts.list_ready_artifacts", _list)
    middleware = ArtifactRestoreMiddleware(sandbox_manager=_FakeSandboxManager(backend))
    runtime = SimpleNamespace(context=SimpleNamespace(user_id="u1"))
    config = {"configurable": {"thread_id": "t1"}}
    return store, middleware, runtime, config


def test_restore_uploads_missing_artifact(tmp_path, monkeypatch) -> None:
    """沙箱内缺失的产物会被回灌，并写入回灌标记。"""
    store = LocalArtifactStore(str(tmp_path))
    key = build_storage_key("u1", "t1", "a1", "报告.md")
    store.save(key, b"content")
    backend = _FakeBackend()
    _, middleware, runtime, config = _prepare(tmp_path, monkeypatch, [_artifact(key)], backend)

    result = asyncio.run(middleware.abefore_agent({}, runtime, config))

    assert backend.uploaded == [("/workspace/w1/报告.md", b"content")]
    assert result == {"_artifacts_restored": "sbx-1::t1"}


def test_restore_skips_existing_and_repeated_runs(tmp_path, monkeypatch) -> None:
    """沙箱内已存在的文件不覆盖；同一沙箱与会话不重复回灌。"""
    store = LocalArtifactStore(str(tmp_path))
    key = build_storage_key("u1", "t1", "a1", "报告.md")
    store.save(key, b"newer")
    backend = _FakeBackend(existing=("/workspace/w1/报告.md",))
    _, middleware, runtime, config = _prepare(tmp_path, monkeypatch, [_artifact(key)], backend)

    first = asyncio.run(middleware.abefore_agent({}, runtime, config))
    assert backend.uploaded == []
    assert first == {"_artifacts_restored": "sbx-1::t1"}

    backend.existing.clear()
    again = asyncio.run(middleware.abefore_agent(first, runtime, config))
    assert again is None
    assert backend.uploaded == []


def test_restore_runs_again_after_sandbox_recreated(tmp_path, monkeypatch) -> None:
    """沙箱 ID 变化（TTL 重建）后会重新回灌。"""
    store = LocalArtifactStore(str(tmp_path))
    key = build_storage_key("u1", "t1", "a1", "报告.md")
    store.save(key, b"content")
    backend = _FakeBackend(sandbox_id="sbx-2")
    _, middleware, runtime, config = _prepare(tmp_path, monkeypatch, [_artifact(key)], backend)

    result = asyncio.run(
        middleware.abefore_agent({"_artifacts_restored": "sbx-1::t1"}, runtime, config)
    )

    assert backend.uploaded == [("/workspace/w1/报告.md", b"content")]
    assert result == {"_artifacts_restored": "sbx-2::t1"}


def test_restore_without_context_is_noop() -> None:
    """缺少用户上下文或会话 ID 时不做任何事。"""
    backend = _FakeBackend()
    middleware = ArtifactRestoreMiddleware(sandbox_manager=_FakeSandboxManager(backend))
    runtime = SimpleNamespace(context=None)

    assert asyncio.run(middleware.abefore_agent({}, runtime, {"configurable": {}})) is None
    assert backend.uploaded == []


def test_restore_skips_agent_delivery_directory(tmp_path, monkeypatch) -> None:
    """交付目录（/artifacts/）的产物由宿主 staging 提供，不回灌到沙箱。"""
    store = LocalArtifactStore(str(tmp_path))
    key = build_storage_key("u1", "t1", "a1", "报告.md")
    store.save(key, b"content")
    backend = _FakeBackend()
    item = _artifact(key, path="/artifacts/报告.md")
    _, middleware, runtime, config = _prepare(tmp_path, monkeypatch, [item], backend)

    result = asyncio.run(middleware.abefore_agent({}, runtime, config))

    assert backend.uploaded == []
    assert result == {"_artifacts_restored": "sbx-1::t1"}
