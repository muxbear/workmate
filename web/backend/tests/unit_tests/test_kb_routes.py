"""路由遮蔽回归测试。

FastAPI 按注册顺序匹配路由，且路径参数段（``{kb_id}``）能匹配任意单段路径。
因此「先注册 ``GET /{kb_id}``、后注册 ``GET /share-candidates``」会让后者永远
拿不到请求（kb_id="share-candidates" → 404）——分享弹窗的候选用户列表因此
长期为空。

本测试遍历真实 app 的路由表，找出所有「字面量路径被更早注册的动态路径遮蔽」
的情况，避免同类问题再次发生。
"""

import pytest
from starlette.routing import compile_path

from server import app


def _flatten(routes) -> list[tuple[str, set[str]]]:
    """展开 FastAPI 0.141 的惰性路由包装（_IncludedRouter）成 (path, methods)。"""
    out: list[tuple[str, set[str]]] = []
    for route in routes:
        if type(route).__name__ == "_IncludedRouter":
            out.extend(_flatten(route.original_router.routes))
            continue
        path = getattr(route, "path", None)
        if not path:
            continue
        out.append((path, set(getattr(route, "methods", None) or [])))
    return out


def _shadowed_routes(prefix: str = "") -> list[str]:
    flat = [(p, m) for p, m in _flatten(app.routes) if p.startswith(prefix)]
    compiled = [compile_path(p)[0] for p, _ in flat]

    problems: list[str] = []
    for index, (path, methods) in enumerate(flat):
        if "{" in path:
            continue
        for earlier, (earlier_path, earlier_methods) in enumerate(flat[:index]):
            if "{" not in earlier_path:
                continue
            if not (methods & earlier_methods):
                continue
            if compiled[earlier].match(path):
                problems.append(
                    f"{sorted(methods)} {path} 被更早注册的 {earlier_path} 遮蔽"
                )
    return problems


def test_no_knowledge_base_route_is_shadowed():
    """知识库路由里不得存在被遮蔽的字面量路径（T0.4）。"""
    assert _shadowed_routes("/api/knowledge-bases") == []


def test_share_candidates_route_is_reachable():
    """候选用户接口必须存在且是两段式（/shares/candidates）。"""
    paths = {p for p, _ in _flatten(app.routes)}
    assert "/api/knowledge-bases/shares/candidates" in paths
    assert "/api/knowledge-bases/share-candidates" not in paths


@pytest.mark.parametrize(
    "path",
    [
        "/api/knowledge-bases/stats",
        "/api/knowledge-bases/available-models",
        "/api/knowledge-bases/available-providers",
    ],
)
def test_single_segment_literal_routes_are_not_shadowed(path: str):
    """单段字面量接口（比 /{kb_id} 更早注册）依然可达。"""
    flat = _flatten(app.routes)
    compiled = [compile_path(p)[0] for p, _ in flat]
    first_match = next(
        (p for p, regex in zip((p for p, _ in flat), compiled) if regex.match(path)),
        None,
    )
    assert first_match == path
