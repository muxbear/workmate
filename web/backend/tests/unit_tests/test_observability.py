"""可观测性：健康检查 / request_id / 指标端点（迭代 5 T5.5）。

三条底线：

1. **健康检查不说谎**：依赖真的挂了必须报出来。既有的 `/api/overview/health` 只看
   `vector_store is not None` 就说 ok——Milvus 挂了照样显示健康，这比没有健康检查更糟；
2. **健康检查不崩**：任一依赖探测抛异常，其余项仍要如实报告（探测本身不能成为故障源）；
3. **request_id 不串号**：并发请求各持自己的 id，异常请求也要还原上下文。
"""

import asyncio
import logging

import pytest
from fastapi import FastAPI, Request

from core.logging_context import (
    REQUEST_ID_HEADER,
    current_request_id,
    install_request_id_logging,
    new_request_id,
    request_id_var,
)

pytestmark = pytest.mark.anyio


class _FakeRequest:
    def __init__(self, vector_store=None):
        self.app = type("App", (), {"state": type("State", (), {
            "vector_store": vector_store,
        })()})()


class _Store:
    def __init__(self, ready: bool = True, raises: bool = False):
        self._ready = ready
        self._raises = raises

    async def health_check(self) -> bool:
        if self._raises:
            raise RuntimeError("milvus down")
        return self._ready


class TestKbHealth:
    async def test_all_ready_is_ok(self, monkeypatch):
        from api.knowledge_base import health_api

        async def embedding_ok(db):
            return {"ready": True}

        async def reranker_ok(db):
            return {"ready": True}

        monkeypatch.setattr(health_api, "_check_embedding", embedding_ok)
        monkeypatch.setattr(health_api, "_check_reranker", reranker_ok)

        result = await health_api.kb_health(_FakeRequest(_Store(ready=True)))
        data = result["data"]

        assert data["status"] == "ok"
        assert data["dependencies"]["vector_store"]["ready"] is True

    async def test_missing_reranker_is_degraded_not_down(self, monkeypatch):
        """精排是可选依赖：挂了检索仍可用，报 unavailable 会误导运维。"""
        from api.knowledge_base import health_api

        async def embedding_ok(db):
            return {"ready": True}

        async def reranker_down(db):
            return {"ready": False, "detail": "未配置重排序模型"}

        monkeypatch.setattr(health_api, "_check_embedding", embedding_ok)
        monkeypatch.setattr(health_api, "_check_reranker", reranker_down)

        data = (await health_api.kb_health(_FakeRequest(_Store())))["data"]

        assert data["status"] == "degraded"
        assert "精排" in data["impact"], "要说明降级的影响，避免被当成故障"

    async def test_vector_store_down_is_unavailable(self, monkeypatch):
        from api.knowledge_base import health_api

        async def embedding_ok(db):
            return {"ready": True}

        async def reranker_ok(db):
            return {"ready": True}

        monkeypatch.setattr(health_api, "_check_embedding", embedding_ok)
        monkeypatch.setattr(health_api, "_check_reranker", reranker_ok)

        data = (await health_api.kb_health(_FakeRequest(_Store(ready=False))))["data"]

        assert data["status"] == "unavailable"
        assert data["dependencies"]["vector_store"]["ready"] is False

    async def test_probe_exception_is_reported_not_raised(self, monkeypatch):
        """探测本身抛异常时要如实报告，而不是让整个健康检查 500。"""
        from api.knowledge_base import health_api

        async def embedding_ok(db):
            return {"ready": True}

        async def reranker_ok(db):
            return {"ready": True}

        monkeypatch.setattr(health_api, "_check_embedding", embedding_ok)
        monkeypatch.setattr(health_api, "_check_reranker", reranker_ok)

        data = (await health_api.kb_health(_FakeRequest(_Store(raises=True))))["data"]

        assert data["status"] == "unavailable"
        assert "milvus down" in data["dependencies"]["vector_store"]["detail"]

    async def test_missing_vector_store_is_reported(self, monkeypatch):
        from api.knowledge_base import health_api

        async def embedding_ok(db):
            return {"ready": True}

        async def reranker_ok(db):
            return {"ready": True}

        monkeypatch.setattr(health_api, "_check_embedding", embedding_ok)
        monkeypatch.setattr(health_api, "_check_reranker", reranker_ok)

        data = (await health_api.kb_health(_FakeRequest(None)))["data"]

        assert data["status"] == "unavailable"
        assert "未初始化" in data["dependencies"]["vector_store"]["detail"]


