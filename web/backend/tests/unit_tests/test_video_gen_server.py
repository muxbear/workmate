"""视频生成 MCP server 单元测试。"""

import httpx
import pytest

from mcp_servers.video_gen_server import (
    VideoGenConfig,
    _api_origin,
    _build_payload,
    _generate,
    _normalize_duration,
    _normalize_media,
    _normalize_ratio,
    _normalize_resolution,
    _normalize_seed,
    _query_task,
    _synthesis_url,
    _task_url,
)

TEST_CONFIG = VideoGenConfig(
    api_base="https://example.com/v1",
    api_key="test-key",
    model="wan3.0-video",
)

MAAS_CONFIG = VideoGenConfig(
    api_base="https://llm-duxpo5ka08dtoh6y.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    api_key="test-key",
    model="wan3.0-video",
)


@pytest.fixture(autouse=True)
def _stub_config(monkeypatch):
    """单测固定模型配置，避免访问数据库或环境变量。"""

    async def fake_get_config() -> VideoGenConfig:
        return MAAS_CONFIG

    monkeypatch.setattr("mcp_servers.video_gen_server._get_config", fake_get_config)


def test_api_origin_parses_host():
    assert (
        _api_origin(
            "https://llm-duxpo5ka08dtoh6y.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
        )
        == "https://llm-duxpo5ka08dtoh6y.cn-beijing.maas.aliyuncs.com"
    )
    assert _api_origin("") == "https://dashscope.aliyuncs.com"


def test_synthesis_and_task_urls():
    assert "llm-duxpo5ka08dtoh6y.cn-beijing.maas.aliyuncs.com" in _synthesis_url(
        MAAS_CONFIG.api_base
    )
    assert _synthesis_url(MAAS_CONFIG.api_base).endswith(
        "/api/v1/services/aigc/video-generation/video-synthesis"
    )
    task_url = _task_url(MAAS_CONFIG.api_base, "abc/def")
    assert task_url.endswith("/api/v1/tasks/abc%2Fdef")


def test_normalize_parameters():
    assert _normalize_resolution("720p") == "720P"
    assert _normalize_resolution("4K") == "480P"
    assert _normalize_ratio("9:16") == "9:16"
    assert _normalize_ratio("bad") == "adaptive"
    assert _normalize_duration(60) == 30
    assert _normalize_duration(1) == 2
    assert _normalize_duration(-1) == -1
    assert _normalize_seed(-1) == -1
    assert _normalize_seed(2**40) == 2**31 - 1


def test_normalize_media_rejects_bad_items():
    with pytest.raises(ValueError):
        _normalize_media([{"type": "bad", "url": "https://x"}])
    with pytest.raises(ValueError):
        _normalize_media([{"type": "first_frame", "url": " "}])


def test_build_payload():
    payload = _build_payload(
        MAAS_CONFIG,
        "一只小猫",
        [{"type": "reference_image", "url": "https://img/1.png"}],
        "480p",
        "16:9",
        60,
        True,
        True,
        False,
        -1,
    )
    assert payload["model"] == "wan3.0-video"
    assert payload["input"]["prompt"] == "一只小猫"
    assert payload["input"]["media"] == [
        {"type": "reference_image", "url": "https://img/1.png"}
    ]
    assert payload["parameters"]["resolution"] == "480P"
    assert payload["parameters"]["ratio"] == "16:9"
    assert payload["parameters"]["duration"] == 30
    assert payload["parameters"]["seed"] == -1


@pytest.mark.asyncio
async def test_generate_video_wait_returns_video_url():
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            captured["post_url"] = str(request.url)
            captured["body"] = request.content
            captured["async_header"] = request.headers.get("X-DashScope-Async")
            captured["auth"] = request.headers.get("Authorization")
            return httpx.Response(
                200,
                json={
                    "output": {"task_id": "task-123", "task_status": "PENDING"},
                    "request_id": "req-1",
                },
                request=request,
            )
        captured["get_url"] = str(request.url)
        return httpx.Response(
            200,
            json={
                "output": {
                    "task_id": "task-123",
                    "task_status": "SUCCEEDED",
                    "video_url": "https://video/result.mp4",
                }
            },
            request=request,
        )

    result = await _generate(
        "一只小猫在月光下奔跑",
        wait=True,
        transport=httpx.MockTransport(handler),
    )
    assert result["task_id"] == "task-123"
    assert result["task_status"] == "SUCCEEDED"
    assert result["video_url"] == "https://video/result.mp4"
    assert captured["post_url"].endswith(
        "/api/v1/services/aigc/video-generation/video-synthesis"
    )
    assert captured["async_header"] == "enable"
    assert captured["auth"] == "Bearer test-key"
    assert captured["get_url"].endswith("/api/v1/tasks/task-123")
    import json

    payload = json.loads(captured["body"])
    assert payload["model"] == "wan3.0-video"
    assert payload["input"]["prompt"] == "一只小猫在月光下奔跑"
    assert payload["parameters"] == {
        "resolution": "480P",
        "ratio": "adaptive",
        "duration": 5,
        "audio": True,
        "prompt_extend": True,
        "watermark": False,
    }


@pytest.mark.asyncio
async def test_generate_video_no_wait_returns_task():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "output": {"task_id": "task-456", "task_status": "PENDING"},
                "request_id": "req-2",
            },
            request=request,
        )

    result = await _generate(
        "城市夜景航拍",
        wait=False,
        transport=httpx.MockTransport(handler),
    )
    assert result["task_id"] == "task-456"
    assert result["task_status"] == "PENDING"
    assert result["model"] == "wan3.0-video"


@pytest.mark.asyncio
async def test_generate_video_failed_task_returns_error():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(
                200,
                json={"output": {"task_id": "task-789", "task_status": "PENDING"}},
                request=request,
            )
        return httpx.Response(
            200,
            json={
                "output": {
                    "task_id": "task-789",
                    "task_status": "FAILED",
                    "code": "VideoGenerationError",
                    "message": "内容审核未通过",
                }
            },
            request=request,
        )

    result = await _generate(
        "测试失败场景",
        wait=True,
        transport=httpx.MockTransport(handler),
    )
    assert "error" in result
    assert result["task_status"] == "FAILED"
    assert result["message"] == "内容审核未通过"


@pytest.mark.asyncio
async def test_empty_prompt_returns_error():
    result = await _generate("   ")
    assert "error" in result
    assert result["error"] == "prompt 与 media 不能同时为空"


@pytest.mark.asyncio
async def test_http_error_returns_structured_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            500,
            json={"code": "InvalidApiKey", "message": "bad key"},
            request=request,
        )

    result = await _generate(
        "测试",
        wait=False,
        transport=httpx.MockTransport(handler),
    )
    assert "error" in result
    assert "500" in result["error"]
    assert "bad key" in result["error"]


@pytest.mark.asyncio
async def test_query_task():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "output": {
                    "task_id": "task-111",
                    "task_status": "RUNNING",
                },
                "request_id": "req-3",
            },
            request=request,
        )

    result = await _query_task(
        TEST_CONFIG,
        "task-111",
        transport=httpx.MockTransport(handler),
    )
    assert result["task_status"] == "RUNNING"
    assert result["task_id"] == "task-111"
