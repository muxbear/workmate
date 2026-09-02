# 文生图 / 文生组图 / 图生组图 MCP Server
#
# 基于"模型"菜单中配置的 wan2.7-image-pro（image-gen）模型提供图像生成能力：
# - text_to_image：文生图（单张）
# - text_to_image_batch：文生组图（一次生成多张）
# - image_to_image_batch：图生组图（参考图 + 提示词批量生成多张）
#
# 模型与提供商配置优先从数据库 ai_models/providers 读取（与"模型"页面一致），
# 未配置时回退到 IMAGE_GEN_* 环境变量。.


"""基于 wan2.7-image-pro 的图像生成 MCP server。."""

from __future__ import annotations

import base64
import binascii
import logging
import re
from dataclasses import dataclass
from typing import Any, cast

import httpx
from mcp.server.fastmcp import FastMCP

logger = logging.getLogger(__name__)

MODEL_NAME = "wan2.7-image-pro"
DEFAULT_SIZE = "1024x1024"
DEFAULT_TIMEOUT_SECONDS = 120.0
MAX_BATCH_COUNT = 8
DASH_SCOPE_GENERATION_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"


_SIZE_PATTERN = re.compile(r"^\d{2,4}x\d{2,4}$")
_MAX_BASE64_LENGTH = 15 * 1024 * 1024

mcp = FastMCP("ke-hermes-image-gen")


@dataclass(frozen=True)
class ImageGenConfig:
    """图像生成服务的模型与鉴权配置。."""

    api_base: str
    api_key: str
    model: str = MODEL_NAME


def _generations_url(api_base: str) -> str:
    """构造 OpenAI 兼容的图片生成端点。."""
    base = api_base.strip().rstrip("/")
    if base.endswith("/images/generations"):
        return base
    if base.endswith("/images/edits"):
        return base[: -len("/images/edits")] + "/images/generations"
    return f"{base}/images/generations"


def _edits_url(api_base: str) -> str:
    """构造 OpenAI 兼容的图片编辑（图生图）端点。."""
    base = api_base.strip().rstrip("/")
    if base.endswith("/images/edits"):
        return base
    if base.endswith("/images/generations"):
        return base[: -len("/images/generations")] + "/images/edits"
    return f"{base}/images/edits"


def _dashscope_generation_url() -> str:
    """返回 DashScope 原生多模态生成端点（同步，无需轮询）。."""
    return DASH_SCOPE_GENERATION_URL


def _is_dashscope(api_base: str) -> bool:
    """判断提供商是否为阿里云百炼 DashScope。."""
    return "dashscope.aliyuncs.com" in (api_base or "")


def _normalize_size_dashscope(size: str | None) -> str:
    """将 DashScope 尺寸格式化为 1024x1024 -> 1024*1024；1K/2K/4K 保留；非法值回退 2K。."""
    candidate = (size or "").strip().lower()
    if candidate in {"1k", "2k", "4k"}:
        return candidate.upper()
    match = re.fullmatch(r"(\d{2,4})[x*](\d{2,4})", candidate)
    if match:
        return f"{int(match.group(1))}*{int(match.group(2))}"
    return "2K"


def _to_dashscope_image(image: str) -> str:
    """将参考图统一为 DashScope 可接受的 URL 或 data URI。."""
    image = image.strip()
    if image.startswith(("http://", "https://", "data:")):
        return image
    try:
        base64.b64decode(image)
    except (ValueError, binascii.Error):
        return image
    return f"data:image/png;base64,{image}"


def _build_dashscope_payload(
    config: ImageGenConfig,
    prompt: str,
    size: str,
    count: int,
    reference_images: list[str] | None = None,
) -> dict[str, Any]:
    """构造 DashScope 原生多模态生成请求体。."""
    content: list[dict[str, str]] = [{"text": prompt}]
    if reference_images:
        for image in reference_images:
            content.append({"image": _to_dashscope_image(image)})
    parameters: dict[str, Any] = {"n": count, "size": size}
    if not reference_images and count > 1:
        # 文生组图：开启连环画模式，保证多张图风格一致
        parameters["enable_sequential"] = True
    return {
        "model": config.model,
        "input": {"messages": [{"role": "user", "content": content}]},
        "parameters": parameters,
    }


