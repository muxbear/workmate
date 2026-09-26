"""多模态解析：DOCX / PPTX 的表格与图片（迭代 6 T6.4）。

此前 Word 走 ``Docx2txtLoader``、PowerPoint 只处理 ``has_text_frame`` 的形状——
**两者的表格都被静默丢掉**：用户传一份带对照表的方案，入库后那张表根本不在了，
界面上也没有任何提示。这类"少了一部分内容却看不出来"的问题最难被发现，
所以这里用**真造的文件**跑一遍，逐条断言表格进了正文。

（图片说明需要视觉模型，见 T6.4 的后续批次；本文件只锁"图片不被静默丢弃"。）
"""

import io
from pathlib import Path

from core.rag.loaders import (
    DocxLoaderStrategy,
    PythonPPTXLoaderStrategy,
    table_to_markdown,
)


def make_png_bytes() -> bytes:
    """造一张 1x1 的 PNG（用于让文档里真的有一张图）。"""
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (2, 2), (200, 30, 30)).save(buffer, format="PNG")
    return buffer.getvalue()


def make_docx(path: Path, *, with_image: bool = False) -> None:
    from docx import Document as DocxDocument

    doc = DocxDocument()
    doc.add_paragraph("这是表格前的说明。")
    table = doc.add_table(rows=3, cols=3)
    for col, header in enumerate(("参数", "默认值", "说明")):
        table.rows[0].cells[col].text = header
    table.rows[1].cells[0].text = "timeout"
    table.rows[1].cells[1].text = "30s"
    table.rows[1].cells[2].text = "含 a | b 的说明"     # 故意带竖线
    table.rows[2].cells[0].text = "retries"
    table.rows[2].cells[1].text = "3"
    table.rows[2].cells[2].text = "次数"
    doc.add_paragraph("这是表格后的结论。")
    if with_image:
        doc.add_picture(io.BytesIO(make_png_bytes()))
    doc.save(str(path))


def make_pptx(path: Path) -> None:
    from pptx import Presentation
    from pptx.util import Inches

    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[5])   # 标题+内容
    slide.shapes.title.text = "对比"
    box = slide.shapes.add_textbox(Inches(1), Inches(2), Inches(4), Inches(1))
    box.text_frame.text = "正文一句"
    table_shape = slide.shapes.add_table(
        2, 2, Inches(1), Inches(3), Inches(4), Inches(1),
    )
    table = table_shape.table
    table.cell(0, 0).text = "方案"
    table.cell(0, 1).text = "耗时"
    table.cell(1, 0).text = "A"
    table.cell(1, 1).text = "12ms"
    slide.shapes.add_picture(
        io.BytesIO(make_png_bytes()), Inches(6), Inches(1), Inches(1), Inches(1),
    )
    prs.save(str(path))


class TestDocx:
    def test_tables_are_rendered_as_markdown(self, tmp_path: Path):
        target = tmp_path / "方案.docx"
        make_docx(target)

        docs = DocxLoaderStrategy().load(str(target))

        text = docs[0].page_content
        assert "这是表格前的说明。" in text
        assert "这是表格后的结论。" in text
        # 表格以 Markdown 形式保留，且表头与数据行都在
        assert "| 参数 | 默认值 | 说明 |" in text
        assert "| --- | --- | --- |" in text
        assert "| timeout | 30s |" in text
        assert "| retries | 3 | 次数 |" in text

    def test_text_and_table_keep_document_order(self, tmp_path: Path):
        """顺序很重要：表格被挪到文末会让上下文错位（切片后尤其明显）。"""
        target = tmp_path / "顺序.docx"
        make_docx(target)

        text = DocxLoaderStrategy().load(str(target))[0].page_content

        assert text.index("表格前的说明") < text.index("| 参数 |") < text.index("表格后的结论")

    def test_pipe_in_cell_does_not_break_the_table(self, tmp_path: Path):
        target = tmp_path / "竖线.docx"
        make_docx(target)

        rows = DocxLoaderStrategy().load(str(target))[0].page_content.splitlines()

        data_row = next(r for r in rows if "timeout" in r)
        # 内容里的竖线被转义成字面量，**结构分隔符**仍是 4 个 → 3 列
        # （不转义的话这一行会被切成 4 列，整张表在 Markdown 里就错位了）
        assert "\\|" in data_row
        assert data_row.replace("\\|", "").count("|") == 4

    def test_images_are_counted_not_silently_dropped(self, tmp_path: Path):
        target = tmp_path / "带图.docx"
        make_docx(target, with_image=True)

        doc = DocxLoaderStrategy().load(str(target))[0]

        assert doc.metadata["images"] == 1
        assert "含 1 张图片" in doc.page_content

    def test_plain_docx_has_no_image_note(self, tmp_path: Path):
        target = tmp_path / "纯文字.docx"
        make_docx(target)

        doc = DocxLoaderStrategy().load(str(target))[0]

        assert doc.metadata["images"] == 0
        assert "图片" not in doc.page_content


class TestPptx:
    def test_slide_tables_are_rendered(self, tmp_path: Path):
        target = tmp_path / "对比.pptx"
        make_pptx(target)

        docs = PythonPPTXLoaderStrategy().load(str(target))

        text = docs[0].page_content
        assert "正文一句" in text
        assert "| 方案 | 耗时 |" in text
        assert "| A | 12ms |" in text

    def test_slide_images_are_counted(self, tmp_path: Path):
        target = tmp_path / "图.pptx"
        make_pptx(target)

        doc = PythonPPTXLoaderStrategy().load(str(target))[0]

        assert doc.metadata["images"] == 1
        assert "含 1 张图片" in doc.page_content


class TestTableHelper:
    def test_ragged_rows_are_padded(self):
        class _Cell:
            def __init__(self, text: str) -> None:
                self.text = text

        class _Row:
            def __init__(self, *texts: str) -> None:
                self.cells = [_Cell(t) for t in texts]

        class _Table:
            rows = [_Row("a", "b", "c"), _Row("d")]

        rendered = table_to_markdown(_Table())

        assert rendered.splitlines()[0] == "| a | b | c |"
        assert rendered.splitlines()[2] == "| d |  |  |"

    def test_empty_table_renders_empty(self):
        class _Table:
            rows: list = []

        assert table_to_markdown(_Table()) == ""
