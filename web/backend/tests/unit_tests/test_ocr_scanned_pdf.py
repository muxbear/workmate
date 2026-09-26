"""扫描件 PDF：逐页判定、光栅化、补 OCR 与"提取不到文本即失败"（迭代 6 T6.4 批次③）。

要盯住的核心是**一条静默失败路径**：``OpenDataLoaderPDFStrategy`` 对无文本层的 PDF
抛错 → 回退到 ``PyPDFLoader`` → pypdf 对纯图页**不抛错**、逐页返回空字符串 → 被当成
成功。文档最终标记 ``indexed``、``chunks_count = 0``、零报错零提示——用户以为传进去了。

用例里的 PDF 都是**真造**的（PIL 把图片存成 PDF 就是一份货真价实的扫描件；
pypdf + Helvetica 造带文本层的数字页），不提交二进制 fixture。
"""

from __future__ import annotations

import io
import json
from pathlib import Path

import httpx
import pytest
from PIL import Image, ImageDraw
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from api.knowledge_base.doc_state import ParsingState
from core.rag.loaders import (
    FallbackLoaderStrategy,
    OcrAugmentedPdfStrategy,
    PyPDFLoaderStrategy,
)
from core.rag.ocr import (
    LOAD_REPORT_KEY,
    build_load_report,
    doc_has_usable_text,
    format_ocr_warning,
    is_blank_image,
    meaningful_chars,
    page_needs_ocr,
    pdf_page_texts,
    render_page_png,
)
from core.rag.vision import OCR_PROMPT, VisionClient

# ─── 造 PDF ─────────────────────────────────────────────────────────────────


def make_scanned_pdf(path: Path, *, text: str = "SCANNED INVOICE 42") -> Path:
    """造一份**货真价实的扫描件**：整页就是一张图，没有任何文本对象。

    用 PIL 直接把图片存成 PDF 就行——这正是"扫描件"在文件层面的真实形态
    （``pypdf`` 从中抽出的文本是空串，从而复现上面那条静默失败路径）。
    """
    image = Image.new("RGB", (1240, 1754), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle([80, 100, 1160, 260], fill="black")
    draw.text((100, 300), text, fill="black", font_size=64)
    with open(path, "wb") as fh:
        image.save(fh, "PDF", resolution=150)
    return path


def make_blank_pdf(path: Path) -> Path:
    """造一份纯白页 PDF——用来验证"不为白纸付一次模型调用"。"""
    image = Image.new("RGB", (1240, 1754), "white")
    with open(path, "wb") as fh:
        image.save(fh, "PDF", resolution=150)
    return path


def _append_digital_page(writer: PdfWriter, text: str) -> None:
    """给 writer 追加一页带真实文本层的页面（base-14 Helvetica，不需要字体文件）。"""
    page = writer.add_blank_page(width=595, height=842)
    font_ref = writer._add_object(  # noqa: SLF001 - pypdf 没有公开的字体注册入口
        DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }
        )
    )
    page[NameObject("/Resources")] = DictionaryObject(
        {
            NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_ref}),
        }
    )
    stream = DecodedStreamObject()
    stream.set_data(f"BT /F1 18 Tf 60 700 Td ({text}) Tj ET".encode())
    page[NameObject("/Contents")] = writer._add_object(stream)  # noqa: SLF001


def make_digital_pdf(
    path: Path, *, text: str = "Digital page with a text layer"
) -> Path:
    writer = PdfWriter()
    _append_digital_page(writer, text)
    with open(path, "wb") as fh:
        writer.write(fh)
    return path


def make_mixed_pdf(path: Path, *, digital_text: str = "Second page is digital") -> Path:
    """第 1 页是扫描图，第 2 页有文本层。

    混合型是要紧的一档：一份数字 PDF 里夹一张扫描页很常见，整个文档既不能全 OCR
    （会覆盖正确的文本层）也不能不 OCR（会丢掉整整一页）。
    """
    writer = PdfWriter()
    writer.append(str(make_scanned_pdf(path.parent / "_scanned_part.pdf")))
    _append_digital_page(writer, digital_text)
    with open(path, "wb") as fh:
        writer.write(fh)
    return path


