# web_search MCP 服务测试
import httpx
import pytest

from mcp_servers.web_search_server import (
    _perform_search,
    parse_search_results,
)

SAMPLE_HTML = '<div><a class=result__a href=//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage>Example &amp; Test</a><a class=result__snippet href=//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage>A <b>snippet</b> here.</a></div>'


@pytest.fixture(autouse=True)
def _disable_tavily(monkeypatch):
    """单元测试默认走 DuckDuckGo 分支：禁用真实 Tavily 网络调用。"""
    monkeypatch.setattr(
        "mcp_servers.web_search_server._tavily_search",
        lambda query, max_results: None,
    )


def test_parse_search_results_extracts_fields():
    results = parse_search_results(SAMPLE_HTML, max_results=1)
    assert len(results) == 1
    assert results[0]['title'] == 'Example & Test'
    assert results[0]['url'] == 'https://example.com/page'
    assert results[0]['snippet'] == 'A snippet here.'


def test_parse_search_results_limits_results():
    results = parse_search_results(SAMPLE_HTML, max_results=0)
    assert results == []


@pytest.mark.asyncio
async def test_perform_search_uses_tavily_when_available(monkeypatch):
    fake = {
        'query': 'python',
        'results': [{'title': 'T', 'url': 'https://t', 'snippet': 'S'}],
        'total': 1,
        'source': 'tavily',
    }
    monkeypatch.setattr(
        "mcp_servers.web_search_server._tavily_search",
        lambda query, max_results: fake,
    )
    result = await _perform_search('python', max_results=1)
    assert result['source'] == 'tavily'
    assert result['total'] == 1
    assert result['results'][0]['url'] == 'https://t'


@pytest.mark.asyncio
async def test_perform_search_returns_results():
    async def handler(request):
        assert 'q=python' in str(request.url)
        return httpx.Response(200, text=SAMPLE_HTML, request=request)

    result = await _perform_search(
        'python',
        max_results=1,
        transport=httpx.MockTransport(handler),
    )
    assert result['total'] == 1
    assert result['results'][0]['url'] == 'https://example.com/page'


@pytest.mark.asyncio
async def test_perform_search_empty_query():
    result = await _perform_search('   ')
    assert result['results'] == []
    assert result['error'] == 'query 不能为空'


@pytest.mark.asyncio
async def test_perform_search_handles_timeout():
    def handler(request):
        raise httpx.TimeoutException('timeout')

    result = await _perform_search(
        'python',
        transport=httpx.MockTransport(handler),
    )
    assert result['results'] == []
    assert '超时' in result['error']
