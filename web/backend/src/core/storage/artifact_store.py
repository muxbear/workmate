"""产物持久化存储层：把沙箱内生成的文件长期保存到后端宿主或对象存储。

默认实现为本地磁盘（``{WORKSPACE}/artifacts``），可通过 ``ARTIFACT_BACKEND``
切换为 MinIO（S3 兼容）对象存储；实现之间通过策略注册表选择，新增存储只需注册构造器。
对外只暴露按键读写的最小接口，路径解析与安全校验集中在存储层内部完成。
"""

from __future__ import annotations

import hashlib
import io
import logging
import re
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

logger = logging.getLogger(__name__)

# 存储键与文件名中允许保留的字符（中文、英文、数字、下划线、短横线、点）
_UNSAFE_RE = re.compile(r"[^\w.\-]+", re.UNICODE)
# 单段名称长度上限
_MAX_SEGMENT_LENGTH = 120
# 无法从标识符得到有效片段时的兜底值
_FALLBACKS = ("unknown-user", "unknown-thread", "unknown-artifact")


def sanitize_filename(raw: str) -> str:
    """净化文件名：去掉目录成分与不安全字符，空值回退为 ``artifact``。"""
    name = (raw or "").replace("\\", "/").rsplit("/", 1)[-1].strip()
    name = _UNSAFE_RE.sub("_", name).strip("._")
    if not name:
        return "artifact"
    if len(name) <= _MAX_SEGMENT_LENGTH:
        return name
    suffix = Path(name).suffix
    keep = max(1, _MAX_SEGMENT_LENGTH - len(suffix))
    return name[:keep] + suffix


def normalize_key(key: str) -> str:
    """把存储键规整为以 ``/`` 分隔的对象名（丢弃空段与越界片段）。

    Args:
        key: 形如 ``用户/会话/产物/文件名`` 的存储键或前缀。

    Returns:
        规整后的存储键。

    Raises:
        ValueError: 存储键为空或不含有效片段。
    """
    parts = [
        part
        for part in str(key or "").replace("\\", "/").split("/")
        if part not in ("", ".", "..")
    ]
    if not parts:
        raise ValueError("非法的存储键")
    return "/".join(parts)


def _segment(raw: str, fallback: str) -> str:
    """把标识符转换为安全的单层目录名。"""
    value = _UNSAFE_RE.sub("_", (raw or "").strip()).strip("._")
    return value or fallback


def build_thread_prefix(user_id: str, thread_id: str) -> str:
    """生成会话级存储前缀：``用户 / 会话``。"""
    return "/".join(
        (
            _segment(user_id, _FALLBACKS[0]),
            _segment(thread_id, _FALLBACKS[1]),
        )
    )


def build_storage_key(
    user_id: str, thread_id: str, artifact_id: str, filename: str
) -> str:
    """生成产物存储键：``用户 / 会话 / 产物 / 文件名``。"""
    return "/".join(
        (
            build_thread_prefix(user_id, thread_id),
            _segment(artifact_id, _FALLBACKS[2]),
            sanitize_filename(filename),
        )
    )


def checksum_of(content: bytes) -> str:
    """计算字节内容的 sha256（用于幂等与覆盖判定）。"""
    return hashlib.sha256(content).hexdigest()


def _is_not_found(error: Exception) -> bool:
    """判断存储异常是否表示对象 / 桶不存在（兼容 MinIO 的 S3Error 与通用 404）。"""
    code = str(getattr(error, "code", "") or "")
    return code in ("NoSuchKey", "NoSuchObject", "NoSuchBucket", "NoSuchUpload", "404")


