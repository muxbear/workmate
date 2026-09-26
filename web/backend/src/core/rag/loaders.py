"""文档加载器——策略模式 + 组合模式。

每种文档类型对应一个策略类，FallbackLoaderStrategy 组合多个策略形成优先级链。
"""

import logging
import os
import re
import time
from abc import ABC, abstractmethod
from typing import Any, cast

from langchain_core.documents import Document

from core.rag.ocr import (
    DEFAULT_OCR_BUDGET_SECONDS,
    LOAD_REPORT_KEY,
    MAX_OCR_PAGES_PER_DOC,
    build_load_report,
    merge_load_reports,
    page_needs_ocr,
    pdf_page_texts,
    render_page_png,
)
from core.rag.vision import OCR_PROMPT, ImageCaptioner, VisionClient

logger = logging.getLogger(__name__)


def _clean_cell(text: str) -> str:
    """单元格文本归一：换行折成空格、竖线转义。

    竖线必须转义——否则单元格里的 ``|`` 会把 Markdown 表格的列切错，整张表读起来
    就乱了（而表格正是最需要保留结构的内容）。
    """
    return " ".join((text or "").split()).replace("|", "\\|")


def table_to_markdown(table: Any) -> str:
    """把 Word/PowerPoint 的表格渲染成 Markdown 表格。

    **为什么值得保留**：需求/接口文档里最要紧的往往就是那张对照表（"参数 → 默认值 →
    说明"）。纯文本抽取会把它压成一串没有标签的词，切片后既不可检索也不可读；
    Markdown 表格既让模型看得懂，也让人能读。

    python-docx 与 python-pptx 的 ``table.rows[].cells[].text`` 接口一致，因此
    Word 与 PowerPoint 共用这一份实现。
    """
    rows: list[list[str]] = [
        [_clean_cell(cell.text) for cell in row.cells] for row in table.rows
    ]
    rows = [r for r in rows if any(c for c in r)]
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    header = "| " + " | ".join(rows[0]) + " |"
    separator = "| " + " | ".join(["---"] * width) + " |"
    body = ["| " + " | ".join(r) + " |" for r in rows[1:]]
    return "\n".join([header, separator, *body])


class DocumentLoaderStrategy(ABC):
    """文档加载策略抽象接口。"""

    @abstractmethod
    def load(self, file_path: str) -> list[Document]:
        """加载文档并返回 LangChain Document 列表。"""
        ...


#: 导出的插图落在文档自己的存储目录下的这个子目录里。选这个位置有三个理由：
#: 与文档同生共死（删除文档时 ``delete_document`` 会 rmtree 掉整个文档目录）、
#: 天然按文档隔离、且是**绝对路径**。
EXTRACTED_IMAGE_DIRNAME = "images"

#: 导出图片的目录名会原样出现在 markdown 的图片引用里（形如
#: ``![](<images/imageFile1.png>)``），因此按它定位引用。
_IMAGE_REF_PATTERN = re.compile(r"!\[[^\]]*\]\(<?([^)>]+)>?\)")


