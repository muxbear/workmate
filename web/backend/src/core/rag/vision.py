"""视觉模型客户端——把图片交给多模态模型做 OCR / 图片说明（迭代 6 T6.4）。

只走 OpenAI 兼容的 ``POST {api_base}/chat/completions``，图片以 base64 data URL
放进 ``image_url`` 内容块，因此「模型」页面里任何一个 OpenAI 兼容的视觉模型都能直接
用上，无需厂商 SDK。模型与凭据同样来自「模型」页面（见
``api.knowledge_base.model_provider.load_vision_model``），不读环境变量。

**为什么是同步客户端**：调用方是文档加载器，而加载器跑在 ``asyncio.to_thread`` 的
工作线程里（``api.knowledge_base.doc_state.ParsingState``）——线程内阻塞不伤事件
循环，用 ``httpx.Client`` 是唯一自然的选择。同一个文档的多页应当放在
:meth:`session` 里复用连接池；出 ``session`` 后每次调用各自建客户端，
与 ``core.rag.llm`` / ``core.rag.reranker`` 的既有写法一致。

任何异常都返回 ``None``：OCR 失败降级为「这一页没提取到文字」，不该让整篇文档解析
失败。失败与部分成功的计数由调用方负责如实上报。
"""

from __future__ import annotations

import base64
import io
import logging
import re
import time
from collections.abc import Iterator
from contextlib import contextmanager

import httpx
from PIL import Image

from core.rag.llm import extract_message_content
from core.storage.asset_fetcher import sniff_image_mime

logger = logging.getLogger(__name__)

#: 单张图的调用超时。比文本对话宽松：一页密集扫描件要吐几千个 token，
#: 而模型侧的首 token 延迟与图片分辨率相关。
DEFAULT_TIMEOUT_SECONDS = 120.0

#: OCR 与图片说明都要求「照抄/照实描述」，没有需要随机性的场景。
DEFAULT_TEMPERATURE = 0.0

#: OCR 提示词。要求保留表格结构、不加解释——多余的话会进正文，污染切片与检索。
OCR_PROMPT = (
    "请输出图片中的全部文字内容，保持原有的阅读顺序与层级。"
    "表格请输出为 Markdown 表格，公式请输出为 LaTeX。"
    "不要添加任何解释、标题或前后缀；图片中没有文字时只回复「无文字」。"
)

#: 图片说明提示词。用于把插图转成可检索的文字，与 OCR 的「只吐原文」目标不同：
#: 这里要的是「这张图画的是什么」，图内文字也要带上。
CAPTION_PROMPT = (
    "用一到两句话说明这张图的内容；如果图中有文字、数字或表格，"
    "一并把关键信息写出来。直接输出说明文字，不要任何前缀。"
)

#: 模型对「图里没文字」这类情况的常见说法，用于把它归一成「没提取到内容」。
_NO_CONTENT_MARKERS = frozenset({"无文字", "无文字内容", "没有文字", "none", "n/a"})

#: 把**整段回答**包起来的代码围栏（```markdown … ```）。
_FENCE_PATTERN = re.compile(r"^```[A-Za-z]*[ \t]*\r?\n(?P<body>.*?)\r?\n?```$", re.DOTALL)


def _strip_code_fence(text: str) -> str:
    """去掉把整段回答包起来的代码围栏。

    实测（真实调用百炼 qwen-vl-ocr）：提示词里明确写了"不要添加任何解释、标题或
    前后缀"，它仍然把整段结果包进 ```markdown … ```。围栏对检索没有价值，进了正文
    只是噪音。

    只处理"整段就是一个围栏块"的情形——图里本来就是源码时，答案**内部**会有围栏，
    那种一个字符都不能动。
    """
    match = _FENCE_PATTERN.match(text)
    if match is None:
        return text
    return match.group("body").strip()

#: 单篇文档的插图说明上限。与扫描页的页数上限同一个道理：防荒谬输入（一份 300 张
#: 配图的 PPT 就是 300 次调用），真正的约束是时间预算。
MAX_CAPTIONS_PER_DOC = 200


class ImageCaptioner:
    """按一份预算给文档内的插图生成说明文字（迭代 6 T6.4 批次④）。

    与扫描页 OCR **共用同一套预算口径**：对一篇文档来说"这次解析允许花多少模型调用"
    是一个量，不该各算各的。超预算的图只记数跳过，由调用方如实上报——静默丢图正是
    本批次要消灭的东西。

    放在 ``vision`` 而不是 ``ocr`` 里：它只管"怎么调模型、调几次"，不碰 pdfium 与
    页级判据，那边的纯函数性质得以保留。
    """

    def __init__(
        self,
        ocr: VisionClient,
        budget_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        max_images: int = MAX_CAPTIONS_PER_DOC,
    ) -> None:
        self._ocr = ocr
        self._deadline = time.monotonic() + budget_seconds
        self._remaining = max_images
        self.captioned = 0
        self.failed = 0
        self.skipped = 0

    def caption(self, image: bytes, mime: str | None = None) -> str | None:
        """给一张图生成说明；超预算、模型失败都返回 ``None``。"""
        if self._remaining <= 0 or time.monotonic() >= self._deadline:
            self.skipped += 1
            return None
        self._remaining -= 1
        text = self._ocr.describe(CAPTION_PROMPT, image, mime)
        if text is None:
            self.failed += 1
            return None
        self.captioned += 1
        return text

    @property
    def touched(self) -> int:
        """一共处理过多少张图（用于判断要不要挂告警）。"""
        return self.captioned + self.failed + self.skipped