class ArtifactStore(Protocol):
    """产物存储接口（本地磁盘与对象存储共用同一契约）。"""

    def save(self, key: str, content: bytes) -> None:
        """写入对象内容（同名对象直接覆盖）。"""
        ...

    def open(self, key: str) -> bytes | None:
        """读取对象全部内容；对象不存在时返回 ``None``。"""
        ...

    def read(self, key: str, offset: int = 0, length: int | None = None) -> bytes | None:
        """按偏移与长度读取对象内容；对象不存在时返回 ``None``。"""
        ...

    def size(self, key: str) -> int | None:
        """返回对象字节数；对象不存在时返回 ``None``。"""
        ...

    def exists(self, key: str) -> bool:
        """判断对象是否存在。"""
        ...

    def delete(self, key: str) -> None:
        """删除单个对象（对象不存在时静默返回）。"""
        ...

    def delete_prefix(self, prefix: str) -> int:
        """删除前缀下的全部对象，返回删除数量。"""
        ...

    def local_path(self, key: str) -> str | None:
        """返回对象的本地绝对路径；非本地实现返回 ``None``。"""
        ...

    def list_keys(self, *, older_than_seconds: float | None = None) -> list[str]:
        """列出全部对象键，可按最后修改时间过滤（用于孤儿对象清理）。"""
        ...


class LocalArtifactStore:
    """本地磁盘实现：对象落在 ``存储根目录 / 存储键``。"""

    def __init__(self, root: str) -> None:
        """记录存储根目录。

        Args:
            root: 存储根目录，目录不存在时在首次写入时自动创建。
        """
        self._root = Path(root).expanduser()

    @property
    def root(self) -> Path:
        """返回存储根目录。"""
        return self._root

    def resolve(self, key: str) -> Path:
        """把存储键解析为根目录内的绝对路径。

        Args:
            key: 形如 ``用户 / 会话 / 产物 / 文件名`` 的存储键或前缀。

        Returns:
            根目录内的绝对路径。
        """
        return self._root.joinpath(*normalize_key(key).split("/"))

    def save(self, key: str, content: bytes) -> None:
        """写入对象内容（同名对象直接覆盖）。"""
        target = self.resolve(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)

    def open(self, key: str) -> bytes | None:
        """读取对象全部内容；对象不存在时返回 ``None``。"""
        try:
            return self.resolve(key).read_bytes()
        except FileNotFoundError:
            return None

    def read(self, key: str, offset: int = 0, length: int | None = None) -> bytes | None:
        """按偏移与长度读取对象内容（用于 HTTP Range 请求）。"""
        try:
            with self.resolve(key).open("rb") as handle:
                if offset:
                    handle.seek(offset)
                return handle.read() if length is None else handle.read(length)
        except FileNotFoundError:
            return None

    def size(self, key: str) -> int | None:
        """返回对象字节数；对象不存在时返回 ``None``。"""
        try:
            return self.resolve(key).stat().st_size
        except FileNotFoundError:
            return None

    def exists(self, key: str) -> bool:
        """判断对象是否存在。"""
        return self.resolve(key).is_file()

    def delete(self, key: str) -> None:
        """删除单个对象（对象不存在时静默返回）。"""
        try:
            self.resolve(key).unlink()
        except FileNotFoundError:
            return

    def delete_prefix(self, prefix: str) -> int:
        """删除前缀下的全部对象，返回删除数量。"""
        base = self.resolve(prefix)
        if not base.exists():
            return 0
        if base.is_file():
            base.unlink()
            return 1
        removed = 0
        for path in sorted(base.rglob("*"), reverse=True):
            if path.is_file():
                path.unlink()
                removed += 1
            else:
                try:
                    path.rmdir()
                except OSError:
                    continue
        return removed

    def local_path(self, key: str) -> str | None:
        """返回对象的本地绝对路径。"""
        return str(self.resolve(key))

    def list_keys(self, *, older_than_seconds: float | None = None) -> list[str]:
        """列出存储根目录下的全部对象键，可按最后修改时间过滤。"""
        if not self._root.exists():
            return []
        now = time.time()
        keys: list[str] = []
        for path in self._root.rglob("*"):
            if not path.is_file():
                continue
            if older_than_seconds is not None:
                try:
                    if now - path.stat().st_mtime <= older_than_seconds:
                        continue
                except OSError:
                    continue
            keys.append(path.relative_to(self._root).as_posix())
        return keys


