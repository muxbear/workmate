"""云知识库检索 MCP 服务的端到端链路（真实挂载的 HTTP 端点）。

单测覆盖了身份解析的每个分支，但有一层只有跑真实传输才能验证：**MCP 工具是在另一个
任务上下文里执行的**——ASGI 中间件里塞的 ContextVar 传不进工具（已实测），身份只能
从 MCP 请求头取。接线一旦断了，表现要么是"无身份一律拒绝"（功能全废），要么更糟——
"无身份也放行"（越权）。这里用两个可区分的响应把这件事钉住：

- 不带 token → ``缺少身份信息`` 错误；
- 带一枚**签名有效**的 token → 正常返回结果（哪怕该用户没有知识库）。

两者可区分，就证明请求头确实被读到了、且被当成了身份。
"""

import json

import pytest

from core.security import create_token_pair

pytestmark = pytest.mark.anyio

MCP_URL = "/mcp/kb-http/mcp"
# Host 必须是传输层白名单里的值：MCP 传输自带 DNS 重绑定防护，而共享的
# client fixture 用的是 ``base_url="http://test"``，其 Host 不在白名单内。
_BASE_HEADERS = {"Accept": "application/json, text/event-stream", "Host": "127.0.0.1"}

# 一枚签名合法、但库里不存在的用户：读不到任何数据，却足以区分"已识别身份"
PHANTOM_USER = "mcp-e2e-phantom-user"


def _jsonrpc_payload(text: str) -> dict:
    """从 SSE 或裸 JSON 响应里取出 JSON-RPC 报文。"""
    for line in text.splitlines():
        if line.startswith("data: "):
            return json.loads(line[6:])
    return json.loads(text)


def _tool_result_text(payload: dict) -> str:
    """取 tool/call 返回里的文本内容。"""
    content = payload.get("result", {}).get("content", [])
    return "".join(part.get("text", "") for part in content if part.get("type") == "text")


async def _call_tool(client, name: str, arguments: dict, token: str | None = None) -> dict:
    """完成 initialize 握手后调用一个 MCP 工具，返回 JSON-RPC 报文。"""
    headers = dict(_BASE_HEADERS)
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"

    init = await client.post(
        MCP_URL,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "kb-e2e", "version": "1"},
            },
        },
        headers=headers,
    )
    assert init.status_code == 200, init.text
    session_id = init.headers.get("mcp-session-id")
    if session_id:
        headers["mcp-session-id"] = session_id

    await client.post(
        MCP_URL,
        json={"jsonrpc": "2.0", "method": "notifications/initialized"},
        headers=headers,
    )

    call = await client.post(
        MCP_URL,
        json={
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        },
        headers=headers,
    )
    assert call.status_code == 200, call.text
    return _jsonrpc_payload(call.text)


async def test_mounted_endpoint_advertises_knowledge_base_tools(client):
    """真实挂载的端点上能列出这 4 个检索工具。"""
    init = await client.post(
        MCP_URL,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "kb-e2e", "version": "1"},
            },
        },
        headers=dict(_BASE_HEADERS),
    )
    assert init.status_code == 200, init.text
    headers = dict(_BASE_HEADERS)
    session_id = init.headers.get("mcp-session-id")
    if session_id:
        headers["mcp-session-id"] = session_id
    await client.post(
        MCP_URL,
        json={"jsonrpc": "2.0", "method": "notifications/initialized"},
        headers=headers,
    )

    listed = await client.post(
        MCP_URL,
        json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        headers=headers,
    )
    assert listed.status_code == 200, listed.text
    tools = {t["name"] for t in _jsonrpc_payload(listed.text)["result"]["tools"]}
    assert tools == {
        "list_knowledge_bases",
        "kb_search",
        "kb_get_chunk_context",
        "kb_graph_lookup",
    }


async def test_tool_refuses_without_token(client):
    """不带凭据的外部调用必须被拒——且拒绝理由要说清是"缺身份"。"""
    payload = await _call_tool(client, "list_knowledge_bases", {})
    assert "缺少身份信息" in _tool_result_text(payload)


async def test_tool_refuses_forged_token(client):
    """签名造假的 token 不能当身份用。"""
    for token in (create_token_pair(PHANTOM_USER).refreshToken, "not-a-jwt"):
        payload = await _call_tool(client, "list_knowledge_bases", {}, token=token)
        assert "缺少身份信息" in _tool_result_text(payload), token


async def test_tool_proceeds_with_valid_token(client):
    """签名有效的 token 能被识别成身份——这是"请求头真的读到了"的正向证据。

    该用户没有任何知识库，所以结果是空列表；**关键是没有 ``error`` 键**：
    拒绝路径同样返回 total=0 的空列表（只多一个 error），因此必须显式断言
    "没有 error"，否则这条用例在身份根本没解析出来时也会绿。
    """
    token = create_token_pair(PHANTOM_USER).accessToken
    payload = await _call_tool(client, "list_knowledge_bases", {}, token=token)

    body = json.loads(_tool_result_text(payload))
    assert "error" not in body, f"凭据有效却被拒：{body}"
    assert body["total"] == 0
    assert body["knowledge_bases"] == []
