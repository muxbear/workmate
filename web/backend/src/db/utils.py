"""数据库工具函数。"""

from datetime import UTC, datetime


def utcnow() -> datetime:
    """返回 UTC 当前时间（naive，兼容 SQLite）。"""
    return datetime.now(UTC).replace(tzinfo=None)