# ─── 视觉模型桩 ─────────────────────────────────────────────────────────────


class RecordingTransport(httpx.BaseTransport):
    """按脚本返回 OCR 结果，并记下收到几次调用。"""

    def __init__(self, answers: list[str] | None = None) -> None:
        self.answers = list(answers or [])
        self.calls = 0

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        body = json.loads(request.content.decode("utf-8"))
        assert body["messages"][0]["content"][1]["text"] == OCR_PROMPT
        answer = self.answers.pop(0) if self.answers else f"第 {self.calls} 页识别结果"
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": answer}}]},
        )


def make_ocr(transport: RecordingTransport) -> VisionClient:
    return VisionClient(
        model="qwen-vl-ocr",
        api_base="https://dashscope.aliyuncs.com/compatible-mode/v1",
        api_key="sk-test",
        transport=transport,
    )


def make_strategy(ocr: VisionClient | None, **kwargs) -> OcrAugmentedPdfStrategy:
    return OcrAugmentedPdfStrategy(
        FallbackLoaderStrategy([PyPDFLoaderStrategy()]),
        ocr=ocr,
        **kwargs,
    )


# ─── 判据（纯函数） ─────────────────────────────────────────────────────────


class TestPageHeuristic:
    def test_meaningful_chars_ignores_whitespace_digits_punctuation(self):
        assert meaningful_chars(" 第 3 页 ") == 2  # "第" + "页"
        assert meaningful_chars("1,234.56") == 0
        assert meaningful_chars("") == 0

    def test_keeps_chinese_and_latin(self):
        assert meaningful_chars("Calico 网络插件") == len("Calico网络插件")

    @pytest.mark.parametrize("text", ["", "   ", "12", "3 / 8", "1,234.56", "\n\t"])
    def test_pages_without_words_need_ocr(self, text: str):
        assert page_needs_ocr(text) is True

    @pytest.mark.parametrize(
        "text",
        ["第三章", "Test PDF Document", "a", "第 3 页 / 共 8 页"],
    )
    def test_pages_with_words_do_not_need_ocr(self, text: str):
        """**绝不能用 OCR 覆盖有文本的页**——判据刻意严到"至少得有一个词"。

        放宽到"字符数少就 OCR"，只有章节名或页眉的数字页（"第 3 页 / 共 8 页"里有
        四个汉字）也会被送去识别，用模型的转写盖掉本来正确的文本层。扫描页的真实
        特征是**零**汉字——它是一张图，页里根本没有文本对象。
        """
        assert page_needs_ocr(text) is False

    def test_repo_fixture_pdf_counts_as_digital(self):
        """回归：仓库自带的 sample.pdf 是一页只有 17 个字符的**正常** PDF。

        阈值若照 ``safe_fetch._MIN_TEXT_CHARS = 120`` 定，它会被判成扫描件——
        打翻现有用例，也会把"只有标题页的数字 PDF"误判。
        """
        assert page_needs_ocr("Test PDF Document") is False

    def test_numeric_only_content_still_counts_as_usable(self):
        """纯数字的 CSV/表格是正常内容，不能被判成空文档而拒绝入库。"""
        assert doc_has_usable_text(["1,234.56", "7,890.12"]) is True

    def test_all_empty_pages_have_no_usable_text(self):
        assert doc_has_usable_text(["", "   ", "\n"]) is False
        assert doc_has_usable_text([""]) is False


