"""重建集合的换名式替换（迭代 4 T4.5）。

此前重建是"**先删旧集合、再建新的**"：删掉之后任何一步失败（维度填错、服务端拒绝
稀疏参数、建索引超时、进程被杀）都意味着旧数据已经没了且不可恢复——用户看到的是
一个空知识库。实测踩过一次（重建报 collection_ready=false，数据已丢、只能重新上传）。

现在改为：先把新集合建在临时名字下，**建成功之后**才换名替换。建失败时旧集合原封
不动。换名的两步之间崩溃也能在下次调用时恢复（见 `_recover_interrupted_swap`）。
"""

import pytest

from core.rag.vector_store import MilvusVectorStore

pytestmark = pytest.mark.anyio


class FakeUtility:
    """内存版 Milvus collection 注册表。"""

    def __init__(self):
        self.collections: dict[str, list[str]] = {}
        self.renames: list[tuple[str, str]] = []
        self.dropped: list[str] = []
        #: 建集合时抛错（模拟"新集合建不起来"）
        self.fail_create_for: set[str] = set()

    def has_collection(self, name: str) -> bool:
        return name in self.collections

    def drop_collection(self, name: str) -> None:
        self.collections.pop(name, None)
        self.dropped.append(name)

    def rename_collection(self, old: str, new: str) -> None:
        if new in self.collections:
            raise RuntimeError(f"duplicated new collection name {new}")
        if old not in self.collections:
            raise RuntimeError(f"collection not found: {old}")
        self.collections[new] = self.collections.pop(old)
        self.renames.append((old, new))


class FakeCollection:
    def __init__(self, name, schema=None):
        self.name = name
        self.schema = schema
        self.loaded = False

    def create_index(self, field_name, index_params):
        pass

    def load(self):
        self.loaded = True


def install_fakes(monkeypatch, utility: FakeUtility) -> None:
    import pymilvus

    class FakeCollectionCtor(FakeCollection):
        def __init__(self, name=None, schema=None):
            if name in utility.fail_create_for:
                raise RuntimeError(f"create failed for {name}")
            super().__init__(name, schema)
            utility.collections[name] = []

    monkeypatch.setattr(pymilvus, "Collection", FakeCollectionCtor)
    monkeypatch.setattr(pymilvus, "connections", type("C", (), {
        "connect": staticmethod(lambda **kwargs: None),
    }))
    monkeypatch.setattr(pymilvus, "utility", utility)
    monkeypatch.setattr("asyncio.sleep", _no_sleep)


async def _no_sleep(_seconds):
    return None


def make_store() -> MilvusVectorStore:
    store = MilvusVectorStore(uri="http://fake:19530", user="u", password="p")
    store._connected = True
    return store


class TestStagedSwap:
    async def test_new_collection_is_built_before_old_is_touched(self, monkeypatch):
        utility = FakeUtility()
        utility.collections["kb_kb_1"] = ["旧数据"]
        install_fakes(monkeypatch, utility)
        store = make_store()

        await store.create_collection("kb-1", dim=8)

        assert "kb_kb_1" in utility.collections
        # 旧集合是被**换名**保留下来的（随后才删），不是先删后建
        assert ("kb_kb_1", "kb_kb_1__old") in utility.renames
        assert ("kb_kb_1__new", "kb_kb_1") in utility.renames

    async def test_failed_build_keeps_old_collection_intact(self, monkeypatch):
        """建不成功时，旧集合与其中的数据必须**一字未动**。"""
        utility = FakeUtility()
        utility.collections["kb_kb_1"] = ["旧数据"]
        utility.fail_create_for.add("kb_kb_1__new")
        install_fakes(monkeypatch, utility)
        store = make_store()

        with pytest.raises(RuntimeError, match="create failed"):
            await store.create_collection("kb-1", dim=8)

        assert utility.collections["kb_kb_1"] == ["旧数据"], "旧数据不能被删"
        assert "kb_kb_1" not in utility.dropped
        assert utility.renames == []

    async def test_fresh_kb_creates_without_swap(self, monkeypatch):
        utility = FakeUtility()
        install_fakes(monkeypatch, utility)
        store = make_store()

        await store.create_collection("kb-1", dim=8)

        assert utility.collections["kb_kb_1"] == []
        # 本来就没有旧集合，不该产生回收站
        assert not any(old.endswith("__old") for old, _new in utility.renames)

    async def test_leftover_staging_is_cleaned_first(self, monkeypatch):
        """上次中途失败留下的临时集合要先清掉，否则换名会撞名失败。"""
        utility = FakeUtility()
        utility.collections["kb_kb_1"] = ["旧数据"]
        utility.collections["kb_kb_1__new"] = ["上次的残留"]
        install_fakes(monkeypatch, utility)
        store = make_store()

        await store.create_collection("kb-1", dim=8)

        assert "kb_kb_1__new" in utility.dropped
        assert ("kb_kb_1__new", "kb_kb_1") in utility.renames
        assert utility.collections["kb_kb_1"] == []


class TestCrashRecovery:
    async def test_data_in_trash_is_restored_when_live_is_missing(self, monkeypatch):
        """换名两步之间崩溃：数据在回收站里、正式名空缺——必须**改回来**。

        只做清理不做恢复的话，用户会看到"库还在、但什么都搜不到"。
        """
        utility = FakeUtility()
        utility.collections["kb_kb_1__old"] = ["唯一的数据"]
        install_fakes(monkeypatch, utility)
        store = make_store()

        await store.create_collection("kb-1", dim=8)

        assert ("kb_kb_1__old", "kb_kb_1") in utility.renames

    async def test_stale_trash_is_dropped(self, monkeypatch):
        utility = FakeUtility()
        utility.collections["kb_kb_1"] = ["现有数据"]
        utility.collections["kb_kb_1__old"] = ["更早的残留"]
        install_fakes(monkeypatch, utility)
        store = make_store()

        await store.create_collection("kb-1", dim=8)

        assert "kb_kb_1__old" in utility.dropped
        assert utility.collections["kb_kb_1"] == []

    async def test_recovery_runs_before_building(self, monkeypatch):
        """恢复必须发生在建临时集合之前——否则临时名可能被残留占用。"""
        utility = FakeUtility()
        utility.collections["kb_kb_2__old"] = ["数据"]
        install_fakes(monkeypatch, utility)
        store = make_store()

        await store.create_collection("kb-2", dim=8)

        assert utility.renames[0] == ("kb_kb_2__old", "kb_kb_2")
