"""图像生成 MCP server 单元测试。"""

import base64

import httpx
import pytest

from mcp_servers.image_gen_server import (
    ImageGenConfig,
    _edits_url,
    _generate,
    _generations_url,
    _image_file_from_input,
    _is_dashscope,
    _normalize_count,
    _normalize_size,
    _normalize_size_dashscope,
    _parse_dashscope_images,
    _parse_images,
)

TEST_CONFIG = ImageGenConfig(
    api_base="https://example.com/v1",
    api_key="test-key",
    model="wan2.7-image-pro",
)

DASHSCOPE_CONFIG = ImageGenConfig(
    api_base="https://dashscope.aliyuncs.com/compatible-mode/v1",
    api_key="test-key",
    model="wan2.7-image-pro",
)


@pytest.fixture(autouse=True)
def _stub_config(monkeypatch):
    """单测固定模型配置，避免访问数据库或环境变量。"""

    async def fake_get_config() -> ImageGenConfig:
        return TEST_CONFIG

    monkeypatch.setattr("mcp_servers.image_gen_server._get_config", fake_get_config)


def test_generations_url_normalizes():
    assert (
        _generations_url("https://example.com/v1")
        == "https://example.com/v1/images/generations"
    )
    assert (
        _generations_url("https://example.com/v1/images/generations/")
        == "https://example.com/v1/images/generations"
    )
    assert (
        _generations_url("https://example.com/v1/images/edits")
        == "https://example.com/v1/images/generations"
    )


def test_edits_url_normalizes():
    assert _edits_url("https://example.com/v1") == "https://example.com/v1/images/edits"
    assert (
        _edits_url("https://example.com/v1/images/generations")
        == "https://example.com/v1/images/edits"
    )


def test_normalize_size_and_count():
    assert _normalize_size("1280x720") == "1280x720"
    assert _normalize_size("bad") == "1024x1024"
    assert _normalize_count(0) == 1
    assert _normalize_count(100) == 8
    assert _normalize_count(None) == 1


def test_parse_images():
    data = {
        "data": [
            {"url": "https://img/1.png"},
            {"b64_json": "AAAA"},
            {"other": "x"},
        ]
    }
    images = _parse_images(data)
    assert len(images) == 2
    assert images[0]["url"] == "https://img/1.png"
    assert images[1]["b64_json"] == "AAAA"


@pytest.mark.asyncio
async def test_text_to_image_posts_json():
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["content"] = request.content
        return httpx.Response(
            200,
            json={"data": [{"url": "https://img/result.png"}]},
            request=request,
        )

    result = await _generate(
        "一只橘猫",
        1,
        "1024x1024",
        "url",
        None,
        transport=httpx.MockTransport(handler),
    )
    assert result["count"] == 1
    assert result["images"][0]["url"] == "https://img/result.png"
    assert captured["url"].endswith("/images/generations")
    import json

    payload = json.loads(captured["content"])
    assert payload["model"] == "wan2.7-image-pro"
    assert payload["prompt"] == "一只橘猫"
    assert payload["n"] == 1
    assert payload["size"] == "1024x1024"


@pytest.mark.asyncio
async def test_text_to_image_batch_caps_count():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"data": [{"url": f"https://img/{i}.png"} for i in range(10)]},
            request=request,
        )

    result = await _generate(
        "未来城市",
        12,
        "1024x1024",
        "url",
        None,
        transport=httpx.MockTransport(handler),
    )
    assert result["count"] == 8
    assert len(result["images"]) == 8


@pytest.mark.asyncio
async def test_image_to_image_batch_posts_multipart():
    captured: dict = {}
    png_bytes = b"\x89PNG\r\n\x1a\n" + b"0" * 32
    data_uri = "data:image/png;base64," + base64.b64encode(png_bytes).decode()

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = request.content
        return httpx.Response(
            200,
            json={"data": [{"url": f"https://img/{i}.png"} for i in range(4)]},
            request=request,
        )

    result = await _generate(
        "改成赛博朋克风格",
        4,
        "1024x1024",
        "url",
        None,
        [data_uri],
        transport=httpx.MockTransport(handler),
    )
    assert result["count"] == 4
    assert captured["url"].endswith("/images/edits")
    body = captured["body"].decode("utf-8", errors="replace")
    assert 'name="image"' in body
    assert "wan2.7-image-pro" in body


@pytest.mark.asyncio
async def test_image_file_from_url():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"PNG",
            headers={"content-type": "image/jpeg"},
            request=request,
        )

    filename, content, mime = await _image_file_from_input(
        "https://example.com/ref.jpg",
        transport=httpx.MockTransport(handler),
    )
    assert filename == "reference.png"
    assert content == b"PNG"
    assert mime == "image/jpeg"


@pytest.mark.asyncio
async def test_empty_prompt_returns_error():
    result = await _generate("   ", 1, "1024x1024", "url", None)
    assert "error" in result
    assert result["error"] == "prompt 不能为空"


@pytest.mark.asyncio
async def test_http_error_returns_structured_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom", request=request)

    result = await _generate(
        "测试",
        1,
        "1024x1024",
        "url",
        None,
        transport=httpx.MockTransport(handler),
    )
    assert "error" in result
    assert "500" in result["error"]


