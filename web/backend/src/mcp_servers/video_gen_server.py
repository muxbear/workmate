# 文生视频 / 参考生视频 MCP Server
#
# 基于“模型”菜单中配置的阿里云百炼 wan3.0-video（video）模型提供视频生成能力：
# - generate_video：提交视频生成任务（文生视频 / 参考生视频），可等待完成
# - query_video_generation：查询异步任务状态并获取生成的视频 URL
#
# 模型与提供商配置优先从数据库 ai_models/providers 读取（与“模型”页面一致），
# 未配置时回退到 VIDEO_GEN_* 环境变量。
#
# 阿里云百炼视频生成使用异步 API：先 POST 创建任务获取 task_id，
# 再按约 15 秒间隔轮询 GET /api/v1/tasks/{task_id}，任务成功后从 video_url 下载。
#
# 参考请求：
#   POST https://{workspace}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis
#   -H 'X-DashScope-Async: enable'

"""基于 wan3.0-video 的阿里云百炼视频生成 MCP server。."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, cast
from urllib.parse import quote, urlparse

import httpx
from mcp.server.fastmcp import FastMCP

logger = logging.getLogger(__name__)

MODEL_NAME = "wan3.0-video"

DEFAULT_RESOLUTION = "480P"
DEFAULT_RATIO = "adaptive"
DEFAULT_DURATION = 5
MIN_DURATION = 2
MAX_DURATION = 30
MAX_SEED = 2**31 - 1

# 阿里云百炼 DashScope / MaaS 原生视频生成 API 路径
DEFAULT_API_ORIGIN = "https://dashscope.aliyuncs.com"
VIDEO_SYNTHESIS_PATH = "/api/v1/services/aigc/video-generation/video-synthesis"
TASKS_PATH = "/api/v1/tasks"

ALLOWED_RESOLUTIONS = {"480P", "720P", "1080P"}
ALLOWED_RATIOS = {"adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"}
ALLOWED_MEDIA_TYPES = {
    "first_frame",
    "last_frame",
    "reference_image",
    "reference_video",
    "reference_audio",
    "file",
    "link",
}
TERMINAL_STATUSES = {"SUCCEEDED", "FAILED", "CANCELED", "UNKNOWN"}

# 单次 HTTP 请求与同步等待轮询的超时（秒），可用 VIDEO_GEN_TIMEOUT_SECONDS 覆盖。
DEFAULT_TIMEOUT_SECONDS = float(os.getenv("VIDEO_GEN_TIMEOUT_SECONDS", "240"))
DEFAULT_POLL_INTERVAL_SECONDS = 8.0

mcp = FastMCP("ke-hermes-video-gen")


@dataclass(frozen=True)
class VideoGenConfig:
    """视频生成服务的模型与鉴权配置。."""

    api_base: str
    api_key: str
    model: str = MODEL_NAME


def _api_origin(api_base: str) -> str:
    """从提供商 API 地址提取 scheme://host，用于构造原生视频 API URL。."""
    candidate = (api_base or "").strip()
    if not candidate:
        return DEFAULT_API_ORIGIN
    if candidate.startswith(("http://", "https://")):
        parsed = urlparse(candidate)
        if parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}"
    return DEFAULT_API_ORIGIN


def _synthesis_url(api_base: str) -> str:
    """构造视频生成任务提交 URL。."""
    return f"{_api_origin(api_base).rstrip('/')}{VIDEO_SYNTHESIS_PATH}"


def _task_url(api_base: str, task_id: str) -> str:
    """构造异步任务查询 URL。."""
    return f"{_api_origin(api_base).rstrip('/')}{TASKS_PATH}/{quote(task_id, safe='')}"


def _normalize_resolution(resolution: str | None) -> str:
    """校验分辨率档位，非法值回退 480P。."""
    candidate = (resolution or DEFAULT_RESOLUTION).strip().upper()
    return candidate if candidate in ALLOWED_RESOLUTIONS else DEFAULT_RESOLUTION


def _normalize_ratio(ratio: str | None) -> str:
    """校验画面比例，非法值回退 adaptive。."""
    candidate = (ratio or DEFAULT_RATIO).strip()
    return candidate if candidate in ALLOWED_RATIOS else DEFAULT_RATIO


def _normalize_duration(duration: int | None) -> int:
    """将视频时长限制在 2-30 秒，支持 -1 智能时长。."""
    try:
        value = int(duration if duration is not None else DEFAULT_DURATION)
    except (TypeError, ValueError):
        return DEFAULT_DURATION
    if value == -1:
        return -1
    return max(MIN_DURATION, min(value, MAX_DURATION))


def _normalize_seed(seed: int | None) -> int | None:
    """将随机种子限制在合法范围，None 表示不传参由服务端随机。."""
    if seed is None:
        return None
    try:
        value = int(seed)
    except (TypeError, ValueError):
        return None
    if value == -1:
        return -1
    return max(0, min(value, MAX_SEED))


