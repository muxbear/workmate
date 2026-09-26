"""扫描页判定与光栅化——决定"哪些页需要 OCR、怎么渲染"（迭代 6 T6.4 批次③）。

与 ``core.rag.vision`` 分开：那边只管"怎么调模型"，这边只管"什么时候该调、把哪一页
渲成什么"。判据是纯函数，可以脱离 pdfium 单测；光栅化是本地 CPU 活，失败方式与网络
调用完全不同。

**扫描件此前会被静默吞掉**：``OpenDataLoaderPDFStrategy`` 遇无文本层抛错 → 回退到
``PyPDFLoader`` → pypdf 不抛错、逐页返回空字符串 → 被当成成功。文档最终标记
``indexed``、``chunks_count = 0``、零报错零提示——用户以为传进去了，实际一条都检索不到。
本模块提供"哪些页其实是图"的判据，让这件事要么被 OCR 补上，要么明确失败。
"""

from __future__ import annotations

import logging
import re
import threading
from collections.abc import Sequence
from typing import Any

logger = logging.getLogger(__name__)

#: 「这一页没有可用的文本层」的判据——按**有效字符数**计（去掉空白、数字、标点之后的
#: 汉字/字母数）。扫描页恒为 0：它是一张图，页里没有任何文本对象。
#:
#: **刻意严到"至少得有一个词"**，而不是"字符很少"。这个判据决定的是"要不要用模型输出
#: **替换**这一页的文本"，一旦放宽，只有章节名或页眉的数字页也会被送去 OCR，用模型的
#: 转写盖掉本来正确的文本层——那是拿确定性换不确定性。宁可漏掉少数文本极稀疏的扫描页。
#:
#: 参照：仓库自带的 ``tests/fixtures/sample.pdf`` 是一页只有 17 个字符的**正常** PDF
#: （"Test PDF Document"）。任何按"字符数少"定的阈值（比如 ``safe_fetch`` 的
#: ``_MIN_TEXT_CHARS = 120``）都会把它误判成扫描件。
MIN_TEXT_CHARS_PER_PAGE = 1

#: 「整篇都没提取到文本」的判据——用于明确失败而不是静默入库一篇空文档。
#:
#: 按**非空白字符数**计，而不是上面的"有效字符"：纯数字的 CSV、只有数字的表格是正常
#: 内容，用有效字符判会把它们误判成空文档而拒绝入库。扫描件两种口径都是 0，不受影响。
#:
#: 用全文合计而不是"存在无文本的页"：一份数字 PDF 里夹一张纯图页（封面、插页）不该
#: 让整篇失败。
#:
#: **阈值就是"至少有一个非空白字符"**，不再往上抬。误拒一份真实文档比漏放一篇垃圾
#: 严重得多——把阈值抬高一点点（比如 4）就会拒掉只有两个字正文的文件，而那完全可能
#: 是用户有意传的一条短记录。扫描件与纯空白文件在这个口径下都是 0，该抓的照样抓得住。
MIN_DOC_TEXT_CHARS = 1

#: 渲染倍率。PDF 的 1 点 = 1/72 英寸，scale=2 即 144 DPI——够 OCR 读小字，又不至于把
#: 一页 A4 渲成好几 MB（渲染本身约 44ms/页，实测瓶颈在模型侧的几个秒级往返）。
RENDER_SCALE = 2.0

#: 空白页判据：渲染图的最亮与最暗像素差小于它，就认定是纯色页（白纸或纯黑扫描）。
#: 不为一张白纸付一次模型调用。
BLANK_IMAGE_SPREAD = 8

#: 单篇文档的 OCR 时间预算（秒）。**由调用方按阶段超时推导后传入**，这里的默认值只是
#: 兜底。为什么不靠"阶段超时"本身兜底：``ParsingState`` 整个阶段（含基础解析与下游）
#: 默认 600s，而一份 500 页的扫描件按每页 2~6s 要 1000~3000s——外层 ``wait_for`` 会在
#: **干完所有活之后**才掐断，文档以超时失败、白烧一遍模型调用。预算必须在页循环里生效。
DEFAULT_OCR_BUDGET_SECONDS = 300.0

#: 单篇文档的 OCR 页数上限。防荒谬输入的兜底（真正的约束是上面的时间预算）。
MAX_OCR_PAGES_PER_DOC = 300

#: pdfium **不是线程安全的**——``langchain_community`` 的 ``PyPDFium2Loader`` 就是为此
#: 自带一把模块级锁。索引流水线最多并发解析 ``INDEXING_MAX_CONCURRENT`` 篇文档，每篇
#: 在各自的工作线程里调到这里。
#:
#: 只锁"打开文档 / 取文本 / 渲染"这类本地操作，**网络调用必须在锁外**——把
#: ``vision.describe`` 也圈进来会让 3 路并发重新退化成 1 路。
_PDFIUM_LOCK = threading.Lock()

#: 有效字符的判定：去掉非单词字符与数字后剩下的。
#: ``\w`` 在 Python 的 Unicode 语义下包含汉字，所以中文不会被当成标点剔掉。
_MEANINGFUL = re.compile(r"[\W\d_]+", re.UNICODE)


def meaningful_chars(text: str) -> int:
    """数出文本里的"实词"字符数（去空白、数字、标点、符号）。"""
    return len(_MEANINGFUL.sub("", text or ""))


def page_needs_ocr(text: str) -> bool:
    """这一页是否没有可用的文本层（即该走 OCR）。"""
    return meaningful_chars(text) < MIN_TEXT_CHARS_PER_PAGE


