from dotenv import load_dotenv
from fastapi import FastAPI

from server import app


def test_app_instance():
    assert isinstance(app, FastAPI)
    assert app.title == "ke-hermes"


def test_routes_registered():
    """确认关键 API 路由已注册。

    这里查 OpenAPI 而不是遍历 ``app.routes``：新版 FastAPI 的 ``include_router``
    不再把子路由摊平进 ``app.routes``，而是放一个不含 ``path`` 的 ``_IncludedRouter``
    占位节点（直接取 ``r.path`` 会抛 AttributeError，且拿不到任何子路径）。
    OpenAPI schema 是跨版本稳定的枚举方式。
    """
    paths = set(app.openapi().get("paths", {}))
    assert "/api/chat" in paths
    assert "/api/chat/stream" in paths


def test_load_dotenv_called():
    load_dotenv()