class OpenDataLoaderPDFStrategy(DocumentLoaderStrategy):
    """PDF 加载——langchain-opendataloader-pdf（优先策略）。

    插图（``image_output="external"``）导出到**文档自己目录下的绝对路径**，并交给
    视觉模型生成说明。

    **图片目录必须是绝对的、按文档隔离的**：此前写的是 ``image_dir="./images"``，
    而 ``--image-dir`` 会被原样交给 Java 子进程、相对路径按进程工作目录解析——于是
    所有文档、所有知识库共用同一个 ``<进程CWD>/images``，而导出文件名是顺序计数
    （``imageFile1.png``、``imageFile2.png``…），并发的两份文档会互相覆盖对方的插图，
    最后一份索引到的说明配的是别人的图。
    """

    def __init__(self, captioner: ImageCaptioner | None = None) -> None:
        self._captioner = captioner

    def load(self, file_path: str) -> list[Document]:
        if not os.path.isfile(file_path):
            raise FileNotFoundError(f"PDF 文件未找到: {file_path}")
        from langchain_opendataloader_pdf import OpenDataLoaderPDFLoader

        image_dir = os.path.join(
            os.path.dirname(os.path.abspath(file_path)), EXTRACTED_IMAGE_DIRNAME,
        )
        docs = OpenDataLoaderPDFLoader(
                    file_path=str(file_path),
                    format="markdown",
                    table_method="cluster",
                    include_header_footer=True,
                    image_output="external",
                    image_dir=image_dir,
                    image_format="png"
                ).load()
        if not docs:
            raise RuntimeError(
                f"OpenDataLoaderPDFLoader 加载文件 {file_path} 返回空的 Documents。"
            )
        if self._captioner is not None:
            self._caption_docs(docs, image_dir)
        return docs

    def _caption_docs(self, docs: list[Document], image_dir: str) -> None:
        """就地把正文里的图片引用替换成说明文字。

        引用本身标出了图片在正文中的**位置**（``![](<images/imageFile1.png>)``），
        所以就地替换天然保序——比"按文件名猜它属于哪一页"可靠得多。
        """
        image_total = 0
        for doc in docs:
            image_total += len(_IMAGE_REF_PATTERN.findall(doc.page_content))
            doc.page_content = _IMAGE_REF_PATTERN.sub(
                lambda m: self._caption_ref(m.group(1), image_dir) or m.group(0),
                doc.page_content,
            )
        if docs:
            docs[0].metadata[LOAD_REPORT_KEY] = build_load_report(
                images=image_total,
                images_captioned=self._captioner.captioned if self._captioner else 0,
                images_failed=self._captioner.failed if self._captioner else 0,
                images_skipped=self._captioner.skipped if self._captioner else 0,
            )

    def _caption_ref(self, ref: str, image_dir: str) -> str | None:
        """给一条图片引用生成说明文字；读不到文件或识别失败返回 ``None``。"""
        # 引用形如 "<导出目录名>/imageFile1.png"，取基名在本目录下定位
        path = os.path.join(image_dir, os.path.basename(ref.strip()))
        try:
            with open(path, "rb") as fh:
                data = fh.read()
        except OSError:
            logger.debug("导出的插图读不到，跳过说明: %s", path, exc_info=True)
            return None
        if self._captioner is None:
            return None
        caption = self._captioner.caption(data)
        # 拿不到说明时保留原引用（它至少标出了"这里有张图"），而不是抹成空白
        return f"（图：{caption}）" if caption else None


class PyPDFLoaderStrategy(DocumentLoaderStrategy):
    """PDF 加载——langchain_community PyPDFLoader（备选策略）。"""

    def load(self, file_path: str) -> list[Document]:
        from langchain_community.document_loaders import PyPDFLoader
        docs = PyPDFLoader(file_path).load()
        # 页码基准归一：pypdf 的 ``page`` 是 0 基的（首页 = 0），而
        # ``OpenDataLoaderPDFLoader`` 是 1 基的。本机装了 Java，opendataloader 才是
        # 实际生效的那条路，所以 1 基是事实约定——这里对齐它，否则同一批重建里
        # 走了兜底路径的文档页码会整体差 1，而"第 0 页"对用户也不是页码。
        for doc in docs:
            page = doc.metadata.get("page")
            if isinstance(page, int):
                doc.metadata["page"] = page + 1
        return docs


def _docx_images(item: Any, document: Any) -> list[tuple[bytes, str]]:
    """取一个正文元素（段落或表格）里嵌的图片字节与 MIME，按出现顺序。

    图片挂在**持有它的那个段落**上（``a:blip`` 的 ``r:embed`` 指向文档部件的关系表），
    而 ``iter_inner_content`` 是按正文顺序吐元素的——所以"就地插入说明"天然保序，
    不需要另找坐标。表格里若也放了图，同样能从表格元素上取到。
    """
    from docx.oxml.ns import qn

    element = getattr(item, "_element", None)
    if element is None:
        return []
    images: list[tuple[bytes, str]] = []
    for blip in element.findall(".//" + qn("a:blip")):
        rid = blip.get(qn("r:embed"))
        part = document.part.related_parts.get(rid) if rid else None
        if part is not None:
            images.append((part.blob, part.content_type))
    return images


def _pptx_images(slide: Any) -> list[tuple[bytes, str]]:
    """取一页幻灯片里的图片字节与 MIME，按形状顺序。"""
    from pptx.enum.shapes import MSO_SHAPE_TYPE

    images: list[tuple[bytes, str]] = []
    for shape in slide.shapes:
        if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
            image = shape.image
            images.append((image.blob, image.content_type))
    return images