#: 发送前的边长上限。超过就等比缩小——上传白名单允许单文件 100MB，原样 base64
#: 会得到一个必然被服务端拒掉的请求（体积限制），而拒绝会被降级路径报成
#: 「图中未提取到文字」，把一个"图太大"诊断成"图太糊"，用户按提示换个更清楚的图
#: 也没用。1200px 宽的文字对 OCR 足够，2048 留了余量。
MAX_IMAGE_EDGE = 2048

#: 编码后的字节硬上限。缩完仍超限说明这张图没法送，直接放弃本次调用而不是发出去
#: 等一个注定失败的响应。
MAX_IMAGE_BYTES = 10 * 1024 * 1024


def _prepare_image(image: bytes, mime: str | None) -> tuple[bytes, str] | None:
    """把图片压到可发送的尺寸。

    Returns:
        ``(字节, MIME)``；图片无法处理或压缩后仍超限时返回 ``None``。

    **在限内的图片原样返回**——重编码会损失清晰度，而 OCR 恰恰吃清晰度；只有确实
    超尺寸的才缩。
    """
    resolved_mime = mime or sniff_image_mime(image) or "image/png"
    try:
        with Image.open(io.BytesIO(image)) as img:
            if max(img.size) <= MAX_IMAGE_EDGE:
                prepared = image
            else:
                img.thumbnail(
                    (MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), Image.Resampling.LANCZOS
                )
                buffer = io.BytesIO()
                # 缩完统一存 PNG：OCR 读的是小字，JPEG 的块效应会吃掉笔画
                img.convert("RGB").save(buffer, format="PNG")
                prepared, resolved_mime = buffer.getvalue(), "image/png"
    except Exception:
        # 打不开（SVG、未知格式…）就按原样发，由服务端决定
        logger.debug("图片预处理失败，按原样发送（%d 字节）", len(image), exc_info=True)
        prepared = image

    if len(prepared) > MAX_IMAGE_BYTES:
        logger.warning(
            "图片过大（%d 字节，上限 %d），已放弃本次识别",
            len(prepared),
            MAX_IMAGE_BYTES,
        )
        return None
    return prepared, resolved_mime


class VisionClient:
    """OpenAI 兼容的视觉模型客户端。

    Args:
        model: 模型名（如 ``qwen-vl-ocr``）。
        api_base: 提供商 API 根地址（不含 ``/chat/completions``）。
        api_key: API 密钥。
        timeout: 单次请求超时（秒）。
        transport: 可注入的 httpx 传输层，便于离线测试。
    """

    def __init__(
        self,
        model: str,
        api_base: str,
        api_key: str,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.model = model
        self._url = f"{api_base.rstrip('/')}/chat/completions"
        self._api_key = api_key
        self._timeout = timeout
        self._transport = transport

    @contextmanager
    def session(self) -> Iterator[httpx.Client]:
        """在一段处理中复用同一个连接池。

        本机构造一个 httpx 客户端约 350ms（见 ``core.rag.embedding`` 的实测注释），
        一份几百页的扫描件按页新建就是几百次这笔开销，所以整篇文档共用一个。

        **连接池由调用方持有，不存在实例上**：本实例会被索引流水线缓存并被多个文档
        共享（``INDEXING_MAX_CONCURRENT`` 默认 3），而构造/关闭是各线程各自发生的事。
        若把它写回 ``self``，线程 B 的 ``session()`` 会覆盖线程 A 正在用的客户端，
        B 退出时顺手关掉它，A 之后的每一次 ``describe`` 都抛错——而这个错被降级路径
        吞成「这一页没有文字」，于是**并发下随机丢页且没有任何报错**。
        """
        with httpx.Client(timeout=self._timeout, transport=self._transport) as client:
            yield client

    def describe(
        self,
        prompt: str,
        image: bytes,
        mime: str | None = None,
        client: httpx.Client | None = None,
    ) -> str | None:
        """把一张图交给视觉模型，返回它给出的文本。

        Args:
            prompt: 交给模型的指令（OCR 与图片说明用不同的提示词）。
            image: 图片原始字节。
            mime: 图片 MIME；留空时按魔数嗅探，嗅不出则按 ``image/png`` 处理。
            client: 复用 :meth:`session` 给出的连接池；``None`` 时本次自建再关闭。

        Returns:
            模型返回的文本；调用失败、响应缺字段或返回空串时返回 ``None``。
        """
        prepped = _prepare_image(image, mime)
        if prepped is None:
            return None
        prepared, resolved_mime = prepped
        data_url = (
            f"data:{resolved_mime};base64,{base64.b64encode(prepared).decode('ascii')}"
        )
        # 图片块放在前、文字指令放在后：与百炼 qwen-vl-ocr 的官方示例一致。
        payload = {
            "model": self.model,
            "temperature": DEFAULT_TEMPERATURE,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": data_url}},
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
        }

        if client is not None:
            return self._post(client, payload)
        with httpx.Client(timeout=self._timeout, transport=self._transport) as own:
            return self._post(own, payload)

    def _post(self, client: httpx.Client, payload: dict[str, object]) -> str | None:
        """发一次请求并取出回复文本；任何异常都吞成 ``None``。"""
        try:
            response = client.post(
                self._url,
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
            response.raise_for_status()
            data = response.json()
        except Exception:
            logger.warning("视觉模型调用失败（model=%s）", self.model, exc_info=True)
            return None

        content = extract_message_content(data)
        if not content:
            return None
        text = _strip_code_fence(content.strip())
        # 空串与「无文字」都归成 None：OCR 提示词让模型在图里没字时回「无文字」，
        # 若原样返回，这四个字会被写进正文并参与切片与检索。
        if not text or text.strip("。.！!：: ").lower() in _NO_CONTENT_MARKERS:
            return None
        return text