def _parse_dashscope_images(data: dict[str, Any]) -> list[dict[str, str]]:
    """从 DashScope 原生响应中提取图片 URL 列表。."""
    output = data.get("output") or {}
    choices = output.get("choices") or []
    images: list[dict[str, str]] = []
    for choice in choices:
        if not isinstance(choice, dict):
            continue
        message = choice.get("message") or {}
        content = message.get("content") or []
        if isinstance(content, dict):
            content = [content]
        for item in content:
            if not isinstance(item, dict):
                continue
            if str(item.get("type", "")).lower() == "image" and item.get("image"):
                images.append({"url": str(item["image"])})
    return images


def _normalize_size(size: str | None) -> str:
    """校验图片尺寸，非法值回退默认尺寸。."""
    candidate = (size or DEFAULT_SIZE).strip().lower()
    if _SIZE_PATTERN.fullmatch(candidate):
        return candidate
    return DEFAULT_SIZE


def _normalize_count(count: int | None) -> int:
    """将生成数量限制在合法范围（1 ~ MAX_BATCH_COUNT）。."""
    try:
        value = int(count or 1)
    except (TypeError, ValueError):
        return 1
    return max(1, min(value, MAX_BATCH_COUNT))


async def _load_config_from_db() -> ImageGenConfig | None:
    """从数据库读取 wan2.7-image-pro 模型及其提供商配置。."""
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
            return ImageGenConfig(
                api_base=provider.api_base,
                api_key=decrypt_api_key(provider.api_key),
                model=model.name or MODEL_NAME,
            )
    except Exception as exc:
        logger.warning("读取模型配置失败，回退环境变量: %s", exc)
        return None


def _config_from_env() -> ImageGenConfig | None:
    """回退读取 IMAGE_GEN_* 环境变量配置。."""
    try:
        from agent.config import settings

        if settings.IMAGE_GEN_API_KEY and settings.IMAGE_GEN_BASE_URL:
            return ImageGenConfig(
                api_base=settings.IMAGE_GEN_BASE_URL,
                api_key=settings.IMAGE_GEN_API_KEY,
                model=settings.IMAGE_GEN_MODEL or MODEL_NAME,
            )
    except Exception as exc:
        logger.warning("读取环境变量配置失败: %s", exc)
    return None


async def _get_config() -> ImageGenConfig:
    """获取图像生成配置：数据库 > 环境变量。."""
    config = await _load_config_from_db()
    if config is None:
        config = _config_from_env()
    if config is None:
        raise RuntimeError(
            f"图像生成服务未配置：请在「模型」页面为 {MODEL_NAME} 配置提供商，"
            "或设置 IMAGE_GEN_BASE_URL / IMAGE_GEN_API_KEY"
        )
    return config


def _build_payload(
    config: ImageGenConfig,
    prompt: str,
    size: str,
    count: int,
    response_format: str,
    seed: int | None,
) -> dict[str, Any]:
    """构造图片生成请求体。."""
    payload: dict[str, Any] = {
        "model": config.model,
        "prompt": prompt,
        "n": count,
        "size": size,
        "response_format": "b64_json" if response_format == "b64_json" else "url",
    }
    if seed is not None:
        try:
            payload["seed"] = int(seed)
        except (TypeError, ValueError):
            pass
    return payload


