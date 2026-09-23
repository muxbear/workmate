"""网页抓取工具——把指定 URL 的页面内容原样取回，供模型阅读。."""

import urllib.request


def web_scraper(url: str = '') -> dict:
    """抓取指定 URL 的网页内容并返回响应状态与正文。.

    Args:
        url: 要抓取的完整 URL（必须带 http:// 或 https:// 前缀）。

    Returns:
        包含以下字段的字典：
            - status: HTTP 状态码（失败时无此字段）
            - body: 响应正文（UTF-8 解码，非法字节以替换字符处理）
            - error: 出错时的错误信息（成功时无此字段）
    """
    try:
        req = urllib.request.Request(url, method='GET')
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode('utf-8', errors='replace')
            return {'status': resp.status, 'body': body}
    except Exception as e:
        return {'error': str(e), 'body': ''}

__all__ = ['web_scraper']
