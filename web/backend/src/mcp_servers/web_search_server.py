# 联网搜索 MCP Server
#
# 通过多源回退链（Tavily → Bing → DuckDuckGo）实现互联网信息检索，
# 暴露唯一工具 web_search。单一数据源故障（配额耗尽 / 网络不可达）时
# 自动换下一个，避免专家拿不到任何数据。


"""Web search MCP server with a multi-provider fallback chain."""
from __future__ import annotations

import asyncio
import base64
import logging
from html.parser import HTMLParser
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
from mcp.server.fastmcp import FastMCP

from mcp_servers.transport_security import transport_security_settings

logger = logging.getLogger(__name__)

_SEARCH_URL = 'https://html.duckduckgo.com/html/'
_BING_SEARCH_URL = 'https://www.bing.com/search'
_USER_AGENT = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/124.0 Safari/537.36'
)
# 取中文结果优先，同时保留英文源
_BING_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8'
_DEFAULT_MAX_RESULTS = 5
_MAX_RESULTS_LIMIT = 20

# 支持的提供方与展示名（错误信息里用展示名，便于定位是哪一层不可用）
_PROVIDER_LABELS = {
    'tavily': 'Tavily',
    'bing': 'Bing',
    'duckduckgo': 'DuckDuckGo',
}
_DEFAULT_PROVIDER_ORDER = ('tavily', 'bing', 'duckduckgo')

mcp = FastMCP('ke-hermes-web-search', transport_security=transport_security_settings())


def _extract_url(href: str) -> str:
    # 从 DuckDuckGo 跳转地址中还原真实 URL。
    href = href.strip()
    if href.startswith('//'):
        href = f'https:{href}'
    parsed = urlparse(href)
    query = parse_qs(parsed.query)
    if 'uddg' in query:
        return query['uddg'][0]
    return href


class _DuckDuckGoResultParser(HTMLParser):
    # 解析 DuckDuckGo HTML 结果页中的标题、URL 和摘要。

    def __init__(self) -> None:
        super().__init__()
        self.results: list[dict[str, str]] = []
        self._pending_title: str | None = None
        self._pending_href = ''
        self._collecting_title = False
        self._collecting_snippet = False
        self._snippet_parts: list[str] = []

    def handle_starttag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        attrs_map = {key: value or '' for key, value in attrs}
        classes = attrs_map.get('class', '').split()
        if tag == 'a' and 'result__a' in classes:
            self._flush_pending()
            self._pending_title = ''
            self._pending_href = attrs_map.get('href', '')
            self._collecting_title = True
            self._collecting_snippet = False
            self._snippet_parts = []
        elif tag == 'a' and 'result__snippet' in classes:
            self._collecting_snippet = True
            self._snippet_parts = []
            self._collecting_title = False

    def handle_data(self, data: str) -> None:
        if self._collecting_title and self._pending_title is not None:
            self._pending_title += data
        elif self._collecting_snippet:
            self._snippet_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == 'a' and self._collecting_snippet:
            self._flush_pending()
            self._collecting_snippet = False
        elif tag == 'a' and self._collecting_title:
            self._collecting_title = False

    def close(self) -> None:
        self._flush_pending()
        super().close()

    def _flush_pending(self) -> None:
        if self._pending_title is None:
            return
        snippet = ' '.join(''.join(self._snippet_parts).split())
        self.results.append(
            {
                'title': ' '.join(self._pending_title.split()),
                'url': _extract_url(self._pending_href),
                'snippet': snippet,
            }
        )
        self._pending_title = None
        self._pending_href = ''
        self._snippet_parts = []
        self._collecting_title = False
        self._collecting_snippet = False


def parse_search_results(
    page_html: str,
    max_results: int = _DEFAULT_MAX_RESULTS,
) -> list[dict[str, str]]:
    """Parse DuckDuckGo HTML results into title, URL, and snippet items."""
    parser = _DuckDuckGoResultParser()
    parser.feed(page_html)
    parser.close()
    return parser.results[:max_results]


