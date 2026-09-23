"""后端代理下载（asset_fetcher）单元测试。"""

import asyncio

import httpx
import pytest

from core.storage.asset_fetcher import (
    AssetFetchError,
    fetch_asset,
    fetch_image,
    is_http_url,
    sniff_image_mime,
    sniff_media_mime,
    sniff_video_mime,
)

PNG_BYTES = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) + bytes(8)
MP4_BYTES = b"\x00\x00\x00\x18ftypisom" + bytes(8)
MOV_BYTES = b"\x00\x00\x00\x14ftypqt  " + bytes(8)
WEBM_BYTES = b"\x1aE\xdf\xa3" + bytes(20)
AVI_BYTES = b"RIFF" + bytes(4) + b"AVI " + bytes(8)


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


def test_sniff_video_mime() -> None:
    """按容器魔数识别视频类型，未知内容返回 None。"""
    assert sniff_video_mime(MP4_BYTES) == "video/mp4"
    assert sniff_video_mime(MOV_BYTES) == "video/quicktime"
    assert sniff_video_mime(WEBM_BYTES) == "video/webm"
    assert sniff_video_mime(AVI_BYTES) == "video/x-msvideo"
    assert sniff_video_mime(PNG_BYTES) is None
    assert sniff_video_mime(b"ftyp") is None


def test_sniff_media_mime_covers_image_and_video() -> None:
    """素材嗅探同时覆盖图片与视频。"""
    assert sniff_media_mime(PNG_BYTES) == "image/png"
    assert sniff_media_mime(MP4_BYTES) == "video/mp4"
    assert sniff_media_mime(b"hello world") is None


def test_fetch_asset_accepts_video() -> None:
    """fetch_asset 接受视频，并按视频上限校验大小。"""
    asset = asyncio.run(
        fetch_asset(
            "https://cdn.example.com/a.mp4",
            transport=_transport(content=MP4_BYTES, content_type="video/mp4"),
            max_bytes=len(MP4_BYTES),
        )
    )
    assert asset.mime_type == "video/mp4"
    assert asset.content == MP4_BYTES

    # 超过视频上限时拒绝
    with pytest.raises(AssetFetchError):
        asyncio.run(
            fetch_asset(
                "https://cdn.example.com/a.mp4",
                transport=_transport(content=MP4_BYTES, content_type="video/mp4"),
                max_bytes=4,
            )
        )


def test_fetch_asset_keeps_image_limit_separate() -> None:
    """图片仍按图片上限校验，不因视频上限放宽而失效。"""
    with pytest.raises(AssetFetchError):
        asyncio.run(
            fetch_asset(
                "https://cdn.example.com/a.png",
                transport=_transport(),
                max_bytes=1024,
                image_max_bytes=4,
            )
        )


def test_fetch_image_still_rejects_video() -> None:
    """仅图片入口（fetch_image）拒绝视频，保持既有语义。"""
    with pytest.raises(AssetFetchError):
        asyncio.run(
            fetch_image(
                "https://cdn.example.com/a.mp4",
                transport=_transport(content=MP4_BYTES, content_type="video/mp4"),
            )
        )


def test_fetch_asset_rejects_unknown_content() -> None:
    """既非图片也非视频的内容被拒绝。"""
    with pytest.raises(AssetFetchError):
        asyncio.run(
            fetch_asset(
                "https://cdn.example.com/a.bin",
                transport=_transport(
                    content=b"\x00\x01\x02\x03" * 4,
                    content_type="application/octet-stream",
                ),
            )
        )


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