async def _request_json(
    config: ImageGenConfig,
    url: str,
    payload: dict[str, Any],
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """发送 JSON 请求并返回解析后的响应体。."""
    headers = {"Authorization": f"Bearer {config.api_key}"}
    async with httpx.AsyncClient(
        timeout=DEFAULT_TIMEOUT_SECONDS,
        follow_redirects=True,
        transport=transport,
    ) as client:
        response = await client.post(url, json=payload, headers=headers)
        response.raise_for_status()
        return cast(dict[str, Any], response.json())


async def _request_multipart(
    config: ImageGenConfig,
    url: str,
    payload: dict[str, Any],
    image_file: tuple[str, bytes, str],
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """以 multipart 表单发送图片编辑请求。."""
    headers = {"Authorization": f"Bearer {config.api_key}"}
    filename, content, mime = image_file
    async with httpx.AsyncClient(
        timeout=DEFAULT_TIMEOUT_SECONDS,
        follow_redirects=True,
        transport=transport,
    ) as client:
        response = await client.post(
            url,
            data=payload,
            files={"image": (filename, content, mime)},
            headers=headers,
        )
        response.raise_for_status()
        return cast(dict[str, Any], response.json())


def _parse_images(data: dict[str, Any]) -> list[dict[str, str]]:
    """从 OpenAI 兼容响应中提取图片 URL / base64 列表。."""
    items = data.get("data") or []
    images: list[dict[str, str]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        if item.get("url"):
            images.append({"url": str(item["url"])})
        elif item.get("b64_json"):
            images.append({"b64_json": str(item["b64_json"])})
    return images


def _error(message: str, **extra: Any) -> dict[str, Any]:
    """构造统一的错误返回结构。."""
    return {"error": message, **extra}


def _decode_data_uri(image: str) -> tuple[bytes, str] | None:
    """解码 data URI（data:image/png;base64,...）为字节内容与 MIME 类型。."""
    if not image.startswith("data:"):
        return None
    header, _, encoded = image.partition(",")
    mime = "image/png"
    meta = header[5:]
    if ";" in meta:
        mime = meta.split(";", 1)[0] or mime
    try:
        content = base64.b64decode(encoded)
    except (ValueError, binascii.Error):
        return None
    return content, mime


async def _image_file_from_input(
    image: str,
    transport: httpx.AsyncBaseTransport | None = None,
) -> tuple[str, bytes, str]:
    """将图片 URL / data URI / 纯 base64 转换为 multipart 上传文件。."""
    image = image.strip()
    if not image:
        raise ValueError("图片不能为空")

    decoded = _decode_data_uri(image)
    if decoded is not None:
        content, mime = decoded
        return "reference.png", content, mime

    if image.startswith(("http://", "https://")):
        async with httpx.AsyncClient(
            timeout=60,
            follow_redirects=True,
            transport=transport,
        ) as client:
            response = await client.get(image)
            response.raise_for_status()
            content_type = response.headers.get("content-type", "image/png").split(";")[
                0
            ]
            return "reference.png", response.content, content_type

    try:
        content = base64.b64decode(image)
    except (ValueError, binascii.Error) as exc:
        raise ValueError(
            "图片参数必须是 http(s) URL、data URI 或 base64 字符串"
        ) from exc
    if len(content) > _MAX_BASE64_LENGTH:
        raise ValueError("图片文件过大")
    return "reference.png", content, "image/png"


async def _generate(
    prompt: str,
    count: int,
    size: str,
    response_format: str,
    seed: int | None,
    reference_images: list[str] | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """核心生成逻辑：文生图走 generations，图生图走 edits。."""
    prompt = (prompt or "").strip()
    if not prompt:
        return _error("prompt 不能为空")

    config = await _get_config()
    count = _normalize_count(count)
    is_dashscope = _is_dashscope(config.api_base)
    size = _normalize_size_dashscope(size) if is_dashscope else _normalize_size(size)

    try:
        if is_dashscope:
            payload = _build_dashscope_payload(
                config, prompt, size, count, reference_images
            )
            data = await _request_json(
                config,
                _dashscope_generation_url(),
                payload,
                transport,
            )
            images = _parse_dashscope_images(data)[:count]
        elif reference_images:
            payload = _build_payload(config, prompt, size, count, response_format, seed)
            image_files = [
                await _image_file_from_input(image, transport)
                for image in reference_images
            ]
            # 多张参考图时逐张调用 edits，避免部分服务只接受单图
            all_images: list[dict[str, str]] = []
            for filename, content, mime in image_files:
                data = await _request_multipart(
                    config,
                    _edits_url(config.api_base),
                    payload,
                    (filename, content, mime),
                    transport,
                )
                all_images.extend(_parse_images(data))
                if len(all_images) >= count:
                    break
            images = all_images[:count]
        else:
            payload = _build_payload(config, prompt, size, count, response_format, seed)
            data = await _request_json(
                config,
                _generations_url(config.api_base),
                payload,
                transport,
            )
            images = _parse_images(data)[:count]
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text[:500] if exc.response else ""
        return _error(
            f"图像生成服务返回错误（HTTP {exc.response.status_code if exc.response else '未知'}）",
            prompt=prompt,
            detail=detail,
        )
    except httpx.TimeoutException as exc:
        return _error(f"图像生成请求超时：{exc}", prompt=prompt)
    except httpx.HTTPError as exc:
        return _error(f"图像生成请求失败：{exc}", prompt=prompt)
    except ValueError as exc:
        return _error(str(exc), prompt=prompt)
    except Exception as exc:
        logger.exception("图像生成失败")
        return _error(f"图像生成失败：{exc}", prompt=prompt)

    if not images:
        return _error("图像生成服务未返回图片数据", prompt=prompt)
    return {
        "prompt": prompt,
        "model": config.model,
        "size": size,
        "count": len(images),
        "images": images,
    }


@mcp.tool()
async def text_to_image(
    prompt: str,
    size: str = DEFAULT_SIZE,
    response_format: str = "url",
    seed: int | None = None,
) -> dict[str, Any]:
    """根据文本提示生成一张图片（文生图）。.

    Args:
        prompt: 图片描述提示词，支持中英文。
        size: 图片尺寸，如 1024x1024、1280x720、720x1280，默认 1024x1024。
        response_format: 返回格式，url（默认）或 b64_json。
        seed: 随机种子，相同种子可复现相近结果。

    Returns:
        包含单张图片 url 或 b64_json 的字典。.
    """
    return await _generate(prompt, 1, size, response_format, seed)


@mcp.tool()
async def text_to_image_batch(
    prompt: str,
    count: int = 4,
    size: str = DEFAULT_SIZE,
    response_format: str = "url",
    seed: int | None = None,
) -> dict[str, Any]:
    """根据文本提示一次性生成多张图片（文生组图）。.

    Args:
        prompt: 图片描述提示词，支持中英文。
        count: 生成图片数量，范围 1-8，默认 4。
        size: 图片尺寸，如 1024x1024、1280x720、720x1280，默认 1024x1024。
        response_format: 返回格式，url（默认）或 b64_json。
        seed: 随机种子，相同种子可复现相近结果。

    Returns:
        包含多张图片 url / b64_json 列表的字典。.
    """
    return await _generate(prompt, count, size, response_format, seed)


@mcp.tool()
async def image_to_image_batch(
    image: str,
    prompt: str = "",
    count: int = 4,
    size: str = DEFAULT_SIZE,
    response_format: str = "url",
    seed: int | None = None,
) -> dict[str, Any]:
    """基于一张或多张参考图批量生成多张风格一致的图片（图生组图）。.

    Args:
        image: 参考图片，支持 http(s) URL、data URI 或 base64 字符串。
        prompt: 图像编辑提示词（为空时以原图为基础变换）。
        count: 生成图片数量，范围 1-8，默认 4。
        size: 输出图片尺寸，如 1024x1024、1280x720、720x1280，默认 1024x1024。
        response_format: 返回格式，url（默认）或 b64_json。
        seed: 随机种子，相同种子可复现相近结果。

    Returns:
        包含多张图片 url / b64_json 列表的字典。.
    """
    return await _generate(prompt, count, size, response_format, seed, [image])


__all__ = [
    "mcp",
    "MODEL_NAME",
    "_build_dashscope_payload",
    "_dashscope_generation_url",
    "_generate",
    "_generations_url",
    "_edits_url",
    "_image_file_from_input",
    "_is_dashscope",
    "_normalize_count",
    "_normalize_size",
    "_normalize_size_dashscope",
    "_parse_dashscope_images",
    "_parse_images",
    "_to_dashscope_image",
    "image_to_image_batch",
    "text_to_image",
    "text_to_image_batch",
]


def main() -> None:
    """启动 MCP Server。."""
    mcp.run()


if __name__ == "__main__":
    main()
