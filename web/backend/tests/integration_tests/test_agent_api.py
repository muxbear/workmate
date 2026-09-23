import os
import uuid

import pytest

from core.security import create_token_pair

pytestmark = pytest.mark.anyio

# 对话模型不再来自环境变量：它由 Web 端「模型」页面的 providers / ai_models 决定。
# 因此真实调用型用例改为显式开关（会真的打到外部模型服务、产生费用），
# 而不是靠嗅探某个 API Key 环境变量。
RUN_LIVE_LLM_TESTS = os.environ.get("RUN_LIVE_LLM_TESTS", "").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
LIVE_SKIP_REASON = "需要 RUN_LIVE_LLM_TESTS=1 且「模型」页面已配置可用模型"

USER_ID = f"test-{uuid.uuid4().hex[:8]}"


def _auth_headers() -> dict[str, str]:
    """/api/chat 与 /chat/stream 都要求登录，缺 Authorization 会先返回 401 而不是 422。"""
    tokens = create_token_pair(USER_ID)
    return {"Authorization": f"Bearer {tokens.accessToken}"}


@pytest.mark.skipif(not RUN_LIVE_LLM_TESTS, reason=LIVE_SKIP_REASON)
async def test_chat(client):
    resp = await client.post(
        "/api/chat", json={"message": "hello"}, headers=_auth_headers()
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "response" in data
    assert isinstance(data["response"], str)


async def test_chat_validation_empty_message(client):
    resp = await client.post(
        "/api/chat", json={"message": ""}, headers=_auth_headers()
    )
    assert resp.status_code == 422


async def test_chat_validation_missing_field(client):
    resp = await client.post("/api/chat", json={}, headers=_auth_headers())
    assert resp.status_code == 422


async def test_chat_requires_auth(client):
    """未登录时返回 401（先于请求体校验），保证上面的 422 断言是在已登录前提下测的。"""
    resp = await client.post("/api/chat", json={"message": "hello"})
    assert resp.status_code == 401


@pytest.mark.skipif(not RUN_LIVE_LLM_TESTS, reason=LIVE_SKIP_REASON)
async def test_chat_stream(client):
    resp = await client.post(
        "/api/chat/stream", json={"message": "hello"}, headers=_auth_headers()
    )
    assert resp.status_code == 200
    assert "text/event-stream" in resp.headers.get("content-type", "")


async def test_chat_stream_validation(client):
    resp = await client.post(
        "/api/chat/stream", json={"message": ""}, headers=_auth_headers()
    )
    assert resp.status_code == 422