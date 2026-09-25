"""BM25 语料缓存：有界 LRU + 失效语义（迭代 4 T4.2）。

此前是无上限 dict + 60s TTL：条目数随知识库数量增长，而**每条都常驻整库语料**——
内存与"库数 × 库规模"成正比；TTL 到期又会让下一次查询重新拉全量语料 + 重新分词
（这正是被 Milvus 原生稀疏检索取代的那条路径）。

现在：容量上限 + 淘汰最久未使用；正确性靠写入路径的 ``invalidate``，不靠 TTL。
"""

from core.rag.bm25 import BM25Index, SparseIndexCache


def make_index(tag: str) -> BM25Index:
    return BM25Index.build([("c1", f"{tag} 的内容")])


class TestBoundedLru:
    def test_evicts_least_recently_used(self):
        cache = SparseIndexCache(max_entries=2, ttl_seconds=1000)
        cache.put("kb-1", make_index("一"))
        cache.put("kb-2", make_index("二"))
        cache.put("kb-3", make_index("三"))

        assert cache.get("kb-1") is None, "最久未使用的应被淘汰"
        assert cache.get("kb-2") is not None
        assert cache.get("kb-3") is not None
        assert len(cache) == 2

    def test_get_refreshes_recency(self):
        cache = SparseIndexCache(max_entries=2, ttl_seconds=1000)
        cache.put("kb-1", make_index("一"))
        cache.put("kb-2", make_index("二"))

        cache.get("kb-1")          # kb-1 变成最近使用
        cache.put("kb-3", make_index("三"))

        assert cache.get("kb-1") is not None
        assert cache.get("kb-2") is None, "被 get 刷新的那项不该被淘汰"

    def test_capacity_is_never_exceeded(self):
        cache = SparseIndexCache(max_entries=3, ttl_seconds=1000)
        for i in range(10):
            cache.put(f"kb-{i}", make_index(str(i)))

        assert len(cache) == 3

    def test_invalidate_removes_entry(self):
        cache = SparseIndexCache(max_entries=4, ttl_seconds=1000)
        cache.put("kb-1", make_index("一"))

        cache.invalidate("kb-1")

        assert cache.get("kb-1") is None
        assert len(cache) == 0


class TestTtlIsOnlyASafetyNet:
    def test_expired_entry_is_refetched(self):
        clock = [0.0]
        cache = SparseIndexCache(max_entries=4, ttl_seconds=300, clock=lambda: clock[0])
        cache.put("kb-1", make_index("一"))

        clock[0] = 299.0
        assert cache.get("kb-1") is not None

        clock[0] = 301.0
        assert cache.get("kb-1") is None

    def test_default_ttl_is_long_enough_that_writes_drive_correctness(self):
        """TTL 只兜"别的进程写了库"；本进程的正确性由 invalidate 保证。"""
        cache = SparseIndexCache()
        assert cache._ttl_seconds >= 300