@pytest.mark.asyncio
async def test_invalid_image_input_returns_error():
    result = await _generate(
        "测试",
        1,
        "1024x1024",
        "url",
        None,
        ["not-an-image!!!"],
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={}, request=request)
        ),
    )
    assert "error" in result


def test_is_dashscope():
    assert _is_dashscope("https://dashscope.aliyuncs.com/compatible-mode/v1")
    assert not _is_dashscope("https://example.com/v1")


def test_normalize_size_dashscope():
    assert _normalize_size_dashscope("1024x1024") == "1024*1024"
    assert _normalize_size_dashscope("1280*720") == "1280*720"
    assert _normalize_size_dashscope("2K") == "2K"
    assert _normalize_size_dashscope("1k") == "1K"
    assert _normalize_size_dashscope("bad") == "2K"
    assert _normalize_size_dashscope(None) == "2K"


def test_parse_dashscope_images():
    data = {
        "output": {
            "choices": [
                {
                    "message": {
                        "content": [
                            {"type": "text", "text": "done"},
                            {"type": "image", "image": "https://img/dash/1.png"},
                        ]
                    }
                },
                {
                    "message": {
                        "content": {"type": "image", "image": "https://img/dash/2.png"}
                    }
                },
            ]
        }
    }
    images = _parse_dashscope_images(data)
    assert [item["url"] for item in images] == [
        "https://img/dash/1.png",
        "https://img/dash/2.png",
    ]


@pytest.mark.asyncio
async def test_dashscope_text_to_image_posts_native(monkeypatch):
    import json

    captured: dict = {}

    async def fake_get_config() -> ImageGenConfig:
        return DASHSCOPE_CONFIG

    monkeypatch.setattr("mcp_servers.image_gen_server._get_config", fake_get_config)

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["content"] = request.content
        return httpx.Response(
            200,
            json={
                "output": {
                    "choices": [
                        {
                            "message": {
                                "content": [
                                    {"type": "image", "image": "https://img/dash/1.png"}
                                ]
                            }
                        }
                    ]
                }
            },
            request=request,
        )

    result = await _generate(
        "一只橘猫",
        1,
        "1024x1024",
        "url",
        None,
        transport=httpx.MockTransport(handler),
    )
    assert result["count"] == 1
    assert result["images"][0]["url"] == "https://img/dash/1.png"
    assert result["size"] == "1024*1024"
    assert captured["url"].endswith(
        "/api/v1/services/aigc/multimodal-generation/generation"
    )
    payload = json.loads(captured["content"])
    assert payload["model"] == "wan2.7-image-pro"
    assert payload["input"]["messages"][0]["content"] == [{"text": "一只橘猫"}]
    assert payload["parameters"] == {"n": 1, "size": "1024*1024"}


@pytest.mark.asyncio
async def test_dashscope_text_to_image_batch_enables_sequential(monkeypatch):
    import json

    captured: dict = {}

    async def fake_get_config() -> ImageGenConfig:
        return DASHSCOPE_CONFIG

    monkeypatch.setattr("mcp_servers.image_gen_server._get_config", fake_get_config)

    def handler(request: httpx.Request) -> httpx.Response:
        captured["content"] = request.content
        return httpx.Response(
            200,
            json={
                "output": {
                    "choices": [
                        {
                            "message": {
                                "content": [
                                    {
                                        "type": "image",
                                        "image": f"https://img/dash/{i}.png",
                                    }
                                    for i in range(4)
                                ]
                            }
                        }
                    ]
                }
            },
            request=request,
        )

    result = await _generate(
        "系列插画",
        4,
        "2K",
        "url",
        None,
        transport=httpx.MockTransport(handler),
    )
    assert result["count"] == 4
    payload = json.loads(captured["content"])
    assert payload["parameters"]["size"] == "2K"
    assert payload["parameters"]["enable_sequential"] is True
    assert payload["parameters"]["n"] == 4


@pytest.mark.asyncio
async def test_dashscope_image_to_image_posts_images_in_content(monkeypatch):
    import json

    captured: dict = {}

    async def fake_get_config() -> ImageGenConfig:
        return DASHSCOPE_CONFIG

    monkeypatch.setattr("mcp_servers.image_gen_server._get_config", fake_get_config)

    def handler(request: httpx.Request) -> httpx.Response:
        captured["content"] = request.content
        return httpx.Response(
            200,
            json={
                "output": {
                    "choices": [
                        {
                            "message": {
                                "content": [
                                    {
                                        "type": "image",
                                        "image": "https://img/dash/a.png",
                                    },
                                    {
                                        "type": "image",
                                        "image": "https://img/dash/b.png",
                                    },
                                ]
                            }
                        }
                    ]
                }
            },
            request=request,
        )

    result = await _generate(
        "换成油画风格",
        2,
        "1024x1024",
        "url",
        None,
        ["https://example.com/ref.png"],
        transport=httpx.MockTransport(handler),
    )
    assert result["count"] == 2
    payload = json.loads(captured["content"])
    content = payload["input"]["messages"][0]["content"]
    assert content[0] == {"text": "换成油画风格"}
    assert content[1] == {"image": "https://example.com/ref.png"}
    assert "enable_sequential" not in payload["parameters"]
    assert payload["parameters"]["size"] == "1024*1024"