class TestLoadReport:
    def test_full_success_says_nothing(self):
        """全部识别成功是常态，不吭声——为它挂个提示只会让人习惯性忽略这一栏。"""
        assert format_ocr_warning(build_load_report(ocr_pages=5)) is None
        assert format_ocr_warning(build_load_report()) is None

    def test_partial_success_is_reported_with_counts(self):
        warning = format_ocr_warning(
            build_load_report(ocr_pages=200, ocr_skipped_budget=300, total_pages=500),
        )
        assert warning is not None
        assert "200" in warning and "300" in warning and "500" in warning

    def test_failures_are_reported(self):
        warning = format_ocr_warning(build_load_report(ocr_pages=2, ocr_failed=3))
        assert warning is not None and "3" in warning


# ─── 真实 PDF 上的光栅化 ────────────────────────────────────────────────────


class TestPdfInspection:
    def test_scanned_pdf_has_no_text_layer(self, tmp_path: Path):
        """扫描件的真实特征是"零文本"，这正是判据要抓的东西。"""
        texts = pdf_page_texts(str(make_scanned_pdf(tmp_path / "扫描件.pdf")))
        assert len(texts) == 1
        assert page_needs_ocr(texts[0]) is True

    def test_digital_pdf_has_text_layer(self, tmp_path: Path):
        texts = pdf_page_texts(str(make_digital_pdf(tmp_path / "数字.pdf")))
        assert page_needs_ocr(texts[0]) is False

    def test_renders_scanned_page_to_png(self, tmp_path: Path):
        data = render_page_png(str(make_scanned_pdf(tmp_path / "扫描件.pdf")), 0)
        assert data is not None
        with Image.open(io.BytesIO(data)) as image:
            assert max(image.size) > 1000  # scale=2 → 约 144 DPI

    def test_blank_page_is_skipped(self, tmp_path: Path):
        """不为一张白纸付一次模型调用。"""
        assert render_page_png(str(make_blank_pdf(tmp_path / "白页.pdf")), 0) is None

    def test_out_of_range_page_returns_none(self, tmp_path: Path):
        assert render_page_png(str(make_digital_pdf(tmp_path / "数字.pdf")), 99) is None

    def test_unreadable_file_raises_readable_error(self, tmp_path: Path):
        bogus = tmp_path / "坏.pdf"
        bogus.write_bytes(b"not a pdf at all")
        with pytest.raises(RuntimeError, match="PDF 无法打开"):
            pdf_page_texts(str(bogus))

    def test_blank_detection_distinguishes_real_content(self):
        """空白判据的两端都要对：真空白要跳过，有内容的不能误跳。

        误判成空白是有代价的——那一页会被静默跳过，用户只会发现"这页检索不到"，
        而日志里连一条"渲染失败"都没有。
        """
        assert is_blank_image(Image.new("RGB", (64, 64), "white")) is True
        assert is_blank_image(Image.new("RGB", (64, 64), (255, 255, 255))) is True

        textured = Image.new("RGB", (64, 64), "white")
        ImageDraw.Draw(textured).rectangle([4, 4, 60, 30], fill="black")
        assert is_blank_image(textured) is False


# ─── 补 OCR 的策略 ──────────────────────────────────────────────────────────


