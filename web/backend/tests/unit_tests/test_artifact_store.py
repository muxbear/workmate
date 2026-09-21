"""产物存储层单元测试（本地磁盘实现与存储键生成）。"""

from pathlib import Path

from core.storage import (
    LocalArtifactStore,
    MinioArtifactStore,
    build_storage_key,
    build_thread_prefix,
    checksum_of,
    get_artifact_store,
    reset_artifact_store,
    sanitize_filename,
)


def test_sanitize_filename_strips_path_and_unsafe_chars() -> None:
    """文件名净化：去掉目录成分与不安全字符，空值回退。"""
    assert sanitize_filename("/workspace/report.md") == "report.md"
    assert sanitize_filename("..\\..\\etc\\passwd") == "passwd"
    assert sanitize_filename("a b*c?.txt") == "a_b_c_.txt"
    assert sanitize_filename("") == "artifact"
    assert sanitize_filename("...") == "artifact"


def test_build_storage_key_and_prefix() -> None:
    """存储键按「用户 / 会话 / 产物 / 文件名」分层。"""
    assert build_thread_prefix("u1", "t1") == "u1/t1"
    assert build_storage_key("u1", "t1", "a1", "/workspace/报告.md") == "u1/t1/a1/报告.md"
    assert build_storage_key("", "", "", "") == (
        "unknown-user/unknown-thread/unknown-artifact/artifact"
    )


def test_local_store_round_trip(tmp_path: Path) -> None:
    """本地存储支持写入、读取、存在判断与删除。"""
    store = LocalArtifactStore(str(tmp_path))
    key = build_storage_key("u1", "t1", "a1", "报告.md")
    assert store.exists(key) is False
    store.save(key, b"hello")
    assert store.exists(key) is True
    assert store.open(key) == b"hello"
    assert store.local_path(key) == str(tmp_path / "u1" / "t1" / "a1" / "报告.md")
    store.delete(key)
    assert store.exists(key) is False
    assert store.open(key) is None


def test_local_store_delete_prefix(tmp_path: Path) -> None:
    """按会话前缀删除会清理该会话下的全部产物文件。"""
    store = LocalArtifactStore(str(tmp_path))
    key1 = build_storage_key("u1", "t1", "a1", "a.txt")
    key2 = build_storage_key("u1", "t1", "a2", "b.txt")
    key3 = build_storage_key("u1", "t2", "a3", "c.txt")
    for key in (key1, key2, key3):
        store.save(key, b"x")
    assert store.delete_prefix(build_thread_prefix("u1", "t1")) == 2
    assert store.exists(key1) is False
    assert store.exists(key3) is True


def test_local_store_keeps_key_inside_root(tmp_path: Path) -> None:
    """越界存储键被规整到根目录内，不会写到根目录之外。"""
    store = LocalArtifactStore(str(tmp_path))
    resolved = store.resolve("../../etc/passwd")
    assert str(resolved).startswith(str(tmp_path))
    assert resolved.name == "passwd"


def test_checksum_of_is_stable() -> None:
    """校验和为内容 sha256 的十六进制串。"""
    assert checksum_of(b"abc") == (
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )


class _FakeNotFound(Exception):
    """模拟 MinIO 的对象不存在异常。"""

    def __init__(self, code: str = "NoSuchKey") -> None:
        super().__init__(code)
        self.code = code


class _FakeResponse:
    """模拟 MinIO 的响应对象（内存字节）。"""

    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def read(self) -> bytes:
        return self._payload

    def close(self) -> None:
        """关闭响应（替身无资源可释放）。"""

    def release_conn(self) -> None:
        """归还连接（替身无连接池）。"""


class _FakeMinioClient:
    """内存版 MinIO 客户端替身，避免单元测试依赖真实对象存储。"""

    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}
        self.buckets: set[str] = set()

    def bucket_exists(self, bucket: str) -> bool:
        return bucket in self.buckets

    def make_bucket(self, bucket: str) -> None:
        self.buckets.add(bucket)

    def put_object(self, bucket, name, data, length=None, content_type=None):
        self.objects[(bucket, name)] = data.read()
        return type("Object", (), {"etag": "fake"})()

    def get_object(self, bucket, name, offset=0, length=None):
        payload = self.objects.get((bucket, name))
        if payload is None:
            raise _FakeNotFound()
        chunk = payload[offset:] if length is None else payload[offset : offset + length]
        return _FakeResponse(chunk)

    def stat_object(self, bucket, name):
        payload = self.objects.get((bucket, name))
        if payload is None:
            raise _FakeNotFound()
        return type("Stat", (), {"size": len(payload)})()

    def remove_object(self, bucket, name) -> None:
        self.objects.pop((bucket, name), None)

    def list_objects(self, bucket, prefix=None, recursive=True):
        names = sorted(
            key[1]
            for key in self.objects
            if key[0] == bucket and (prefix is None or key[1].startswith(prefix))
        )
        return [type("Item", (), {"object_name": name})() for name in names]