def _normalize_media(media: list[dict[str, Any]] | None) -> list[dict[str, str]]:
    """校验并规整参考素材列表，每项必须包含受支持的 type 与 url。."""
    if not media:
        return []
    normalized: list[dict[str, str]] = []
    for index, item in enumerate(media):
        if not isinstance(item, dict):
            raise ValueError(f"media[{index}] 必须是包含 type 与 url 的对象")
        media_type = str(item.get("type", "")).strip()
        url = str(item.get("url", "")).strip()
        if media_type not in ALLOWED_MEDIA_TYPES:
            raise ValueError(f"media[{index}] 的 type 不受支持：{media_type}")
        if not url:
            raise ValueError(f"media[{index}] 的 url 不能为空")
        normalized.append({"type": media_type, "url": url})
    return normalized


def _build_payload(
    config: VideoGenConfig,
    prompt: str,
    media: list[dict[str, str]],
    resolution: str,
    ratio: str,
    duration: int | None,
    audio: bool,
    prompt_extend: bool,
    watermark: bool,
    seed: int | None,
) -> dict[str, Any]:
    """构造 wan3.0-video 视频生成请求体。."""
    input_data: dict[str, Any] = {"prompt": prompt}
    if media:
        input_data["media"] = media
    parameters: dict[str, Any] = {
        "resolution": _normalize_resolution(resolution),
        "ratio": _normalize_ratio(ratio),
        "duration": _normalize_duration(duration),
        "audio": audio,
        "prompt_extend": prompt_extend,
        "watermark": watermark,
    }
    normalized_seed = _normalize_seed(seed)
    if normalized_seed is not None:
        parameters["seed"] = normalized_seed
    return {
        "model": config.model,
        "input": input_data,
        "parameters": parameters,
    }


def _error(message: str, **extra: Any) -> dict[str, Any]:
    """构造统一的错误返回结构。."""
    return {"error": message, **extra}


def _output(data: dict[str, Any]) -> dict[str, Any]:
    """提取 DashScope 响应中的 output 对象。."""
    output = data.get("output")
    return output if isinstance(output, dict) else {}


