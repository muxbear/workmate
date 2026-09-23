"""远程素材（图片 / 音视频）代理下载。

用于「文档写作专家」配图与「视频创作专家」成片落盘：由后端进程代理下载外部素材，
沙箱无需出网，也从根本上规避外链签名过期的问题。下载结果只返回字节与 MIME，
持久化与产物登记由调用方（``api.agent.artifacts.ingest_remote_asset``）完成。

设计约定：素材工具（``download_asset``）是图片与视频的统一落盘通道，
各端不再允许用 shell 命令下载素材（平台差异归零，见方案 D1）。
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Sequence
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)

# 默认超时（秒）、重定向次数上限、单文件大小上限（字节）
DEFAULT_TIMEOUT_SECONDS = 60.0
MAX_REDIRECTS = 3
DEFAULT_MAX_BYTES = 20 * 1024 * 1024

# 魔数 → MIME（图片类型校验兜底）
_MAGIC_MIME: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"BM", "image/bmp"),
    (b"\x00\x00\x01\x00", "image/x-icon"),
)


class AssetFetchError(Exception):
    """素材下载失败（协议、网络、类型或大小校验不通过）。"""


@dataclass(frozen=True)
class FetchedAsset:
    """下载完成的素材字节与元信息。"""

    content: bytes
    mime_type: str
    source_url: str

    @property
    def checksum(self) -> str:
        """返回内容的 sha256 摘要。"""
        return hashlib.sha256(self.content).hexdigest()


def is_http_url(url: str) -> bool:
    """判断是否为 http(s) 地址。"""
    return isinstance(url, str) and url.strip().lower().startswith(("http://", "https://"))


def sniff_image_mime(content: bytes) -> str | None:
    """按文件魔数识别图片 MIME；无法识别时返回 ``None``。"""
    if content.startswith(b"RIFF"):
        return "image/webp" if content[8:12] == b"WEBP" else None
    for magic, mime in _MAGIC_MIME:
        if content.startswith(magic):
            return mime
    head = content[:512].lstrip().lower()
    if head.startswith(b"<svg") or head.startswith(b"<?xml"):
        return "image/svg+xml"
    return None


def sniff_video_mime(content: bytes) -> str | None:
    """按容器魔数识别视频 MIME；无法识别时返回 ``None``。

    覆盖 HTML5 ``<video>`` 常用的几种容器：ISO BMFF（mp4/m4v/mov）、
    EBML（webm/mkv，统一按 ``video/webm`` 处理以保证浏览器可播）、
    RIFF/AVI 与 FLV。
    """
    if len(content) < 12:
        return None
    if content[4:8] == b"ftyp":
        brand = content[8:12]
        if brand in (b"qt  ",):
            return "video/quicktime"
        return "video/mp4"
    if content.startswith(b"\x1aE\xdf\xa3"):
        return "video/webm"
    if content.startswith(b"RIFF") and content[8:12] == b"AVI ":
        return "video/x-msvideo"
    if content.startswith(b"FLV\x01"):
        return "video/x-flv"
    return None


def sniff_media_mime(content: bytes) -> str | None:
    """按魔数识别素材 MIME（图片或视频）；无法识别时返回 ``None``。"""
    return sniff_image_mime(content) or sniff_video_mime(content)


def _host_allowed(url: str, allowed_hosts: Sequence[str] | None) -> bool:
    """校验目标主机是否在允许列表内（列表为空表示不限制）。"""
    if not allowed_hosts:
        return True
    host = (httpx.URL(url).host or "").lower()
    if not host:
        return False
    for rule in allowed_hosts:
        candidate = (rule or "").strip().lower()
        if not candidate:
            continue
        if candidate.startswith("*."):
            if host.endswith(candidate[1:]):
                return True
        elif host == candidate:
            return True
    return False


async def fetch_asset(
    url: str,
    *,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    max_bytes: int = DEFAULT_MAX_BYTES,
    image_max_bytes: int | None = None,
    allowed_hosts: Sequence[str] | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
    headers: dict[str, str] | None = None,
    allow_video: bool = True,
) -> FetchedAsset:
    """代理下载远程素材（图片 / 视频）并校验类型与大小。

    Args:
        url: 素材地址（仅支持 http/https）。
        timeout: 单次请求超时（秒）。
        max_bytes: 单文件大小上限（字节，<=0 表示不限制）；视频按此上限约束。
        image_max_bytes: 图片单独的大小上限；``None`` 表示与 ``max_bytes`` 相同。
        allowed_hosts: 允许的域名列表（支持 ``*.example.com`` 通配）；为空表示不限制。
        transport: 可注入的 httpx 传输层（测试用）。
        headers: 附加请求头。
        allow_video: 是否允许视频（``False`` 时非图片直接拒绝，等价于旧 ``fetch_image``）。

    Returns:
        下载完成的 :class:`FetchedAsset`。

    Raises:
        AssetFetchError: 地址非法、域名被拒、网络异常、类型不符或超过大小上限。
    """
    if not is_http_url(url):
        raise AssetFetchError("仅支持 http(s) 素材地址")
    if not _host_allowed(url, allowed_hosts):
        raise AssetFetchError("素材地址不在允许的域名范围内")

    request_headers = {"User-Agent": "ke-hermes-asset-fetcher/1.0"}
    if headers:
        request_headers.update(headers)

    try:
        async with httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=True,
            max_redirects=MAX_REDIRECTS,
            transport=transport,
        ) as client:
            response = await client.get(url, headers=request_headers)
    except httpx.HTTPError as error:
        raise AssetFetchError("素材下载失败：" + str(error)) from error

    if response.status_code >= 400:
        raise AssetFetchError("素材下载失败（HTTP " + str(response.status_code) + "）")

    declared = response.headers.get("content-type", "").split(";")[0].strip().lower()
    declared_length = response.headers.get("content-length", "")
    if (
        max_bytes > 0
        and declared_length.isdigit()
        and int(declared_length) > max_bytes
    ):
        raise AssetFetchError("素材超过大小上限")

    content = response.content
    if not content:
        raise AssetFetchError("素材内容为空")
    if max_bytes > 0 and len(content) > max_bytes:
        raise AssetFetchError("素材超过大小上限")

    sniffed = sniff_media_mime(content)
    if sniffed is None:
        # 魔数无法识别时，仅在声明的 MIME 属于受支持类别时放行（避免误收任意内容）
        if declared.startswith("image/") or (allow_video and declared.startswith("video/")):
            sniffed = declared
        elif declared.startswith("video/") and not allow_video:
            raise AssetFetchError("非图片内容：" + declared)
        else:
            raise AssetFetchError("不支持的素材类型：" + (declared or "unknown"))

    if not allow_video and not sniffed.startswith("image/"):
        raise AssetFetchError("非图片内容：" + sniffed)

    image_limit = max_bytes if image_max_bytes is None else image_max_bytes
    if sniffed.startswith("image/") and image_limit > 0 and len(content) > image_limit:
        raise AssetFetchError("图片超过大小上限")
    return FetchedAsset(content=content, mime_type=sniffed, source_url=url)


async def fetch_image(
    url: str,
    *,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    max_bytes: int = DEFAULT_MAX_BYTES,
    allowed_hosts: Sequence[str] | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
    headers: dict[str, str] | None = None,
) -> FetchedAsset:
    """代理下载远程图片并校验类型与大小（仅图片，语义与旧版本一致）。

    Args:
        url: 图片地址（仅支持 http/https）。
        timeout: 单次请求超时（秒）。
        max_bytes: 单文件大小上限（字节，<=0 表示不限制）。
        allowed_hosts: 允许的域名列表（支持 ``*.example.com`` 通配）；为空表示不限制。
        transport: 可注入的 httpx 传输层（测试用）。
        headers: 附加请求头。

    Returns:
        下载完成的 :class:`FetchedAsset`。

    Raises:
        AssetFetchError: 地址非法、域名被拒、网络异常、类型不符或超过大小上限。
    """
    return await fetch_asset(
        url,
        timeout=timeout,
        max_bytes=max_bytes,
        allowed_hosts=allowed_hosts,
        transport=transport,
        headers=headers,
        allow_video=False,
    )


__all__ = [
    "AssetFetchError",
    "DEFAULT_MAX_BYTES",
    "DEFAULT_TIMEOUT_SECONDS",
    "FetchedAsset",
    "MAX_REDIRECTS",
    "fetch_asset",
    "fetch_image",
    "is_http_url",
    "sniff_image_mime",
    "sniff_media_mime",
    "sniff_video_mime",
]