def test_minio_store_round_trip() -> None:
    """MinIO 实现支持写入、读取、按偏移读取、大小判断与删除。"""
    store = MinioArtifactStore(
        "127.0.0.1:9000", "ak", "sk", "ke-work", client=_FakeMinioClient()
    )
    key = build_storage_key("u1", "t1", "a1", "报告.md")
    assert store.bucket == "ke-work"
    assert store.exists(key) is False
    store.save(key, b"hello")
    assert store.exists(key) is True
    assert store.open(key) == b"hello"
    assert store.size(key) == 5
    assert store.read(key, 1, 3) == b"ell"
    assert store.local_path(key) is None
    store.delete(key)
    assert store.exists(key) is False
    assert store.open(key) is None


def test_minio_store_delete_prefix() -> None:
    """MinIO 实现按会话前缀删除对象。"""
    store = MinioArtifactStore(
        "127.0.0.1:9000", "ak", "sk", "ke-work", client=_FakeMinioClient()
    )
    key1 = build_storage_key("u1", "t1", "a1", "a.txt")
    key3 = build_storage_key("u1", "t2", "a3", "c.txt")
    store.save(key1, b"1")
    store.save(build_storage_key("u1", "t1", "a2", "b.txt"), b"2")
    store.save(key3, b"3")
    assert store.delete_prefix(build_thread_prefix("u1", "t1")) == 2
    assert store.exists(key1) is False
    assert store.exists(key3) is True


def test_strategy_selects_minio_by_config(monkeypatch) -> None:
    """ARTIFACT_BACKEND=minio 时工厂返回 MinIO 实现。"""
    from agent.config import settings

    monkeypatch.setattr(settings, "ARTIFACT_BACKEND", "minio", raising=False)
    monkeypatch.setattr(settings, "ARTIFACT_MINIO_ENDPOINT", "127.0.0.1:9000", raising=False)
    monkeypatch.setattr(settings, "ARTIFACT_MINIO_ACCESS_KEY", "ak", raising=False)
    monkeypatch.setattr(settings, "ARTIFACT_MINIO_SECRET_KEY", "sk", raising=False)
    monkeypatch.setattr(settings, "ARTIFACT_MINIO_BUCKET", "ke-work", raising=False)
    reset_artifact_store()
    store = get_artifact_store()
    assert isinstance(store, MinioArtifactStore)
    assert store.bucket == "ke-work"
    reset_artifact_store()


def test_strategy_falls_back_to_local(monkeypatch) -> None:
    """MinIO 配置缺失或实现名未知时回退到本地磁盘。"""
    from agent.config import settings

    monkeypatch.setattr(settings, "ARTIFACT_BACKEND", "minio", raising=False)
    monkeypatch.setattr(settings, "ARTIFACT_MINIO_ENDPOINT", "", raising=False)
    monkeypatch.setattr(settings, "ARTIFACT_MINIO_ACCESS_KEY", "", raising=False)
    monkeypatch.setattr(settings, "ARTIFACT_MINIO_SECRET_KEY", "", raising=False)
    reset_artifact_store()
    assert isinstance(get_artifact_store(), LocalArtifactStore)

    monkeypatch.setattr(settings, "ARTIFACT_BACKEND", "unknown-backend", raising=False)
    reset_artifact_store()
    assert isinstance(get_artifact_store(), LocalArtifactStore)
    reset_artifact_store()


def test_local_store_list_keys(tmp_path: Path) -> None:
    """本地存储可列举对象键，并支持按修改时间过滤。"""
    store = LocalArtifactStore(str(tmp_path))
    key1 = build_storage_key("u1", "t1", "a1", "a.txt")
    key2 = build_storage_key("u1", "t2", "a2", "b.txt")
    store.save(key1, b"1")
    store.save(key2, b"2")
    assert sorted(store.list_keys()) == sorted([key1, key2])
    assert store.list_keys(older_than_seconds=3600) == []


def test_minio_store_list_keys() -> None:
    """MinIO 实现可列举存储桶中的对象键。"""
    store = MinioArtifactStore(
        "127.0.0.1:9000", "ak", "sk", "ke-work", client=_FakeMinioClient()
    )
    key = build_storage_key("u1", "t1", "a1", "a.txt")
    store.save(key, b"1")
    assert store.list_keys() == [key]