def _caption_all(
    captioner: ImageCaptioner | None, images: list[tuple[bytes, str]],
) -> list[str]:
    """给一组图逐张生成说明，返回成功的那些（顺序与入参一致）。"""
    if captioner is None:
        return []
    captions: list[str] = []
    for blob, mime in images:
        caption = captioner.caption(blob, mime)
        if caption:
            captions.append(caption)
    return captions


def _ocr_pdf_page(ocr: VisionClient, file_path: str, index: int) -> str | None:
    """渲染并识别一页；空白页、渲染失败与识别失败都返回 ``None``。

    网络调用发生在 :func:`~core.rag.ocr.render_page_png` 的锁**之外**——那把锁只保护
    pdfium，不该把并发 OCR 串成一路。
    """
    image = render_page_png(file_path, index)
    if image is None:
        return None
    return ocr.describe(OCR_PROMPT, image)


class OcrAugmentedPdfStrategy(DocumentLoaderStrategy):
    """PDF 加载——文本层为主，**没有文本层的页**补 OCR（迭代 6 T6.4 批次③）。

    包住既有的 PDF 策略链：先照原样拿正常页，再对扫描页逐页光栅化 + OCR，按页号合并。

    两条硬约束：

    1. **只补空页，绝不覆盖有文本的页**——判据见 ``core.rag.ocr.page_needs_ocr``。
       一份数字 PDF 走这条路径时不应产生任何模型调用。
    2. **合并后必须按页号排序**。分片的 ``chunk_index`` / 前后关系是按最终列表位置
       编号的（``doc_state._prepare_chunks_for_write``），把 OCR 页追加到末尾会把整篇
       的阅读顺序打乱——第 3 页的内容排到第 40 页后面。

    ``ocr`` 为 ``None`` 时本策略退化成"原样透传"，不做任何判定：没有视觉模型时该怎么
    处理"一篇提取不到文本的文档"是调用方（``ParsingState``）的决定，不是加载器的。
    """

    def __init__(
        self,
        base: DocumentLoaderStrategy,
        ocr: VisionClient | None = None,
        budget_seconds: float = DEFAULT_OCR_BUDGET_SECONDS,
        max_pages: int = MAX_OCR_PAGES_PER_DOC,
    ) -> None:
        self._base = base
        self._ocr = ocr
        self._budget_seconds = budget_seconds
        self._max_pages = max_pages

    def load(self, file_path: str) -> list[Document]:
        base_docs = self._base.load(file_path)
        if self._ocr is None:
            return base_docs

        try:
            page_texts = pdf_page_texts(file_path)
        except RuntimeError:
            # 打不开就交回基础链的结果——这里不是判断"文件是否损坏"的地方
            logger.warning("PDF 无法用 pdfium 打开，跳过扫描页补 OCR: %s", file_path)
            return base_docs

        scanned = [i for i, text in enumerate(page_texts) if page_needs_ocr(text)]
        report = build_load_report(total_pages=len(page_texts))
        if not scanned:
            return self._attach_report(base_docs, report)

        report["ocr_candidates"] = len(scanned)
        if len(scanned) > self._max_pages:
            report["ocr_skipped_budget"] = len(scanned) - self._max_pages
            scanned = scanned[: self._max_pages]

        by_page = {
            doc.metadata["page"]: doc
            for doc in base_docs
            if isinstance(doc.metadata.get("page"), int)
        }
        ocr = self._ocr
        extra: list[Document] = []
        deadline = time.monotonic() + self._budget_seconds
        for position, index in enumerate(scanned):
            if time.monotonic() >= deadline:
                skipped = len(scanned) - position
                report["ocr_skipped_budget"] += skipped
                logger.info(
                    "OCR 时间预算（%.0fs）用尽，%d 页改为跳过", self._budget_seconds, skipped,
                )
                break
            text = _ocr_pdf_page(ocr, file_path, index)
            if text is None:
                report["ocr_failed"] += 1
                continue
            report["ocr_pages"] += 1
            page_no = index + 1  # pdfium 是 0 基，metadata 统一 1 基
            extra.append(
                Document(
                    page_content=text,
                    metadata={"source": str(file_path), "page": page_no, "ocr": True},
                )
            )
            by_page.pop(page_no, None)  # 同页若已有空文本行，用 OCR 结果替掉

        merged = [*by_page.values(), *extra]
        # 有页号的按页号走；没有页号的（极少数策略不写 page）保持相对顺序垫后
        merged.sort(key=lambda d: (d.metadata.get("page") is None, d.metadata.get("page") or 0))
        return self._attach_report(merged, report)

    @staticmethod
    def _attach_report(docs: list[Document], report: dict[str, int]) -> list[Document]:
        """把诊断计数挂到首个文档上（见 ``ocr.LOAD_REPORT_KEY`` 的说明）。

        **与已有的报告合并，不能覆盖**：外层的页面 OCR 包着内层（含插图说明的
        opendataloader 策略），内层已经挂上了图片计数。数字 PDF 恰好走"没有扫描页"
        那条早返回路径，直接赋值会把图片的失败/跳过计数抹掉——于是"有几张图没生成
        说明"这件事就永远不会出现在界面上。
        """
        if not docs:
            return docs
        existing = docs[0].metadata.get(LOAD_REPORT_KEY)
        docs[0].metadata[LOAD_REPORT_KEY] = merge_load_reports(
            existing if isinstance(existing, dict) else None, report,
        )
        return docs


