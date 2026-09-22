"""后端代理下载（asset_fetcher）单元测试。"""

import asyncio

import httpx
import pytest

from core.storage.asset_fetcher import (
    AssetFetchError,
    fetch_image,
    is_http_url,
    sniff_image_mime,
)

PNG_BYTES = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) + bytes(8)


def _transport(status=200, content=PNG_BYTES, content_type="image/png"):
    """构造返回固定响应的 httpx MockTransport。"""

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status, content=content, headers={"content-type": content_type}
        )

    return httpx.MockTransport(handler)


def test_sniff_image_mime() -> None:
    """按魔数识别常见图片类型，未知内容返回 None。"""
    assert sniff_image_mime(PNG_BYTES) == "image/png"
    assert sniff_image_mime(bytes([0xFF, 0xD8, 0xFF, 0xE0])) == "image/jpeg"
    assert sniff_image_mime(b"GIF89a") == "image/gif"
    assert sniff_image_mime(b"RIFF" + bytes(4) + b"WEBP") == "image/webp"
    assert (
        sniff_image_mime(b"<svg xmlns=\'http://www.w3.org/2000/svg\'></svg>")
        == "image/svg+xml"
    )
    assert sniff_image_mime(b"hello world") is None
    assert sniff_image_mime(b"RIFF" + bytes(4) + b"WAVE") is None


def test_is_http_url() -> None:
    """仅 http(s) 视为合法地址。"""
    assert is_http_url("https://example.com/a.png") is True
    assert is_http_url("http://example.com/a.png") is True
    assert is_http_url("file:///d:/a.png") is False
    assert is_http_url("data:image/png;base64,AAA") is False


def test_fetch_image_success() -> None:
    """正常下载返回字节、MIME 与 sha256 摘要。"""
    asset = asyncio.run(fetch_image("https://cdn.example.com/a.png", transport=_transport()))
    assert asset.content == PNG_BYTES
    assert asset.mime_type == "image/png"
    assert asset.source_url == "https://cdn.example.com/a.png"
    assert len(asset.checksum) == 64


def test_fetch_image_host_allowlist() -> None:
    """白名单命中通配域名放行，未命中拒绝。"""
    allowed = asyncio.run(
        fetch_image(
            "https://cdn.example.com/a.png",
            allowed_hosts=["*.example.com"],
            transport=_transport(),
        )
    )
    assert allowed.mime_type == "image/png"

    with pytest.raises(AssetFetchError):
        asyncio.run(
            fetch_image(
                "https://cdn.other.com/a.png",
                allowed_hosts=["*.example.com"],
                transport=_transport(),
            )
        )


def test_fetch_image_rejects_invalid_input() -> None:
    """非 http(s)、HTTP 失败、空内容、非图片与超过大小上限都抛 AssetFetchError。"""
    with pytest.raises(AssetFetchError):
        asyncio.run(fetch_image("file:///d:/a.png"))
    with pytest.raises(AssetFetchError):
        asyncio.run(fetch_image("https://x/a.png", transport=_transport(status=404)))
    with pytest.raises(AssetFetchError):
        asyncio.run(fetch_image("https://x/a.png", transport=_transport(content=b"")))
    with pytest.raises(AssetFetchError):
        asyncio.run(
            fetch_image(
                "https://x/a.html",
                transport=_transport(content=b"<html></html>", content_type="text/html"),
            )
        )
    with pytest.raises(AssetFetchError):
        asyncio.run(fetch_image("https://x/a.png", max_bytes=4, transport=_transport()))
