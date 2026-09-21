"""产物下载的 Range 解析单元测试。"""

from api.agent.agent_api import _parse_byte_range


def test_parse_byte_range_supported_forms() -> None:
    """单段 Range 支持起止、开区间、后缀与超长结束位置。"""
    assert _parse_byte_range("bytes=0-3", 10) == (0, 3)
    assert _parse_byte_range("bytes=4-", 10) == (4, 9)
    assert _parse_byte_range("bytes=-3", 10) == (7, 9)
    assert _parse_byte_range("bytes=0-99", 10) == (0, 9)
    assert _parse_byte_range("bytes=2-5, 7-9", 10) == (2, 5)


def test_parse_byte_range_invalid_returns_none() -> None:
    """无法解析、越界或空对象时返回 None（按完整内容响应）。"""
    assert _parse_byte_range(None, 10) is None
    assert _parse_byte_range("items=0-3", 10) is None
    assert _parse_byte_range("bytes=abc", 10) is None
    assert _parse_byte_range("bytes=10-12", 10) is None
    assert _parse_byte_range("bytes=5-2", 10) is None
    assert _parse_byte_range("bytes=-0", 10) is None
    assert _parse_byte_range("bytes=0-3", 0) is None