class TestOverviewHealthUsesRealProbe:
    """回归：概览页的健康检查此前只判断"实例存在"，依赖挂了照样报 ok。"""

    async def test_vector_store_failure_is_reflected(self):
        from api.overview.service import get_system_health

        class _Db:
            async def execute(self, *_a, **_kw):
                return None

        state = type("S", (), {"vector_store": _Store(ready=False), "started_at": None})()

        result = await get_system_health(_Db(), state)

        vector = next(c for c in result["checks"] if c["name"] == "vector_store")
        assert vector["status"] == "error"
        assert result["status"] == "degraded"


class TestRequestId:
    def test_generated_id_is_short_hex(self):
        value = new_request_id()

        assert len(value) == 16 and int(value, 16) >= 0

    def test_default_is_dash_outside_request(self):
        assert current_request_id() == "-"

    def test_contextvar_is_isolated_between_tasks(self):
        """并发请求各持自己的 id——串号会让日志指向错误的请求。"""

        async def worker(value: str) -> str:
            token = request_id_var.set(value)
            await asyncio.sleep(0.01)   # 故意让出，制造交错
            seen = current_request_id()
            request_id_var.reset(token)
            return seen

        async def main():
            return await asyncio.gather(*(worker(f"id-{i}") for i in range(5)))

        assert asyncio.run(main()) == [f"id-{i}" for i in range(5)]

    def test_logging_format_includes_request_id(self):
        """日志格式必须真的带上 request_id（装了格式却没注入会每次 KeyError）。"""
        install_request_id_logging()

        record = logging.LogRecord(
            "t", logging.INFO, __file__, 1, "消息", None, None,
        )
        logging.setLogRecordFactory  # noqa: B018 - 下面直接构造验证属性注入
        # 通过 factory 走一遍，确保注入生效
        factory = logging.getLogRecordFactory()
        injected = factory("t", logging.INFO, __file__, 1, "消息", None, None)

        assert hasattr(injected, "request_id")
        assert injected.request_id == "-"
        assert record is not None


class TestRequestIdMiddleware:
    async def _client(self, app):
        from httpx import ASGITransport, AsyncClient

        return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    async def test_response_carries_request_id(self):
        from server import app

        async with await self._client(app) as client:
            response = await client.get("/api/overview/health")

        assert response.headers.get(REQUEST_ID_HEADER), "响应头要回带 request_id"

    async def test_incoming_request_id_is_reused(self):
        """客户端（或网关）已带 id 时沿用，便于跨系统串联。"""
        from server import app

        async with await self._client(app) as client:
            response = await client.get(
                "/api/overview/health", headers={REQUEST_ID_HEADER: "caller-supplied-id"},
            )

        assert response.headers.get(REQUEST_ID_HEADER) == "caller-supplied-id"

    async def test_context_is_restored_after_exception(self):
        """异常请求也要还原上下文，否则 id 会泄漏到复用该协程的后续请求。

        直接取**产品注册的那个 dispatch**（而不是在用例里复制一份中间件逻辑——
        那样测的是测试自己写的代码）。
        """
        from starlette.middleware.base import BaseHTTPMiddleware

        from server import app

        entry = next(m for m in app.user_middleware if m.cls is BaseHTTPMiddleware)
        dispatch = entry.kwargs["dispatch"]

        class _Req:
            headers = {"X-Request-Id": "req-1"}
            url = type("U", (), {"path": "/api/x"})()
            client = None

        async def boom(_request):
            raise RuntimeError("boom")

        with pytest.raises(RuntimeError, match="boom"):
            await dispatch(_Req(), boom)

        assert current_request_id() == "-", "退出中间件后上下文必须还原"


class TestMetricsEndpoint:
    async def test_endpoint_returns_prometheus_text(self):
        from httpx import ASGITransport, AsyncClient

        from server import app

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            response = await c.get("/metrics")

        assert response.status_code == 200
        assert response.text.endswith("\n")
        assert "# TYPE" in response.text
        assert "kb_index_tasks_total" in response.text

    async def test_health_route_is_registered(self):
        """健康检查必须真的挂在路由表上（此前只有 /api/overview/health，且不探测依赖）。"""
        from server import app
        from unit_tests.test_kb_permissions import _flatten_routes

        paths = {r.path for r in _flatten_routes(app.routes)}

        assert "/health/kb" in paths