class DocxLoaderStrategy(DocumentLoaderStrategy):
    """Word 文档加载——**保留表格与插图说明**（迭代 6 T6.4）。

    此前用 ``Docx2txtLoader``：它只抽正文，**表格与图片都被静默丢掉**——用户传了
    一份带对照表的方案，入库后那张表根本不在了，而界面上不会有任何提示。

    现在用 python-docx 按**正文顺序**（``iter_inner_content``）遍历段落与表格，
    表格渲染成 Markdown，插图交给视觉模型生成说明文字并**就地插入**（顺序是硬约束：
    统一追加到文末会让"图 1 的说明"跑到第 40 页后面）。没配视觉模型时退回到原来的
    计数占位，行为与批次①一致。
    """

    def __init__(self, captioner: ImageCaptioner | None = None) -> None:
        self._captioner = captioner

    def load(self, file_path: str) -> list[Document]:
        from docx import Document as DocxDocument
        from docx.table import Table as DocxTable

        document = DocxDocument(file_path)
        parts: list[str] = []
        table_count = 0
        image_count = 0
        for item in document.iter_inner_content():
            if isinstance(item, DocxTable):
                rendered = table_to_markdown(item)
                if rendered:
                    parts.append(rendered)
                    table_count += 1
            else:
                text = (item.text or "").strip()
                if text:
                    parts.append(text)
            images = _docx_images(item, document)
            if images:
                image_count += len(images)
                parts.extend(_caption_all(self._captioner, images))

        report = build_load_report(images=image_count)
        if self._captioner is not None:
            report["images_captioned"] = self._captioner.captioned
            report["images_failed"] = self._captioner.failed
            report["images_skipped"] = self._captioner.skipped

        # 只有**没拿到说明**的图才留占位：都解释清楚了还留一行"未提取"是自相矛盾，
        # 而对失败的那几张，这一行正是"这段内容为什么缺失"的可解释信号。
        missing = image_count - report["images_captioned"]
        if missing:
            parts.append(f"（本文档含 {missing} 张图片，其文字内容未提取）")
        if not parts:
            raise RuntimeError(f"No text content extracted from {file_path}")
        logger.debug(
            "DOCX 解析完成：%d 段/表（其中表格 %d），图片 %d（已说明 %d）",
            len(parts), table_count, image_count, report["images_captioned"],
        )
        return [
            Document(
                page_content="\n\n".join(parts),
                metadata={
                    "source": str(file_path),
                    "tables": table_count,
                    "images": image_count,
                    LOAD_REPORT_KEY: report,
                },
            )
        ]


class UnstructuredExcelStrategy(DocumentLoaderStrategy):
    """Excel 表格加载。"""

    def load(self, file_path: str) -> list[Document]:
        from langchain_community.document_loaders import UnstructuredExcelLoader
        return UnstructuredExcelLoader(file_path).load()