def doc_has_usable_text(page_texts: Sequence[str]) -> bool:
    """整篇是否提取到了足以入库的文本。

    判据用的是**非空白字符**（见 :data:`MIN_DOC_TEXT_CHARS` 的说明），不是有效字符。
    """
    total = sum(len("".join((text or "").split())) for text in page_texts)
    return total >= MIN_DOC_TEXT_CHARS


def is_blank_image(image: Any) -> bool:
    """渲染图是否近乎纯色（真空白页，跳过 OCR）。"""
    try:
        extrema = image.convert("L").getextrema()
    except Exception:  # noqa: BLE001 - 判不出来就当非空白，交给模型
        return False
    if not isinstance(extrema, tuple) or len(extrema) != 2:
        return False
    low, high = int(extrema[0]), int(extrema[1])
    return (high - low) < BLANK_IMAGE_SPREAD


def pdf_page_texts(file_path: str) -> list[str]:
    """取每一页的文本层内容（0 基顺序返回）。

    Raises:
        RuntimeError: pdfium 打不开该文件。
    """
    with _PDFIUM_LOCK:
        # pypdfium2 不带 py.typed / stub（纯二进制绑定，没有可用的类型信息），
        # 因此这一处需要 ignore——同一文件里它只报一次，别处再 import 不必重复标注。
        # 两个函数都做函数内导入：pdfium 是二进制扩展，只在真的要解析 PDF 时才加载，
        # 常年处理 Office/文本的知识库不该为它付启动成本。
        import pypdfium2 as pdfium  # type: ignore[import-untyped]

        try:
            with pdfium.PdfDocument(file_path) as pdf:
                return [_page_text(pdf, i) for i in range(len(pdf))]
        except Exception as exc:  # noqa: BLE001 - 统一转成可读错误
            raise RuntimeError(f"PDF 无法打开（{file_path}）：{exc}") from exc


def _page_text(pdf: Any, index: int) -> str:
    """取单页文本；取不到时返回空串（交由判据决定是否 OCR）。"""
    try:
        return pdf[index].get_textpage().get_text_range() or ""
    except Exception:  # noqa: BLE001 - 单页取文本失败等同于"这页没文本"
        logger.debug("PDF 第 %d 页取文本失败", index + 1, exc_info=True)
        return ""


def render_page_png(file_path: str, page_index: int) -> bytes | None:
    """把某一页渲染成 PNG 字节；渲染失败返回 ``None``。

    Args:
        file_path: PDF 路径。
        page_index: **0 基**页序号（pdfium 的下标口径）。
    """
    import io

    with _PDFIUM_LOCK:
        import pypdfium2 as pdfium  # noqa: PLC0415 - 见 pdf_page_texts 的 import-untyped 说明

        try:
            with pdfium.PdfDocument(file_path) as pdf:
                if page_index >= len(pdf):
                    return None
                image = pdf[page_index].render(scale=RENDER_SCALE).to_pil()
        except Exception:  # noqa: BLE001 - 渲染失败不该炸掉整篇解析
            logger.warning(
                "PDF 第 %d 页渲染失败，跳过该页 OCR",
                page_index + 1,
                exc_info=True,
            )
            return None

    # 纯色页不必花钱：判完再编码，省掉一次无谓的 PNG 压缩
    if is_blank_image(image):
        logger.debug("PDF 第 %d 页近乎空白，跳过 OCR", page_index + 1)
        return None

    buffer = io.BytesIO()
    try:
        image.convert("RGB").save(buffer, format="PNG")
    except Exception:  # noqa: BLE001
        logger.warning("PDF 第 %d 页编码 PNG 失败", page_index + 1, exc_info=True)
        return None
    return buffer.getvalue()


#: 解析产物里携带诊断计数的私有键。由 ``ParsingState`` 取出后 ``pop`` 掉，
#: 因此**不会**流进切片与向量库（分片只会带 ``_prepare_chunks_for_write`` 白名单里的键）。
#:
#: 走 metadata 而不是给 ``load()`` 加返回值：它只是普通 metadata，能原样穿过
#: ``FallbackLoaderStrategy`` 的组合链，不需要给 13 个策略各加一个并行方法。
LOAD_REPORT_KEY = "_load_report"


def build_load_report(
    *,
    ocr_pages: int = 0,
    ocr_candidates: int = 0,
    ocr_failed: int = 0,
    ocr_skipped_budget: int = 0,
    total_pages: int = 0,
) -> dict[str, int]:
    """组装 OCR 计数。字段名与含义固定，便于前端与日志共用一套说法。"""
    return {
        "ocr_pages": ocr_pages,
        "ocr_candidates": ocr_candidates,
        "ocr_failed": ocr_failed,
        "ocr_skipped_budget": ocr_skipped_budget,
        "total_pages": total_pages,
    }


def format_ocr_warning(report: dict[str, int]) -> str | None:
    """把计数转成一句可直接展示的中文告警；没有需要说明的事时返回 ``None``。

    **只在"部分成功"时出声**：全部识别成功是常态，为它挂一个提示只会让人习惯性
    忽略这一栏；全部失败走的是失败路径（``error_message``），不该混在这里。
    告警的职责是解释"为什么这份文档看起来少了一部分内容"。
    """
    skipped = report.get("ocr_skipped_budget", 0)
    failed = report.get("ocr_failed", 0)
    if not skipped and not failed:
        return None

    parts: list[str] = []
    if report.get("ocr_pages"):
        parts.append(f"已识别 {report['ocr_pages']} 页")
    if skipped:
        parts.append(f"{skipped} 页因超出本次时间预算被跳过")
    if failed:
        parts.append(f"{failed} 页识别失败")
    total = report.get("total_pages") or report.get("ocr_candidates") or 0
    suffix = f"（全文 {total} 页）" if total else ""
    return "OCR：" + "；".join(parts) + suffix