class MinioArtifactStore:
    """MinIO（S3 兼容）实现：对象落在 ``桶 / 存储键``。"""

    def __init__(
        self,
        endpoint: str,
        access_key: str,
        secret_key: str,
        bucket: str,
        *,
        secure: bool = False,
        region: str = "",
        client: Any = None,
    ) -> None:
        """记录连接参数并创建客户端。

        Args:
            endpoint: MinIO 服务地址，形如 ``127.0.0.1:9000``。
            access_key: 访问密钥。
            secret_key: 私密密钥。
            bucket: 存储桶名称。
            secure: 是否使用 HTTPS。
            region: 区域，一般留空。
            client: 已构造的客户端（测试注入用；为空时按参数创建）。
        """
        self._bucket = bucket
        self._bucket_ready = False
        self._client: Any = client or _create_minio_client(
            endpoint, access_key, secret_key, secure=secure, region=region
        )

    @property
    def bucket(self) -> str:
        """返回存储桶名称。"""
        return self._bucket

    def ensure_bucket(self) -> None:
        """确保存储桶存在（幂等，成功后不再重复检查）。"""
        if self._bucket_ready:
            return
        if not self._client.bucket_exists(self._bucket):
            self._client.make_bucket(self._bucket)
        self._bucket_ready = True

    def save(self, key: str, content: bytes) -> None:
        """写入对象内容（同名对象直接覆盖）。"""
        self.ensure_bucket()
        self._client.put_object(
            self._bucket,
            normalize_key(key),
            io.BytesIO(content),
            length=len(content),
            content_type="application/octet-stream",
        )

    def open(self, key: str) -> bytes | None:
        """读取对象全部内容；对象不存在时返回 ``None``。"""
        return self.read(key, 0, None)

    def read(self, key: str, offset: int = 0, length: int | None = None) -> bytes | None:
        """按偏移与长度读取对象内容（用于 HTTP Range 请求）。"""
        try:
            response = self._client.get_object(
                self._bucket, normalize_key(key), offset=offset, length=length
            )
        except Exception as error:
            if _is_not_found(error):
                return None
            raise
        try:
            return bytes(response.read())
        finally:
            response.close()
            response.release_conn()

    def size(self, key: str) -> int | None:
        """返回对象字节数；对象不存在时返回 ``None``。"""
        try:
            stat = self._client.stat_object(self._bucket, normalize_key(key))
        except Exception as error:
            if _is_not_found(error):
                return None
            raise
        return int(getattr(stat, "size", 0) or 0)

    def exists(self, key: str) -> bool:
        """判断对象是否存在。"""
        return self.size(key) is not None

    def delete(self, key: str) -> None:
        """删除单个对象（对象不存在时静默返回）。"""
        try:
            self._client.remove_object(self._bucket, normalize_key(key))
        except Exception as error:
            if _is_not_found(error):
                return
            raise

    def delete_prefix(self, prefix: str) -> int:
        """删除前缀下的全部对象，返回删除数量。"""
        name_prefix = normalize_key(prefix).rstrip("/") + "/"
        removed = 0
        for item in self._client.list_objects(
            self._bucket, prefix=name_prefix, recursive=True
        ):
            object_name = str(getattr(item, "object_name", ""))
            if not object_name:
                continue
            self._client.remove_object(self._bucket, object_name)
            removed += 1
        return removed

    def local_path(self, key: str) -> str | None:
        """对象存储没有本地路径，固定返回 ``None``。"""
        return None

    def list_keys(self, *, older_than_seconds: float | None = None) -> list[str]:
        """列出存储桶中的全部对象键，可按最后修改时间过滤。"""
        threshold = None
        if older_than_seconds is not None:
            threshold = datetime.now(UTC) - timedelta(seconds=older_than_seconds)
        keys: list[str] = []
        try:
            for item in self._client.list_objects(self._bucket, recursive=True):
                name = str(getattr(item, "object_name", ""))
                if not name:
                    continue
                if threshold is not None:
                    last_modified = getattr(item, "last_modified", None)
                    if last_modified is not None and last_modified > threshold:
                        continue
                keys.append(name)
        except Exception as error:
            if _is_not_found(error):
                return []
            raise
        return keys


