"""多模态解析：视觉模型客户端与图片加载（迭代 6 T6.4）。

此前图片一律走本机 Tesseract，未安装即必然失败，而 ``png``/``jpg``/``jpeg`` 都在上传
白名单里——也就是"上传必然报错，且报错指向一个界面上解决不了的系统依赖"。
这里锁住替代路径（视觉模型 OCR）的关键契约：

- 请求体是 OpenAI 兼容的 ``image_url`` + base64 data URL（错了服务端就收不到图）；
- 拼进去的是**原图字节**（base64 往返必须无损，否则识别结果不可信）；
- 失败一律降级成 ``None``，绝不抛穿到调用方（一次 OCR 失败不该炸掉整篇文档）；
- 模型回「无文字」时归一成 ``None``，否则这四个字会被写进正文并参与检索。
"""

from __future__ import annotations

import base64
import io
import json
from pathlib import Path

import httpx
import pytest
from PIL import Image

from core.rag.loaders import ImageLoaderStrategy
from core.rag.vision import MAX_IMAGE_EDGE, OCR_PROMPT, VisionClient


def make_png_bytes(color: tuple[int, int, int] = (10, 40, 200)) -> bytes:
    """生成一张真实的 PNG。"""
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), color).save(buffer, format="PNG")
    return buffer.getvalue()


def _reply(text: str, status: int = 200) -> httpx.Response:
    """构造一个 OpenAI 兼容的 chat/completions 响应。"""
    return httpx.Response(
        status,
        json={
            "choices": [{"message": {"role": "assistant", "content": text}}],
            "model": "qwen-vl-ocr",
        },
    )


class RecordingTransport(httpx.BaseTransport):
    """记录请求体，并按脚本返回响应。"""

    def __init__(self, response: httpx.Response | list[httpx.Response]) -> None:
        self._response = response
        self.requests: list[dict] = []

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(json.loads(request.content.decode("utf-8")))
        if isinstance(self._response, list):
            return self._response.pop(0)
        return self._response


def make_client(transport: httpx.BaseTransport) -> VisionClient:
    return VisionClient(
        model="qwen-vl-ocr",
        api_base="https://dashscope.aliyuncs.com/compatible-mode/v1",
        api_key="sk-test",
        transport=transport,
    )


class TestRequestShape:
    def test_image_is_sent_as_base64_data_url(self):
        """图片必须以 data URL 内联——服务端取不到图就等于什么都没做。"""
        transport = RecordingTransport(_reply("识别到的文字"))
        image = make_png_bytes()

        result = make_client(transport).describe(OCR_PROMPT, image)

        assert result == "识别到的文字"
        content = transport.requests[0]["messages"][0]["content"]
        image_block = next(b for b in content if b["type"] == "image_url")
        url = image_block["image_url"]["url"]
        assert url.startswith("data:image/png;base64,")
        # base64 往返必须与原始字节一致
        assert base64.b64decode(url.split(",", 1)[1]) == image

    def test_prompt_is_sent_as_text_block_after_the_image(self):
        transport = RecordingTransport(_reply("文字"))
        make_client(transport).describe(OCR_PROMPT, make_png_bytes())

        content = transport.requests[0]["messages"][0]["content"]
        assert [b["type"] for b in content] == ["image_url", "text"]
        assert content[1]["text"] == OCR_PROMPT

    def test_model_name_reaches_the_request(self):
        transport = RecordingTransport(_reply("文字"))
        make_client(transport).describe(OCR_PROMPT, make_png_bytes())

        assert transport.requests[0]["model"] == "qwen-vl-ocr"

    def test_mime_is_sniffed_when_not_given(self):
        """JPEG 也要按真实类型标注，不能一律当 PNG。"""
        transport = RecordingTransport(_reply("文字"))
        buffer = io.BytesIO()
        Image.new("RGB", (8, 8), (1, 2, 3)).save(buffer, format="JPEG")

        make_client(transport).describe(OCR_PROMPT, buffer.getvalue())

        url = transport.requests[0]["messages"][0]["content"][0]["image_url"]["url"]
        assert url.startswith("data:image/jpeg;base64,")


class TestSession:
    def test_session_reuses_one_client_across_calls(self):
        """整篇文档共用一个连接池——一份几百页的扫描件不该建几百次客户端。"""
        transport = RecordingTransport([_reply("第一页"), _reply("第二页")])
        client = make_client(transport)

        with client.session() as http:
            first = client.describe(OCR_PROMPT, make_png_bytes(), client=http)
            second = client.describe(OCR_PROMPT, make_png_bytes(), client=http)

        assert (first, second) == ("第一页", "第二页")
        assert len(transport.requests) == 2

    def test_usable_without_a_session(self):
        transport = RecordingTransport(_reply("文字"))
        assert make_client(transport).describe(OCR_PROMPT, make_png_bytes()) == "文字"

    def test_concurrent_sessions_do_not_clobber_each_other(self):
        """并发解析时两个 session 必须各用各的连接池。

        索引流水线最多并发解析 3 篇文档，而 VisionClient 实例是共享的。早期实现把
        连接池写在 ``self`` 上：线程 B 的 ``session()`` 覆盖线程 A 正在用的客户端，
        B 退出时关掉它，A 之后每次调用都抛错——再被降级路径吞成「这页没有文字」，
        表现为**并发下随机丢页、零报错**。这里显式复现那个交错顺序。
        """
        client = make_client(RecordingTransport(_reply("文字")))

        with client.session() as http_a:
            with client.session():
                pass
            # B 的 with 已退出（在旧实现里它会关掉 A 正在用的客户端）
            assert not http_a.is_closed
            assert (
                client.describe(OCR_PROMPT, make_png_bytes(), client=http_a) == "文字"
            )


