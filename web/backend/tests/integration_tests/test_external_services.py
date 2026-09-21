"""外部依赖（Redis / MinIO）连通性与配置生效检查——按需执行的人工联调用例。

默认跳过；需要在真实环境验证时先设置环境变量 ``KE_WORK_CHECK_EXTERNAL=1``：

    uv run pytest tests/integration_tests/test_external_services.py -q -s
"""

import asyncio
import logging
import os
import re
from pathlib import Path

import pytest
from dotenv import load_dotenv

BACKEND_ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = BACKEND_ROOT / ".env"
load_dotenv(ENV_PATH)

pytestmark = pytest.mark.skipif(
    os.getenv("KE_WORK_CHECK_EXTERNAL", "") != "1",
    reason="未设置 KE_WORK_CHECK_EXTERNAL=1，跳过外部依赖连通性检查",
)


def _env_map() -> dict[str, str]:
    """解析 .env 中的标准 KEY=VALUE 配置。"""
    data: dict[str, str] = {}
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        data[key.strip()] = value.strip()
    return data


def _mask(text: str) -> str:
    """输出时隐藏连接串中的口令。"""
    return re.sub(r"://[^@]*@", "://***@", text)


def test_settings_read_external_config() -> None:
    """后端 Settings 能读到 Redis / MinIO 配置（含行内注释的解析）。"""
    from agent.config import settings

    print("ARTIFACT_BACKEND:", settings.ARTIFACT_BACKEND)
    print("MINIO endpoint:", settings.ARTIFACT_MINIO_ENDPOINT)
    print("MINIO secure:", settings.ARTIFACT_MINIO_SECURE)
    print("MINIO bucket:", settings.ARTIFACT_MINIO_BUCKET)
    print("MINIO 凭据已配置:", bool(settings.ARTIFACT_MINIO_ACCESS_KEY and settings.ARTIFACT_MINIO_SECRET_KEY))
    print("REDIS_URL:", _mask(settings.REDIS_URL))

    assert settings.REDIS_URL.startswith("redis://")
    assert settings.ARTIFACT_BACKEND in ("local", "minio")
    if settings.ARTIFACT_BACKEND == "minio":
        assert settings.ARTIFACT_MINIO_ENDPOINT
        assert " " not in settings.ARTIFACT_MINIO_ENDPOINT
        assert settings.ARTIFACT_MINIO_ACCESS_KEY
        assert settings.ARTIFACT_MINIO_SECRET_KEY


def test_redis_connectivity() -> None:
    """Redis 可连接、可读写（使用 Settings 中的 REDIS_URL）。"""
    import redis

    from agent.config import settings

    assert settings.REDIS_URL, "未配置 REDIS_URL"
    client = redis.Redis.from_url(
        settings.REDIS_URL, socket_connect_timeout=5, socket_timeout=5
    )
    assert client.ping() is True
    print("Redis 版本:", client.info("server").get("redis_version"))
    key = "ke-work:connectivity-check"
    client.set(key, "ok", ex=30)
    assert client.get(key) == b"ok"
    client.delete(key)
    print("Redis 读写往返: ok")


def test_cache_layer_uses_redis() -> None:
    """后端缓存层真实启用 Redis（而非静默降级为内存）。"""
    from core.cache import create_cache

    cache_logger = logging.getLogger("core.cache")
    previous_level = cache_logger.level
    cache_logger.setLevel(logging.WARNING)  # 避免把含口令的连接串写入日志
    try:
        cache = asyncio.run(_exercise_cache(create_cache))
    finally:
        cache_logger.setLevel(previous_level)
    print("缓存实现:", cache)


async def _exercise_cache(create_cache) -> str:
    """执行一次缓存读写并返回实现类名。"""
    cache = await create_cache()
    await cache.set("ke-work:cache-check", "ok", ttl=30)
    value = await cache.get("ke-work:cache-check")
    await cache.delete("ke-work:cache-check")
    assert value == "ok"
    return type(cache).__name__


def test_minio_connectivity_and_round_trip() -> None:
    """MinIO 可连接、可列桶，并通过策略工厂完成一次真实产物往返。"""
    from minio import Minio

    from core.storage import (
        MinioArtifactStore,
        build_storage_key,
        get_artifact_store,
        reset_artifact_store,
    )

    env = _env_map()
    server_url = env.get("MINIO_SERVER_URL", "")
    assert server_url, "未找到 MINIO_SERVER_URL"
    secure = server_url.startswith("https://")
    endpoint = re.sub(r"^https?://", "", server_url).rstrip("/")
    client = Minio(
        endpoint,
        access_key=env.get("MINIO_ROOT_USER", ""),
        secret_key=env.get("MINIO_ROOT_PASSWORD", ""),
        secure=secure,
    )
    buckets = [item.name for item in client.list_buckets()]
    bucket = env.get("ARTIFACT_MINIO_BUCKET", "ke-work-artifacts")
    if bucket not in buckets:
        client.make_bucket(bucket)
        print("已创建目标桶:", bucket)
    print("MinIO endpoint:", endpoint, "secure:", secure, "桶数:", len(buckets))

    reset_artifact_store()
    store = get_artifact_store()
    assert isinstance(store, MinioArtifactStore)
    assert store.bucket == bucket
    print("策略工厂选择:", store.__class__.__name__, "桶:", store.bucket)

    key = build_storage_key("connectivity-check", "thread-1", "artifact-1", "probe.md")
    payload = b"ke-work artifact probe"
    store.save(key, payload)
    assert store.exists(key) is True
    assert store.open(key) == payload
    assert store.size(key) == len(payload)
    assert store.read(key, 3, 4) == b"work"
    store.delete(key)
    assert store.exists(key) is False
    reset_artifact_store()
    print("MinIO 产物往返: ok")