def _create_minio_client(
    endpoint: str, access_key: str, secret_key: str, *, secure: bool, region: str
) -> Any:
    """创建 MinIO 客户端（惰性导入，未启用对象存储时不引入依赖开销）。"""
    from minio import Minio

    return Minio(
        endpoint,
        access_key=access_key,
        secret_key=secret_key,
        secure=secure,
        region=region or None,
    )


# ---- 存储策略注册表 ----

_STORE: ArtifactStore | None = None
_BACKEND_BUILDERS: dict[str, Callable[[], ArtifactStore]] = {}


def register_artifact_backend(name: str, builder: Callable[[], ArtifactStore]) -> None:
    """注册产物存储实现（策略模式扩展点，新增存储只需在此注册）。"""
    _BACKEND_BUILDERS[name.strip().lower()] = builder


def _build_local_store() -> ArtifactStore:
    """构造本地磁盘实现。"""
    from agent.config import settings

    return LocalArtifactStore(getattr(settings, "ARTIFACT_ROOT", "") or "artifacts")


def _build_minio_store() -> ArtifactStore:
    """构造 MinIO 实现；配置不完整时抛出异常，由工厂回退本地磁盘。"""
    from agent.config import settings

    endpoint = (getattr(settings, "ARTIFACT_MINIO_ENDPOINT", "") or "").strip()
    access_key = (getattr(settings, "ARTIFACT_MINIO_ACCESS_KEY", "") or "").strip()
    secret_key = (getattr(settings, "ARTIFACT_MINIO_SECRET_KEY", "") or "").strip()
    if not (endpoint and access_key and secret_key):
        raise ValueError(
            "MinIO 存储缺少 ARTIFACT_MINIO_ENDPOINT / ACCESS_KEY / SECRET_KEY 配置"
        )
    return MinioArtifactStore(
        endpoint=endpoint,
        access_key=access_key,
        secret_key=secret_key,
        bucket=(getattr(settings, "ARTIFACT_MINIO_BUCKET", "") or "ke-work-artifacts"),
        secure=bool(getattr(settings, "ARTIFACT_MINIO_SECURE", False)),
        region=(getattr(settings, "ARTIFACT_MINIO_REGION", "") or ""),
    )


register_artifact_backend("local", _build_local_store)
register_artifact_backend("minio", _build_minio_store)


def get_artifact_store() -> ArtifactStore:
    """按 ``ARTIFACT_BACKEND`` 选择产物存储实现（策略模式，异常时回退本地磁盘）。"""
    from agent.config import settings

    global _STORE
    if _STORE is None:
        backend = (getattr(settings, "ARTIFACT_BACKEND", "local") or "local").strip().lower()
        builder = _BACKEND_BUILDERS.get(backend)
        if builder is None:
            logger.warning("未知的产物存储实现 %s，已回退为本地磁盘", backend)
            builder = _BACKEND_BUILDERS["local"]
        try:
            _STORE = builder()
        except Exception:
            logger.exception("产物存储实现 %s 初始化失败，已回退为本地磁盘", backend)
            _STORE = _BACKEND_BUILDERS["local"]()
        logger.info("产物存储实现：%s", _STORE.__class__.__name__)
    return _STORE


def reset_artifact_store() -> None:
    """重置全局存储实例（测试或配置变更后调用）。"""
    global _STORE
    _STORE = None