class TestImagePrep:
    def test_oversized_image_is_downscaled_before_sending(self):
        """超大图必须先缩小。

        上传白名单允许单文件 100MB，原样 base64 会得到一个注定被服务端拒掉的请求，
        而拒绝会被报成「图中未提取到文字」——把一个"图太大"诊断成"图太糊"，
        用户按提示换张更清楚的图也没用。
        """
        transport = RecordingTransport(_reply("文字"))
        buffer = io.BytesIO()
        # 比 MAX_IMAGE_EDGE 大一倍的真实 PNG
        Image.new("RGB", (MAX_IMAGE_EDGE * 2, MAX_IMAGE_EDGE), (200, 200, 200)).save(
            buffer,
            format="PNG",
        )

        make_client(transport).describe(OCR_PROMPT, buffer.getvalue())

        url = transport.requests[0]["messages"][0]["content"][0]["image_url"]["url"]
        sent = base64.b64decode(url.split(",", 1)[1])
        with Image.open(io.BytesIO(sent)) as sent_img:
            assert max(sent_img.size) == MAX_IMAGE_EDGE
            # 等比缩放：宽高比保持不变
            assert sent_img.size[1] / sent_img.size[0] == pytest.approx(0.5, abs=0.01)

    def test_within_limit_image_is_sent_untouched(self):
        """限内的图不能重编码——OCR 吃清晰度，重编码只会掉笔画。"""
        transport = RecordingTransport(_reply("文字"))
        image = make_png_bytes()

        make_client(transport).describe(OCR_PROMPT, image)

        url = transport.requests[0]["messages"][0]["content"][0]["image_url"]["url"]
        assert base64.b64decode(url.split(",", 1)[1]) == image

    def test_image_over_hard_limit_is_abandoned_without_a_request(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ):
        """缩完仍超硬上限时直接放弃，不发一个注定被拒的请求。

        （上限用 monkeypatch 改小，免得在用例里造一张 10MB 的真图。）
        """
        monkeypatch.setattr("core.rag.vision.MAX_IMAGE_BYTES", 8)
        transport = RecordingTransport(_reply("文字"))

        assert make_client(transport).describe(OCR_PROMPT, make_png_bytes()) is None
        assert transport.requests == []


class TestFailureContract:
    """任何失败都要降级成 None——OCR 失败该是"这页没提取到"，不是整篇解析崩掉。"""

    def test_http_error_returns_none(self):
        transport = RecordingTransport(_reply("boom", status=500))
        assert make_client(transport).describe(OCR_PROMPT, make_png_bytes()) is None

    def test_malformed_body_returns_none(self):
        transport = RecordingTransport(httpx.Response(200, json={"unexpected": True}))
        assert make_client(transport).describe(OCR_PROMPT, make_png_bytes()) is None

    def test_transport_exception_returns_none(self):
        class ExplodingTransport(httpx.BaseTransport):
            def handle_request(self, request: httpx.Request) -> httpx.Response:
                raise httpx.ConnectError("connection refused")

        assert (
            make_client(ExplodingTransport()).describe(
                OCR_PROMPT,
                make_png_bytes(),
            )
            is None
        )

    @pytest.mark.parametrize("answer", ["", "   ", "无文字", "无文字。", "N/A"])
    def test_no_content_answers_are_normalised_to_none(self, answer: str):
        """模型答「无文字」时必须是 None。

        原样返回的话，这四个字会被写进正文、切成片、被检索到——用户搜到一段
        写着"无文字"的内容。
        """
        transport = RecordingTransport(_reply(answer))
        assert make_client(transport).describe(OCR_PROMPT, make_png_bytes()) is None


class TestImageLoaderStrategy:
    def test_uses_vision_model_when_available(self, tmp_path: Path):
        target = tmp_path / "截图.png"
        target.write_bytes(make_png_bytes())
        transport = RecordingTransport(_reply("登录页 用户名 密码"))

        docs = ImageLoaderStrategy(make_client(transport)).load(str(target))

        assert len(docs) == 1
        assert docs[0].page_content == "登录页 用户名 密码"
        assert docs[0].metadata["source"] == str(target)

    def test_without_vision_model_fails_with_actionable_message(self, tmp_path: Path):
        target = tmp_path / "截图.png"
        target.write_bytes(make_png_bytes())

        with pytest.raises(RuntimeError, match="vision"):
            ImageLoaderStrategy().load(str(target))

    def test_unreadable_image_fails_instead_of_indexing_empty(self, tmp_path: Path):
        """图里没字时要失败。

        返回空 Document 会让文档以「indexed、0 切片」的假成功入库——
        用户看到一篇"索引成功"的文档，实际一条都检索不到。
        """
        target = tmp_path / "空白.png"
        target.write_bytes(make_png_bytes())
        transport = RecordingTransport(_reply("无文字"))

        with pytest.raises(RuntimeError):
            ImageLoaderStrategy(make_client(transport)).load(str(target))