class TestOcrAugmentedPdf:
    def test_without_ocr_passes_base_result_through(self, tmp_path: Path):
        """没有视觉模型时本策略不做任何判定——"提取不到文本怎么办"是调用方的决定。"""
        target = make_scanned_pdf(tmp_path / "扫描件.pdf")
        docs = make_strategy(None).load(str(target))
        assert [d.page_content.strip() for d in docs] == [""]

    def test_scanned_pages_are_ocrd(self, tmp_path: Path):
        target = make_scanned_pdf(tmp_path / "扫描件.pdf")
        transport = RecordingTransport(["发票号 42"])
        docs = make_strategy(make_ocr(transport)).load(str(target))

        assert transport.calls == 1
        assert len(docs) == 1
        assert docs[0].page_content == "发票号 42"
        assert docs[0].metadata["page"] == 1  # 1 基，与 opendataloader 口径一致
        assert docs[0].metadata["ocr"] is True

    def test_digital_pdf_makes_zero_ocr_calls(self, tmp_path: Path):
        """**关键回归**：走这条路径的数字 PDF 不应产生任何模型调用。

        判据一旦放宽，每一次数字 PDF 解析都会白烧一遍模型费用，还会用模型的转写
        盖掉本来正确的文本层。
        """
        target = make_digital_pdf(tmp_path / "数字.pdf")
        transport = RecordingTransport()
        docs = make_strategy(make_ocr(transport)).load(str(target))

        assert transport.calls == 0
        assert "text layer" in docs[0].page_content

    def test_mixed_pdf_ocs_only_the_scanned_page_and_keeps_order(self, tmp_path: Path):
        """混合型：只 OCR 扫描页，且按页号排序——顺序错了整篇的阅读顺序就乱了。

        分片的 chunk_index 与前后关系按最终列表位置编号，把 OCR 页追加到末尾会让
        第 1 页的内容排到第 2 页后面。
        """
        target = make_mixed_pdf(tmp_path / "混合.pdf")
        transport = RecordingTransport(["第一页的扫描内容"])
        docs = make_strategy(make_ocr(transport)).load(str(target))

        assert transport.calls == 1
        assert [d.metadata["page"] for d in docs] == [1, 2]
        assert docs[0].page_content == "第一页的扫描内容"
        assert "digital" in docs[1].page_content

    def test_page_cap_skips_the_rest_and_reports_it(self, tmp_path: Path):
        """超上限时**跳过而不是静默丢弃**——跳过的页数要能被用户看见。"""
        target = make_mixed_pdf(tmp_path / "混合.pdf")
        transport = RecordingTransport()
        docs = make_strategy(make_ocr(transport), max_pages=0).load(str(target))

        assert transport.calls == 0
        assert docs[0].metadata[LOAD_REPORT_KEY]["ocr_skipped_budget"] == 1

    def test_time_budget_stops_the_loop_and_reports_it(self, tmp_path: Path):
        """预算必须是页循环里的真约束。

        只靠外层阶段超时兜底的话，一份几百页的扫描件会**干完所有活之后**才被掐断、
        文档以超时失败，那份模型费用也白花了。
        """
        target = make_mixed_pdf(tmp_path / "混合.pdf")
        transport = RecordingTransport()
        docs = make_strategy(make_ocr(transport), budget_seconds=0).load(str(target))

        assert transport.calls == 0
        report = docs[0].metadata[LOAD_REPORT_KEY]
        assert report["ocr_skipped_budget"] == 1
        assert report["ocr_pages"] == 0

    def test_failed_page_is_counted_and_document_survives(self, tmp_path: Path):
        """单页识别失败不该炸掉整篇——计数后继续，由调用方决定怎么呈现。"""
        target = make_mixed_pdf(tmp_path / "混合.pdf")

        class Failing(RecordingTransport):
            def handle_request(self, request: httpx.Request) -> httpx.Response:
                self.calls += 1
                return httpx.Response(500, json={"error": "boom"})

        docs = make_strategy(make_ocr(Failing())).load(str(target))
        report = docs[0].metadata[LOAD_REPORT_KEY]
        assert report["ocr_failed"] == 1
        assert report["ocr_pages"] == 0
        # 数字页仍要在结果里，不能因为扫描页失败就整篇丢失
        assert any("digital" in d.page_content for d in docs)

    def test_report_is_attached_for_the_pipeline_to_collect(self, tmp_path: Path):
        target = make_scanned_pdf(tmp_path / "扫描件.pdf")
        docs = make_strategy(make_ocr(RecordingTransport(["文字"]))).load(str(target))
        assert LOAD_REPORT_KEY in docs[0].metadata
        assert docs[0].metadata[LOAD_REPORT_KEY]["total_pages"] == 1


# ─── 解析阶段的守卫 ─────────────────────────────────────────────────────────


class FakePipeline:
    """只需 loader_registry 的桩（ParsingState 只用它）。"""

    def __init__(self, loader_registry) -> None:
        self.loader_registry = loader_registry


