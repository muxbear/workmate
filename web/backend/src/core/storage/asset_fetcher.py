"""远程素材（图片）代理下载。

用于「文档写作专家」等配图场景：由后端进程代理下载外部图片，沙箱无需出网，
也从根本上规避图片外链签名过期的问题。下载结果只返回字节与 MIME，
持久化与产物登记由调用方（``api.agent.artifacts.ingest_remote_asset``）完成。
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


async def fetch_image(
    url: str,
    *,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    max_bytes: int = DEFAULT_MAX_BYTES,
    allowed_hosts: Sequence[str] | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
    headers: dict[str, str] | None = None,
) -> FetchedAsset:
    """代理下载远程图片并校验类型与大小。

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
    if not is_http_url(url):
        raise AssetFetchError("仅支持 http(s) 图片地址")
    if not _host_allowed(url, allowed_hosts):
        raise AssetFetchError("图片地址不在允许的域名范围内")

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
        raise AssetFetchError("图片下载失败：" + str(error)) from error

    if response.status_code >= 400:
        raise AssetFetchError("图片下载失败（HTTP " + str(response.status_code) + "）")

    declared = response.headers.get("content-type", "").split(";")[0].strip().lower()
    declared_length = response.headers.get("content-length", "")
    if (
        max_bytes > 0
        and declared_length.isdigit()
        and int(declared_length) > max_bytes
    ):
        raise AssetFetchError("图片超过大小上限")

    content = response.content
    if not content:
        raise AssetFetchError("图片内容为空")
    if max_bytes > 0 and len(content) > max_bytes:
        raise AssetFetchError("图片超过大小上限")

    sniffed = sniff_image_mime(content)
    if sniffed is None:
        if not declared.startswith("image/"):
            raise AssetFetchError("非图片内容：" + (declared or "unknown"))
        sniffed = declared
    return FetchedAsset(content=content, mime_type=sniffed, source_url=url)


__all__ = [
    "AssetFetchError",
    "DEFAULT_MAX_BYTES",
    "DEFAULT_TIMEOUT_SECONDS",
    "FetchedAsset",
    "MAX_REDIRECTS",
    "fetch_image",
    "is_http_url",
    "sniff_image_mime",
]