async def _post_json(
    config: VideoGenConfig,
    url: str,
    payload: dict[str, Any],
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """发送异步视频生成请求并返回响应体。."""
    headers = {
        "Authorization": f"Bearer {config.api_key}",
        "X-DashScope-Async": "enable",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(
        timeout=DEFAULT_TIMEOUT_SECONDS,
        follow_redirects=True,
        transport=transport,
    ) as client:
        response = await client.post(url, json=payload, headers=headers)
        response.raise_for_status()
        return cast(dict[str, Any], response.json())


async def _get_json(
    config: VideoGenConfig,
    url: str,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """发送任务查询 GET 请求并返回响应体。."""
    headers = {"Authorization": f"Bearer {config.api_key}"}
    async with httpx.AsyncClient(
        timeout=DEFAULT_TIMEOUT_SECONDS,
        follow_redirects=True,
        transport=transport,
    ) as client:
        response = await client.get(url, headers=headers)
        response.raise_for_status()
        return cast(dict[str, Any], response.json())


async def _submit_task(
    config: VideoGenConfig,
    prompt: str,
    media: list[dict[str, str]],
    resolution: str,
    ratio: str,
    duration: int | None,
    audio: bool,
    prompt_extend: bool,
    watermark: bool,
    seed: int | None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """提交视频生成异步任务并返回任务信息。."""
    payload = _build_payload(
        config,
        prompt,
        media,
        resolution,
        ratio,
        duration,
        audio,
        prompt_extend,
        watermark,
        seed,
    )
    data = await _post_json(config, _synthesis_url(config.api_base), payload, transport)
    output = _output(data)
    task_id = str(output.get("task_id", "")).strip()
    if not task_id:
        raise ValueError("视频生成服务未返回 task_id")
    parameters = cast(dict[str, Any], payload["parameters"])
    return {
        "task_id": task_id,
        "task_status": str(output.get("task_status", "PENDING")).upper(),
        "model": config.model,
        "resolution": parameters["resolution"],
        "ratio": parameters["ratio"],
        "duration": parameters["duration"],
        "message": "任务已提交（异步生成），处理完成后可通过查询接口获取视频 URL",
    }


async def _query_task(
    config: VideoGenConfig,
    task_id: str,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """查询一次视频生成任务状态并返回结构化结果。."""
    data = await _get_json(config, _task_url(config.api_base, task_id), transport)
    output = _output(data)
    if not output:
        raise ValueError("查询视频生成任务失败：响应中缺少 output")
    status = str(output.get("task_status", "")).upper()
    result: dict[str, Any] = {
        "task_id": task_id,
        "task_status": status,
    }
    if data.get("request_id"):
        result["request_id"] = data["request_id"]
    if output.get("video_url"):
        result["video_url"] = output["video_url"]
    if output.get("code"):
        result["code"] = output["code"]
    if output.get("message"):
        result["message"] = output["message"]
    if status == "SUCCEEDED" and not output.get("video_url"):
        result["message"] = "任务已完成，但响应中未包含视频 URL"
    return result


async def _wait_task(
    config: VideoGenConfig,
    task_id: str,
    transport: httpx.AsyncBaseTransport | None = None,
    poll_interval: float | None = None,
    timeout: float | None = None,
) -> dict[str, Any]:
    """轮询异步任务直到成功/失败，或达到等待上限后返回当前状态。."""
    interval = poll_interval or DEFAULT_POLL_INTERVAL_SECONDS
    deadline = time.monotonic() + (timeout or DEFAULT_TIMEOUT_SECONDS)
    while True:
        state = await _query_task(config, task_id, transport)
        status = str(state.get("task_status", "")).upper()
        if status == "SUCCEEDED":
            return state
        if status in {"FAILED", "CANCELED", "UNKNOWN"}:
            failure: dict[str, Any] = {
                "error": "视频生成任务未成功",
                "task_id": task_id,
                "task_status": status,
            }
            for key in ("code", "message", "request_id", "video_url"):
                if state.get(key) is not None:
                    failure[key] = state[key]
            return failure
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return {
                "task_id": task_id,
                "task_status": status,
                "video_url": "",
                "timed_out": True,
                "message": (
                    f"任务仍在处理中（{status}），"
                    f'请稍后调用 query_video_generation(task_id="{task_id}") 查询结果'
                ),
            }
        await asyncio.sleep(min(interval, remaining))


async def _load_config_from_db() -> VideoGenConfig | None:
    """从数据库读取 wan3.0-video 模型及其提供商配置。."""
    try:
        from sqlalchemy import select

        from core.security import decrypt_api_key
        from db.engine import async_session
        from db.models.ai_model import AIModel
        from db.models.provider import Provider

        async with async_session() as db:
            row = (
                await db.execute(
                    select(AIModel, Provider)
                    .join(Provider, Provider.id == AIModel.provider_id)
                    .where(AIModel.name == MODEL_NAME)
                )
            ).first()
            if row is None:
                logger.warning("数据库中没有找到模型 %s", MODEL_NAME)
                return None
            model, provider = row
            if not provider.api_base or not provider.api_key:
                logger.warning("模型 %s 的提供商未配置 API 地址或密钥", MODEL_NAME)
                return None
            return VideoGenConfig(
                api_base=provider.api_base,
                api_key=decrypt_api_key(provider.api_key),
                model=model.name or MODEL_NAME,
            )
    except Exception as exc:
        logger.warning("读取模型配置失败，回退环境变量：%s", exc)
        return None


def _config_from_env() -> VideoGenConfig | None:
    """回退读取 VIDEO_GEN_* 环境变量配置。."""
    try:
        from agent.config import settings

        if settings.VIDEO_GEN_API_KEY and settings.VIDEO_GEN_BASE_URL:
            return VideoGenConfig(
                api_base=settings.VIDEO_GEN_BASE_URL,
                api_key=settings.VIDEO_GEN_API_KEY,
                model=settings.VIDEO_GEN_MODEL or MODEL_NAME,
            )
    except Exception as exc:
        logger.warning("读取环境变量配置失败：%s", exc)
    return None


async def _get_config() -> VideoGenConfig:
    """获取视频生成配置：数据库 > 环境变量。."""
    config = await _load_config_from_db()
    if config is None:
        config = _config_from_env()
    if config is None:
        raise RuntimeError(
            f"视频生成服务未配置：请在「模型」页面为 {MODEL_NAME} 配置提供商，"
            "或设置 VIDEO_GEN_BASE_URL / VIDEO_GEN_API_KEY"
        )
    return config


def _describe_http_error(exc: httpx.HTTPStatusError) -> str:
    """提取 HTTP 错误响应的可读描述。."""
    status = exc.response.status_code if exc.response is not None else "未知"
    detail = ""
    if exc.response is not None:
        try:
            body = exc.response.json()
            if isinstance(body, dict):
                detail = str(body.get("message") or body.get("code") or "")
        except ValueError:
            detail = exc.response.text[:500]
    if not detail:
        detail = exc.response.text[:500] if exc.response is not None else ""
    return f"视频生成服务返回错误（HTTP {status}）" + (f"：{detail}" if detail else "")


async def _generate(
    prompt: str,
    media: list[dict[str, Any]] | None = None,
    resolution: str = DEFAULT_RESOLUTION,
    ratio: str = DEFAULT_RATIO,
    duration: int | None = DEFAULT_DURATION,
    audio: bool = True,
    prompt_extend: bool = True,
    watermark: bool = False,
    seed: int | None = None,
    wait: bool = True,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """核心逻辑：提交任务并按需轮询等待视频生成完成。."""
    prompt = (prompt or "").strip()
    try:
        normalized_media = _normalize_media(media)
    except ValueError as exc:
        return _error(str(exc))
    if not prompt and not normalized_media:
        return _error("prompt 与 media 不能同时为空")

    config = await _get_config()
    try:
        submitted = await _submit_task(
            config,
            prompt,
            normalized_media,
            resolution,
            ratio,
            duration,
            audio,
            prompt_extend,
            watermark,
            seed,
            transport,
        )
        if not wait:
            return submitted
        return await _wait_task(config, str(submitted["task_id"]), transport)
    except httpx.HTTPStatusError as exc:
        return _error(_describe_http_error(exc))
    except httpx.TimeoutException as exc:
        return _error(f"视频生成请求超时：{exc}")
    except httpx.HTTPError as exc:
        return _error(f"视频生成请求失败：{exc}")
    except ValueError as exc:
        return _error(str(exc))
    except Exception as exc:
        logger.exception("视频生成失败")
        return _error(f"视频生成失败：{exc}")


@mcp.tool()
async def generate_video(
    prompt: str,
    media: list[dict[str, str]] | None = None,
    resolution: str = DEFAULT_RESOLUTION,
    ratio: str = DEFAULT_RATIO,
    duration: int = DEFAULT_DURATION,
    audio: bool = True,
    prompt_extend: bool = True,
    watermark: bool = False,
    seed: int | None = None,
    wait: bool = True,
) -> dict[str, Any]:
    """根据文本或参考素材生成视频（阿里云百炼 wan3.0-video，异步任务）。.

    提交后按 8 秒间隔轮询直到成功、失败或达到等待上限；等待超时仍会返回
    task_id，可继续调用 query_video_generation 查询。

    Args:
        prompt: 文本提示词，描述期望生成的视频内容；与 media 至少提供一项。
        media: 参考素材列表，每项为 {type, url} 字典。type 支持 first_frame、
            last_frame、reference_image、reference_video、reference_audio、
            file、link，url 支持公网 URL、OSS 临时 URL 或 data URI。
        resolution: 分辨率档位：480P / 720P / 1080P，默认 480P。
        ratio: 画面比例：adaptive / 16:9 / 4:3 / 1:1 / 3:4 / 9:16，默认 adaptive。
        duration: 视频时长（秒），取值范围 2-30，传 -1 使用智能时长，默认 5。
        audio: 输出视频是否包含音频，默认 true。
        prompt_extend: 是否开启 prompt 智能改写，默认 true。
        watermark: 是否添加水印标识，默认 false。
        seed: 随机种子，-1 或 0-2147483647，默认不传由服务端随机。
        wait: 是否同步等待任务完成后再返回，默认 true。

    Returns:
        任务状态与生成结果：成功后含 video_url；仍在处理时含 task_id，
        可通过 query_video_generation 继续查询。
    """
    return await _generate(
        prompt,
        media,
        resolution,
        ratio,
        duration,
        audio,
        prompt_extend,
        watermark,
        seed,
        wait,
    )


@mcp.tool()
async def query_video_generation(task_id: str) -> dict[str, Any]:
    """查询 wan3.0-video 视频生成任务的当前状态与结果。.

    Args:
        task_id: generate_video 返回的任务 ID。

    Returns:
        当前任务状态；成功时包含 video_url（有效期 24 小时），
        仍在处理时建议间隔约 15 秒后再次查询。
    """
    task_id = (task_id or "").strip()
    if not task_id:
        return _error("task_id 不能为空")
    config = await _get_config()
    try:
        return await _query_task(config, task_id)
    except httpx.HTTPStatusError as exc:
        return _error(_describe_http_error(exc))
    except httpx.TimeoutException as exc:
        return _error(f"查询视频生成任务超时：{exc}")
    except httpx.HTTPError as exc:
        return _error(f"查询视频生成任务失败：{exc}")
    except ValueError as exc:
        return _error(str(exc))
    except Exception as exc:
        logger.exception("查询视频生成任务失败")
        return _error(f"查询视频生成任务失败：{exc}")


__all__ = [
    "mcp",
    "MODEL_NAME",
    "_api_origin",
    "_build_payload",
    "_generate",
    "_normalize_duration",
    "_normalize_media",
    "_normalize_ratio",
    "_normalize_resolution",
    "_normalize_seed",
    "_query_task",
    "_submit_task",
    "_synthesis_url",
    "_task_url",
    "generate_video",
    "query_video_generation",
]


def main() -> None:
    """启动 MCP Server。."""
    mcp.run()


if __name__ == "__main__":
    main()
