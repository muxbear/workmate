"""S1 的结构化用例：**路由上声明的权限键必须存在于权限树里**。

这条检查缺位过一次：`knowledge:edit` 被 16 个接口用作门禁，却从未被加进权限树——
默认授予从树上取键，于是 admin 与 manager 都拿不到它，除超管外这批功能整体 403。
T5.1 的既有用例只断言"每个写接口**声明了**权限键"，不校验"该键在树上"，所以它
一路绿灯。这里补上后半句。
"""

from api.rbac.service import (
    ALL_PERMISSION_KEYS,
    BUILTIN_PERMISSION_RESOURCES,
    DEFAULT_ROLE_PERMISSIONS,
)


def collect_declared_keys() -> set[str]:
    """遍历真实路由，收集每个写接口声明的权限键。"""
    from server import app

    from unit_tests.test_kb_permissions import _flatten_routes, _permission_keys

    keys: set[str] = set()
    for route in _flatten_routes(app.routes):
        keys.update(_permission_keys(route))
    return keys


class TestDeclaredKeysExistInTree:
    def test_every_declared_permission_key_is_on_the_tree(self):
        declared = collect_declared_keys()

        missing = sorted(declared - set(ALL_PERMISSION_KEYS))

        assert not missing, (
            f"这些权限键被接口引用、却不在权限树里，默认角色永远拿不到：{missing}"
        )

    def test_knowledge_edit_is_available_and_granted_to_managers_only(self):
        assert "knowledge:edit" in ALL_PERMISSION_KEYS
        # 树上有对应的可见条目（管理员才能在权限页勾选/取消）
        entry = next(
            (r for r in BUILTIN_PERMISSION_RESOURCES if r.get("perm_key") == "knowledge:edit"),
            None,
        )
        assert entry is not None and entry["parent"] == "m-kb"

        assert "knowledge:edit" in DEFAULT_ROLE_PERMISSIONS["manager"]
        assert "knowledge:edit" in DEFAULT_ROLE_PERMISSIONS["admin"]
        assert "knowledge:edit" not in DEFAULT_ROLE_PERMISSIONS["member"]

    def test_no_duplicate_perm_keys_on_the_tree(self):
        keys = [str(r["perm_key"]) for r in BUILTIN_PERMISSION_RESOURCES]
        assert len(keys) == len(set(keys))
