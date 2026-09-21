"""缓存层单元测试（口令脱敏、连接失败降级与内存缓存语义）。"""

import asyncio

from core.cache import MemoryCache, create_cache, mask_url_credentials


def test_mask_url_credentials() -> None:
    """日志脱敏：隐藏连接串中的账号口令。"""
    assert (
        mask_url_credentials("redis://:secret@127.0.0.1:6379/1")
        == "redis://***@127.0.0.1:6379/1"
    )
    assert (
        mask_url_credentials("redis://user:secret@host:6379/0")
        == "redis://***@host:6379/0"
    )
    assert mask_url_credentials("redis://host:6379/0") == "redis://host:6379/0"
    assert mask_url_credentials("") == ""


def test_create_cache_falls_back_to_memory() -> None:
    """Redis 不可达时降级为内存缓存，而不是返回不可用的 RedisCache。"""

    async def _run() -> str:
        cache = await create_cache("redis://127.0.0.1:1/0")
        return type(cache).__name__

    assert asyncio.run(_run()) == "MemoryCache"


def test_memory_cache_round_trip() -> None:
    """内存缓存读写、计数、消费与 TTL 语义。"""

    async def _run() -> None:
        cache = MemoryCache()
        await cache.set("k", "v", ttl=5)
        assert await cache.get("k") == "v"
        assert await cache.exists("k") is True
        assert await cache.incr("n") == 1
        assert await cache.incr("n") == 2
        assert await cache.consume("k") == "v"
        assert await cache.get("k") is None
        assert await cache.ttl("missing") == -2

    asyncio.run(_run())
