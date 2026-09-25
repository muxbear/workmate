"""请求上下文里的 request_id——贯穿日志与响应头（迭代 5 T5.5）。

要解决的问题：一次请求会打出十几条日志（鉴权、DB、向量库、审计……），出问题时只能
按时间顺序人工拼读。有了 request_id 就能一条命令捞全：

    grep "a1b2c3d4" backend.log

实现要点：

- **ContextVar 而不是全局变量**：并发请求各持自己的 id（SSE 长连接也不会串号）；
- **日志格式由本模块统一安装**：``%(request_id)s`` 要有值就必须注入 LogRecord，
  而"注入"和"格式化"必须配套设置——分散在两处会出现"格式里写了占位符但没注入"，
  结果是每次打日志都报 KeyError。
- 响应头回带 ``X-Request-Id``：用户反馈"刚才那次搜索失败了"时能直接定位。
"""

from __future__ import annotations

import logging
import uuid
from contextvars import ContextVar

#: 当前请求的 id；不在请求上下文里时为 "-"（启动期日志、后台任务都属这种）
request_id_var: ContextVar[str] = ContextVar("request_id", default="-")

#: 客户端可用该头透传自己的链路 id（网关/前端已生成时沿用它，便于跨系统串联）
REQUEST_ID_HEADER = "X-Request-Id"

_installed = False


def current_request_id() -> str:
    """取当前请求的 id（不在请求上下文里时返回 ``"-"``）。"""
    return request_id_var.get()


def new_request_id() -> str:
    """生成一个短 id：16 位十六进制，够用且便于肉眼比对。"""
    return uuid.uuid4().hex[:16]


def install_request_id_logging(level: int = logging.INFO) -> None:
    """安装日志格式（含 request_id）与记录注入；重复调用无副作用。

    必须调用**一次**且早于任何业务日志：它负责 ``basicConfig``，因此模块内不要再
    单独配置日志格式，否则两处格式会互相覆盖。
    """
    global _installed
    if _installed:
        return
    _installed = True

    old_factory = logging.getLogRecordFactory()

    def record_factory(*args, **kwargs):
        record = old_factory(*args, **kwargs)
        # 每条日志都带上当前上下文的 request_id（没有请求时是 "-"）
        record.request_id = request_id_var.get()
        return record

    logging.setLogRecordFactory(record_factory)
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s [%(request_id)s] %(name)s: %(message)s",
    )


__all__ = [
    "REQUEST_ID_HEADER",
    "current_request_id",
    "install_request_id_logging",
    "new_request_id",
    "request_id_var",
]
