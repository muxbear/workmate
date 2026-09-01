# 联网搜索 MCP Server
#
# 通过 DuckDuckGo HTML 接口实现互联网信息检索，暴露唯一工具 web_search。


"""DuckDuckGo web search MCP server."""
from __future__ import annotations

import asyncio
import logging
from html.parser import HTMLParser
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
from mcp.server.fastmcp import FastMCP

logger = logging.getLogger(__name__)

_SEARCH_URL = 'https://html.duckduckgo.com/html/'
_USER_AGENT = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/124.0 Safari/537.36'
)
_DEFAULT_MAX_RESULTS = 5
_MAX_RESULTS_LIMIT = 20

mcp = FastMCP('ke-hermes-web-search')


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


def _tavily_search(query: str, max_results: int) -> dict[str, Any] | None:
    """通过 Tavily API 检索互联网信息（已配置密钥时优先使用）。.

    返回统一结构的结果字典；未配置密钥或调用失败时返回 None，
    由调用方回退到 DuckDuckGo，避免单个搜索源故障导致无数据返回。
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
        logger.warning('Tavily search failed, fallback to DuckDuckGo: %s', exc)
        return None


async def _perform_search(
    query: str,
    max_results: int = _DEFAULT_MAX_RESULTS,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    # 执行联网搜索并返回结构化结果：优先 Tavily（结构化、稳定），失败回退 DuckDuckGo。
    query = query.strip()
    if not query:
        return {'query': query, 'results': [], 'total': 0, 'error': 'query 不能为空'}

    max_results = max(1, min(int(max_results), _MAX_RESULTS_LIMIT))

    tavily_result = await asyncio.to_thread(_tavily_search, query, max_results)
    if tavily_result is not None:
        return tavily_result

    try:
        async with httpx.AsyncClient(
            timeout=10,
            follow_redirects=True,
            transport=transport,
            headers={'User-Agent': _USER_AGENT},
        ) as client:
            response = await client.get(_SEARCH_URL, params={'q': query})
            response.raise_for_status()
            results = parse_search_results(response.text, max_results)
    except httpx.TimeoutException as exc:
        return {
            'query': query,
            'results': [],
            'total': 0,
            'error': f'搜索请求超时：{exc}',
            'source': 'duckduckgo',
        }
    except httpx.HTTPStatusError as exc:
        return {
            'query': query,
            'results': [],
            'total': 0,
            'error': f'搜索服务返回错误：{exc.response.status_code}',
            'source': 'duckduckgo',
        }
    except httpx.HTTPError as exc:
        return {
            'query': query,
            'results': [],
            'total': 0,
            'error': f'搜索请求失败：{exc}',
            'source': 'duckduckgo',
        }
    except Exception as exc:
        return {
            'query': query,
            'results': [],
            'total': 0,
            'error': f'搜索失败：{exc}',
            'source': 'duckduckgo',
        }

    return {'query': query, 'results': results, 'total': len(results), 'source': 'duckduckgo'}


@mcp.tool()
async def web_search(query: str, max_results: int = _DEFAULT_MAX_RESULTS) -> dict[str, Any]:
    """Search the web and return titles, URLs, and snippets."""
    return await _perform_search(query, max_results)


__all__ = ['mcp', 'parse_search_results', 'web_search']


def main() -> None:
    # 启动 MCP Server。
    mcp.run()


if __name__ == '__main__':
    main()