def _resolve_bing_url(href: str) -> str:
    # Bing 会把部分结果包在 /ck/a 跳转里，尽量还原真实 URL；
    # 还原不了就放弃该条（宁缺勿错——引用里的坏链接比没有链接更糟）。
    href = href.strip()
    if not href:
        return ''
    if href.startswith('//'):
        href = f'https:{href}'
    elif href.startswith('/'):
        href = f'https://www.bing.com{href}'
    parsed = urlparse(href)
    if parsed.netloc.endswith('bing.com') and parsed.path.startswith('/ck/a'):
        raw = parse_qs(parsed.query).get('u', [''])[0]
        # u 参数形如 a1<base64url>，去掉前缀后补齐 padding
        candidate = raw[2:] if raw.startswith('a1') else raw
        try:
            decoded = base64.urlsafe_b64decode(
                candidate + '=' * (-len(candidate) % 4)
            ).decode('utf-8', 'replace')
        except Exception:
            return href
        return decoded if decoded.startswith('http') else href
    return href


class _BingResultParser(HTMLParser):
    # 解析 Bing 结果页中的标题、URL 和摘要（按 <li class="b_algo"> 分块）。

    def __init__(self) -> None:
        super().__init__()
        self.results: list[dict[str, str]] = []
        self._in_block = False
        self._in_title = False
        self._in_snippet = False
        self._href = ''
        self._title_parts: list[str] = []
        self._snippet_parts: list[str] = []

    def handle_starttag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        attrs_map = {key: value or '' for key, value in attrs}
        classes = attrs_map.get('class', '').split()
        if tag == 'li' and 'b_algo' in classes:
            self._flush_pending()
            self._in_block = True
            self._href = ''
            self._title_parts = []
            self._snippet_parts = []
            return
        if not self._in_block:
            return
        if tag == 'h2':
            self._in_title = True
            self._title_parts = []
        elif tag == 'a' and self._in_title and not self._href:
            self._href = attrs_map.get('href', '')
        elif tag == 'p' and any(cls.startswith('b_lineclamp') for cls in classes):
            self._in_snippet = True
            self._snippet_parts = []

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self._title_parts.append(data)
        elif self._in_snippet:
            self._snippet_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == 'h2':
            self._in_title = False
        elif tag == 'p' and self._in_snippet:
            self._in_snippet = False
        elif tag == 'li' and self._in_block:
            self._flush_pending()

    def close(self) -> None:
        self._flush_pending()
        super().close()

    def _flush_pending(self) -> None:
        if not self._in_block:
            return
        self._in_block = False
        self._in_title = False
        self._in_snippet = False
        url = _resolve_bing_url(self._href)
        title = ' '.join(''.join(self._title_parts).split())
        if not url or not title:
            self._title_parts = []
            self._snippet_parts = []
            return
        self.results.append(
            {
                'title': title,
                'url': url,
                'snippet': ' '.join(''.join(self._snippet_parts).split()),
            }
        )
        self._title_parts = []
        self._snippet_parts = []


def parse_bing_results(
    page_html: str,
    max_results: int = _DEFAULT_MAX_RESULTS,
) -> list[dict[str, str]]:
    """Parse Bing HTML results into title, URL, and snippet items."""
    parser = _BingResultParser()
    parser.feed(page_html)
    parser.close()
    return parser.results[:max_results]


def _tavily_search(query: str, max_results: int) -> dict[str, Any] | None:
    """通过 Tavily API 检索互联网信息（已配置密钥时优先使用）。.

    返回统一结构的结果字典；未配置密钥或调用失败时返回 None，
    由调用方按配置的提供方顺序回退到下一个，避免单个搜索源故障导致无数据返回。
    """
    try:
        from tavily import TavilyClient

        from agent.config import settings

        if not settings.TAVILY_API_KEY:
            return None

        topic = (
            'news'
            if any(k in query.lower() for k in ('新闻', 'news', '热点', 'hot'))
            else 'general'
        )
        client = TavilyClient(api_key=settings.TAVILY_API_KEY)
        result = client.search(
            query=query,
            search_depth='basic',
            topic=topic,
            max_results=max_results,
            include_answer=True,
        )
        results = [
            {
                'title': item.get('title', ''),
                'url': item.get('url', ''),
                'snippet': item.get('content', ''),
            }
            for item in result.get('results', [])
            if isinstance(item, dict)
        ]
        return {
            'query': result.get('query', query),
            'results': results,
            'total': len(results),
            'answer': result.get('answer', ''),
            'source': 'tavily',
        }
    except Exception as exc:
        logger.warning('Tavily search unavailable, trying the next provider: %s', exc)
        return None


