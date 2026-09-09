from api.rbac.role_utils import role_sort_key
from db.models.role import Role


def _role(key: str, sort_order: int) -> Role:
    return Role(
        id=key,
        key=key,
        name=key,
        description="",
        is_builtin=False,
        is_active=True,
        parent_role_id=None,
        sort_order=sort_order,
    )


def test_role_sort_key_puts_super_admin_first() -> None:
    roles = [
        _role("member", 4),
        _role("admin", 2),
        _role("super_admin", 1),
    ]
    ordered = sorted(roles, key=role_sort_key)
    assert [r.key for r in ordered] == ["super_admin", "admin", "member"]


def test_role_sort_key_orders_custom_roles_by_sort_order() -> None:
    roles = [
        _role("auditor", 10),
        _role("operator", 5),
    ]
    ordered = sorted(roles, key=role_sort_key)
    assert [r.key for r in ordered] == ["operator", "auditor"]


def test_role_sort_key_falls_back_to_key_order() -> None:
    roles = [_role("b_role", 0), _role("a_role", 0)]
    ordered = sorted(roles, key=role_sort_key)
    assert [r.key for r in ordered] == ["a_role", "b_role"]