class PythonPPTXLoaderStrategy(DocumentLoaderStrategy):
    """PowerPoint 加载——使用 python-pptx（跨平台，无需 unstructured）。

    每页一个 Document；插图交给视觉模型生成说明并附在该页文本之后（图在页内没有
    可靠的相对位置，页是最自然的归属粒度）。没配视觉模型时退回计数占位。
    """

    def __init__(self, captioner: ImageCaptioner | None = None) -> None:
        self._captioner = captioner

    def load(self, file_path: str) -> list[Document]:
        from pptx import Presentation
        from pptx.enum.shapes import MSO_SHAPE_TYPE

        prs = Presentation(file_path)
        docs: list[Document] = []
        image_count = 0
        for i, slide in enumerate(prs.slides):
            texts: list[str] = []
            pictures = 0
            for shape in slide.shapes:
                if shape.has_text_frame:
                    tf = cast(Any, shape).text_frame
                    for para in tf.paragraphs:
                        t = para.text.strip()
                        if t:
                            texts.append(t)
                    continue
                # 表格此前被整块丢掉（只处理了 has_text_frame）——幻灯片里的表格
                # 往往就是全篇的结论
                if getattr(shape, "has_table", False):
                    rendered = table_to_markdown(cast(Any, shape).table)
                    if rendered:
                        texts.append(rendered)
                    continue
                if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
                    pictures += 1
            images = _pptx_images(slide)
            captioned = _caption_all(self._captioner, images)
            texts.extend(captioned)
            image_count += len(images)
            if len(captioned) < pictures:
                texts.append(
                    f"（本页含 {pictures - len(captioned)} 张图片，其文字内容未提取）"
                )
            if texts:
                docs.append(Document(
                    page_content="\n\n".join(texts),
                    metadata={"slide": i, "source": str(file_path), "images": pictures},
                ))
        if not docs:
            raise RuntimeError(f"No text content extracted from {file_path}")
        if docs and self._captioner is not None:
            docs[0].metadata[LOAD_REPORT_KEY] = build_load_report(
                images=image_count,
                images_captioned=self._captioner.captioned,
                images_failed=self._captioner.failed,
                images_skipped=self._captioner.skipped,
            )
        return docs


class UnstructuredPPTStrategy(DocumentLoaderStrategy):
    """PowerPoint 加载——unstructured（非 Windows 备选，Windows 上会崩溃）。"""

    def load(self, file_path: str) -> list[Document]:
        import platform
        if platform.system() == "Windows":
            raise RuntimeError(
                "UnstructuredPowerPointLoader is not supported on Windows "
                "due to python-magic incompatibility"
            )
        from langchain_community.document_loaders import UnstructuredPowerPointLoader
        return UnstructuredPowerPointLoader(file_path).load()


class CSVLoaderStrategy(DocumentLoaderStrategy):
    """CSV 加载。"""

    def load(self, file_path: str) -> list[Document]:
        from langchain_community.document_loaders import CSVLoader
        return CSVLoader(file_path).load()


class JSONLoaderStrategy(DocumentLoaderStrategy):
    """JSON 加载。"""

    def load(self, file_path: str) -> list[Document]:
        from langchain_community.document_loaders import JSONLoader
        return JSONLoader(file_path, jq_schema=".", text_content=False).load()


class MarkdownLoaderStrategy(DocumentLoaderStrategy):
    """Markdown 加载。"""

    def load(self, file_path: str) -> list[Document]:
        from langchain_community.document_loaders import UnstructuredMarkdownLoader
        return UnstructuredMarkdownLoader(file_path, mode="elements").load()


class HTMLLoaderStrategy(DocumentLoaderStrategy):
    """HTML 加载——使用 BeautifulSoup 解析并提取纯文本。"""

    def load(self, file_path: str) -> list[Document]:
        from langchain_community.document_loaders import BSHTMLLoader
        return BSHTMLLoader(file_path, open_encoding="utf-8").load()


class TextLoaderStrategy(DocumentLoaderStrategy):
    """纯文本加载。"""

    def load(self, file_path: str) -> list[Document]:
        from langchain_community.document_loaders import TextLoader
        return TextLoader(file_path, encoding="utf-8").load()


class ImageLoaderStrategy(DocumentLoaderStrategy):
    """图片加载——走「模型」页面配置的视觉模型做 OCR（迭代 6 T6.4）。

    此前依赖本机安装 Tesseract，未装即一律失败。而 ``png``/``jpg``/``jpeg`` 都在上传
    白名单里，于是**每一次图片上传都必然在解析阶段报错**，且错误信息指向一个用户在
    界面里无从解决的系统依赖。现在改为用模型页配置的 ``vision`` 模型：配了就能用，
    没配则给出可操作的提示。
    """

    def __init__(self, ocr: VisionClient | None = None) -> None:
        self._ocr = ocr

    def load(self, file_path: str) -> list[Document]:
        if self._ocr is None:
            raise RuntimeError(
                "图片解析需要视觉模型：请到「模型」页面添加 type=vision 的模型，"
                "并在本知识库的索引配置中开启 OCR 后重试。"
            )
        with open(file_path, "rb") as fh:
            data = fh.read()
        text = self._ocr.describe(OCR_PROMPT, data)
        if not text:
            # 不返回空文档：那会让文档以 「indexed、0 切片」的假成功入库
            raise RuntimeError("图片中未提取到文字（可能是纯图形、空白或过于模糊的图片）。")
        return [Document(page_content=text, metadata={"source": str(file_path)})]