def _provider_order() -> tuple[str, ...]:
    # 提供方顺序来自配置（WEB_SEARCH_PROVIDERS）；未知取值被丢弃，
    # 全部非法时回退默认链，避免配置写错导致检索彻底不可用。
    from agent.config import settings

    raw = getattr(settings, 'WEB_SEARCH_PROVIDERS', '') or ''
    names = [part.strip().lower() for part in raw.split(',') if part.strip()]
    valid = tuple(name for name in names if name in _PROVIDER_LABELS)
    return valid or _DEFAULT_PROVIDER_ORDER


def _timeout_seconds() -> float:
    from agent.config import settings

    try:
        value = float(getattr(settings, 'WEB_SEARCH_TIMEOUT_SECONDS', 10) or 10)
    except (TypeError, ValueError):
        return 10.0
    return value if value > 0 else 10.0


async def _fetch_html(
    url: str,
    params: dict[str, Any],
    transport: httpx.AsyncBaseTransport | None,
    headers: dict[str, str],
) -> tuple[str, str | None]:
    # 抓取搜索结果页 HTML；失败时返回 (空串, 原因)，由调用方决定是否换下一个提供方。
    try:
        async with httpx.AsyncClient(
            timeout=_timeout_seconds(),
            follow_redirects=True,
            transport=transport,
            headers=headers,
        ) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            return response.text, None
    except httpx.TimeoutException as exc:
        return '', f'搜索请求超时：{exc}'
    except httpx.HTTPStatusError as exc:
        return '', f'搜索服务返回错误：{exc.response.status_code}'
    except httpx.HTTPError as exc:
        return '', f'搜索请求失败：{exc}'
    except Exception as exc:
        return '', f'搜索失败：{exc}'


async def _run_provider(
    provider: str,
    query: str,
    max_results: int,
    transport: httpx.AsyncBaseTransport | None,
) -> tuple[dict[str, Any] | None, str | None]:
    # 执行单个提供方的检索：返回 (结果字典, 失败原因)；结果字典可能为空列表
    # （"这次没搜到"与"这层不可用"要分开，前者也要继续换下一个提供方）。
    if provider == 'tavily':
        result = await asyncio.to_thread(_tavily_search, query, max_results)
        if result is None:
            return None, '不可用（未配置密钥或调用失败）'
        return result, None

    if provider == 'bing':
        html, error = await _fetch_html(
            _BING_SEARCH_URL,
            {'q': query, 'count': max_results},
            transport,
            {'User-Agent': _USER_AGENT, 'Accept-Language': _BING_ACCEPT_LANGUAGE},
        )
        if error:
            return None, error
        return (
            {'query': query, 'results': parse_bing_results(html, max_results), 'source': 'bing'},
            None,
        )

    html, error = await _fetch_html(
        _SEARCH_URL,
        {'q': query},
        transport,
        {'User-Agent': _USER_AGENT},
    )
    if error:
        return None, error
    return (
        {
            'query': query,
            'results': parse_search_results(html, max_results),
            'source': 'duckduckgo',
        },
        None,
    )


async def _perform_search(
    query: str,
    max_results: int = _DEFAULT_MAX_RESULTS,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    # 执行联网搜索并返回结构化结果：按配置顺序逐个提供方尝试，任一给出结果即返回；
    # 全部失败时汇总各家原因，便于定位是哪一层不可用（配额？网络？页面改版？）。
    query = query.strip()
    if not query:
        return {'query': query, 'results': [], 'total': 0, 'error': 'query 不能为空'}

    max_results = max(1, min(int(max_results), _MAX_RESULTS_LIMIT))

    attempts = _provider_order()
    errors: list[str] = []
    for index, provider in enumerate(attempts):
        payload, error = await _run_provider(provider, query, max_results, transport)
        if payload and payload.get('results'):
            return {
                **payload,
                'total': len(payload['results']),
                'attempts': attempts[: index + 1],
            }
        errors.append(f'{_PROVIDER_LABELS[provider]}：{error or "未返回结果"}')

    return {
        'query': query,
        'results': [],
        'total': 0,
        'source': None,
        'attempts': attempts,
        'error': '；'.join(errors) or '没有可用的搜索提供方',
    }


@mcp.tool()
async def web_search(query: str, max_results: int = _DEFAULT_MAX_RESULTS) -> dict[str, Any]:
    """Search the web via a multi-provider fallback chain; return titles, URLs, and snippets."""
    return await _perform_search(query, max_results)


__all__ = ['mcp', 'parse_bing_results', 'parse_search_results', 'web_search']


def main() -> None:
    # 启动 MCP Server。
    mcp.run()


if __name__ == '__main__':
    main()