class RecordingRegistry:
    def __init__(self, docs) -> None:
        self._docs = docs

    def load(self, file_path, file_type):
        return self._docs


class _Doc:
    def __init__(self, content: str, metadata: dict | None = None) -> None:
        self.page_content = content
        self.metadata = metadata or {}


def _make_ctx(config: dict):
    from api.knowledge_base.doc_state import IndexingContext

    return IndexingContext(
        doc_id="doc-1",
        kb_id="kb-1",
        file_path="/tmp/a.pdf",
        file_type="pdf",
        config=config,
    )


async def _run_parsing(ctx, docs) -> None:
    from core.rag.loaders import DocumentLoaderRegistry

    pipeline = FakePipeline(RecordingRegistry(docs))  # type: ignore[arg-type]
    await ParsingState().handle(ctx, pipeline)  # type: ignore[arg-type]


@pytest.mark.anyio
class TestParsingGuard:
    async def test_textless_document_fails_with_actionable_message(self):
        """**这是本轮最要紧的一条**：扫描件不能再"假成功"。

        此前文档会以 indexed、chunks_count=0、零提示入库，用户以为传进去了，
        实际一条都检索不到，而且从那个状态没有任何自助修复的路径。
        """
        ctx = _make_ctx({})
        await _run_parsing(ctx, [_Doc(""), _Doc("   ")])

        assert ctx.status == "failed"
        assert ctx.error_message is not None
        assert "OCR" in ctx.error_message

    async def test_message_does_not_tell_you_to_enable_ocr_when_it_is_on(self):
        """已经开了 OCR 却被告知"去开 OCR"是最糟的提示——信息按开关分岔。"""
        ctx = _make_ctx({"enable_ocr": True})
        await _run_parsing(ctx, [_Doc("")])

        assert ctx.status == "failed"
        assert ctx.error_message is not None
        assert "vision" in ctx.error_message

    async def test_document_with_text_proceeds(self):
        ctx = _make_ctx({})
        await _run_parsing(ctx, [_Doc("正文内容")])
        assert ctx.status == "chunking"

    async def test_numeric_only_document_is_not_rejected(self):
        """纯数字的表格是正常内容——守卫不能用"有效字符"的口径。"""
        ctx = _make_ctx({})
        await _run_parsing(ctx, [_Doc("1,234.56"), _Doc("7,890.12")])
        assert ctx.status == "chunking"

    async def test_very_short_document_is_not_rejected(self):
        """回归：阈值只要往上抬一点点（比如 4）就会拒掉只有两个字正文的文件。

        误拒一份真实文档比漏放一篇垃圾严重得多，所以判据是"一个非空白字符都没有"。
        实现途中正是把阈值定成了 4，打翻了既有用例里 ``[_document("正文")]`` 这档
        最短输入。
        """
        ctx = _make_ctx({})
        await _run_parsing(ctx, [_Doc("正文")])
        assert ctx.status == "chunking"

    async def test_load_report_becomes_parse_warning_and_is_popped(self):
        """计数要转成可展示的告警，并且**必须从 metadata 里取走**。

        留着它会让后面读 metadata 的人（切片、向量库写入）碰到一个不属于内容的键。
        """
        doc = _Doc(
            "已识别的正文",
            {
                LOAD_REPORT_KEY: build_load_report(
                    ocr_pages=1,
                    ocr_skipped_budget=2,
                    total_pages=3,
                )
            },
        )
        ctx = _make_ctx({"enable_ocr": True})
        await _run_parsing(ctx, [doc])

        assert ctx.parse_warning is not None
        assert "2" in ctx.parse_warning
        assert LOAD_REPORT_KEY not in doc.metadata

    async def test_no_report_means_no_warning(self):
        ctx = _make_ctx({})
        await _run_parsing(ctx, [_Doc("正文内容")])
        assert ctx.parse_warning is None