class FallbackLoaderStrategy(DocumentLoaderStrategy):
    """组合策略——按优先级链依次尝试，返回第一个成功的结果。"""

    def __init__(self, strategies: list[DocumentLoaderStrategy]):
        self._strategies = strategies

    def load(self, file_path: str) -> list[Document]:
        errors: list[str] = []
        for strategy in self._strategies:
            try:
                return strategy.load(file_path)
            except Exception as e:
                errors.append(f"{type(strategy).__name__}: {e}")
                logger.debug("Loader %s failed: %s", type(strategy).__name__, e)
        raise ValueError(f"所有加载器出现异常: {'; '.join(errors)}")


class DocumentLoaderRegistry:
    """文档加载策略注册表。"""

    def __init__(self):
        self._strategies: dict[str, DocumentLoaderStrategy] = {}

    def register(self, file_type: str, strategy: DocumentLoaderStrategy) -> None:
        self._strategies[file_type] = strategy

    def get_strategy(self, file_type: str) -> DocumentLoaderStrategy:
        if file_type not in self._strategies:
            raise ValueError(f"Unsupported file type: {file_type}")
        return self._strategies[file_type]

    def load(self, file_path: str, file_type: str) -> list[Document]:
        return self.get_strategy(file_type).load(file_path)


def create_default_loader_registry(
    ocr: VisionClient | None = None,
    ocr_budget_seconds: float = DEFAULT_OCR_BUDGET_SECONDS,
    ocr_max_pages: int = MAX_OCR_PAGES_PER_DOC,
) -> DocumentLoaderRegistry:
    """创建预注册所有内置文件类型的加载器注册表。

    Args:
        ocr: 视觉模型客户端。为 ``None`` 时图片类文档的解析会明确失败并提示去配置
            模型——**不会**静默产出一个空文档。未开启 OCR 的知识库继续沿用启动时
            构建的那一份（见 ``api.knowledge_base.facade``），零开销。
        ocr_budget_seconds: 单篇文档的 OCR 时间预算（由阶段超时推导，见
            ``core.rag.ocr.DEFAULT_OCR_BUDGET_SECONDS``）。
        ocr_max_pages: 单篇文档的 OCR 页数上限。
    """
    registry = DocumentLoaderRegistry()

    # 插图说明与扫描页 OCR 各持一份同口径的预算。DOCX/PPTX 只走前者、扫描件只走
    # 后者；PDF 两类都可能走（页 + 图），因此单篇最坏会花掉两份预算——总量仍由外层
    # 阶段超时兜底，而这里不追求精确到一次调用，宁可两边各自简单。
    captioner = (
        ImageCaptioner(ocr, budget_seconds=ocr_budget_seconds, max_images=ocr_max_pages)
        if ocr is not None else None
    )

    # PDF: 优先 opendataloader_pdf，备选 PyPDFLoader；外面再包一层"扫描页补 OCR"
    registry.register("pdf", OcrAugmentedPdfStrategy(
        FallbackLoaderStrategy([
            OpenDataLoaderPDFStrategy(captioner),
            PyPDFLoaderStrategy(),
        ]),
        ocr=ocr,
        budget_seconds=ocr_budget_seconds,
        max_pages=ocr_max_pages,
    ))

    registry.register("docx", DocxLoaderStrategy(captioner))
    registry.register("xlsx", UnstructuredExcelStrategy())
    registry.register("pptx", FallbackLoaderStrategy([
        PythonPPTXLoaderStrategy(captioner),
        UnstructuredPPTStrategy(),
    ]))
    registry.register("csv", CSVLoaderStrategy())
    registry.register("json", JSONLoaderStrategy())
    registry.register("md", MarkdownLoaderStrategy())
    registry.register("html", HTMLLoaderStrategy())
    registry.register("txt", TextLoaderStrategy())

    image_strategy = ImageLoaderStrategy(ocr)
    for ft in ("png", "jpg", "jpeg", "image"):
        registry.register(ft, image_strategy)

    return registry
