# web_search MCP 服务测试
import base64

import httpx
import pytest

from mcp_servers.web_search_server import (
    _perform_search,
    _resolve_bing_url,
    parse_bing_results,
    parse_search_results,
)

SAMPLE_HTML = '<div><a class=result__a href=//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage>Example &amp; Test</a><a class=result__snippet href=//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage>A <b>snippet</b> here.</a></div>'

# Bing 结果页样本：两条有效结果（一条带摘要、一条协议相对地址）+ 一条无标题无链接的块
BING_SAMPLE_HTML = (
    '<ol id="b_results">'
    '<li class="b_algo" data-id iid=SERP.1>'
    '<h2 class=""><a target="_blank" href="https://example.com/bing" h="ID=SERP,1">'
    '<strong>Bing</strong> 标题</a></h2>'
    '<div class="b_caption"><p class="b_lineclamp2">Bing 摘要 文本。</p></div>'
    '</li>'
    '<li class="b_algo"><h2><a href="//example.org/b">B 标题</a></h2></li>'
    '<li class="b_algo"><h2></h2></li>'
    '</ol>'
)


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


# ─── Bing 提供方 ────────────────────────────────────────────────────────────


def test_parse_bing_results_extracts_fields():
    results = parse_bing_results(BING_SAMPLE_HTML, max_results=5)
    assert len(results) == 2
    assert results[0] == {
        'title': 'Bing 标题',
        'url': 'https://example.com/bing',
        'snippet': 'Bing 摘要 文本。',
    }
    # 协议相对地址补全；没有标题或链接的块被丢弃（宁缺勿错）
    assert results[1]['url'] == 'https://example.org/b'
    assert results[1]['snippet'] == ''


def test_parse_bing_results_limits_results():
    assert parse_bing_results(BING_SAMPLE_HTML, max_results=1) == (
        parse_bing_results(BING_SAMPLE_HTML, max_results=5)[:1]
    )
    assert parse_bing_results(BING_SAMPLE_HTML, max_results=0) == []


def test_resolve_bing_url_unwraps_redirect():
    """Bing 的 /ck/a 跳转要还原成真实 URL——引用里不能出现跳转壳地址。"""
    encoded = base64.urlsafe_b64encode(b'https://example.com/x').decode()
    assert (
        _resolve_bing_url(f'https://www.bing.com/ck/a?u=a1{encoded}&ntb=1')
        == 'https://example.com/x'
    )
    assert _resolve_bing_url('') == ''
    assert _resolve_bing_url('//example.org/b') == 'https://example.org/b'
    assert _resolve_bing_url('https://example.com/plain') == 'https://example.com/plain'
    # 还原不出来时保留原样，不静默丢掉这条结果
    assert (
        _resolve_bing_url('https://www.bing.com/ck/a?u=%%%')
        == 'https://www.bing.com/ck/a?u=%%%'
    )


# ─── 多源回退链 ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_chain_stops_at_first_provider_with_results(monkeypatch):
    """命中即返回：Tavily 有结果时不再请求后面的提供方。"""
    fake = {
        'query': 'python',
        'results': [{'title': 'T', 'url': 'https://t', 'snippet': 'S'}],
        'source': 'tavily',
    }
    monkeypatch.setattr(
        'mcp_servers.web_search_server._tavily_search',
        lambda query, max_results: fake,
    )

    def handler(request):
        raise AssertionError(f'不应请求后续提供方：{request.url}')

    result = await _perform_search(
        'python', max_results=1, transport=httpx.MockTransport(handler)
    )
    assert result['source'] == 'tavily'
    assert result['attempts'] == ('tavily',)
    assert result['total'] == 1


@pytest.mark.asyncio
async def test_chain_falls_back_to_bing_when_tavily_has_no_results():
    """Tavily 无结果（未配置密钥 / 配额耗尽）时回落 Bing，而不是直接返回空。"""
    def handler(request):
        assert request.url.host.endswith('bing.com')
        assert request.url.params['q'] == 'python'
        return httpx.Response(200, text=BING_SAMPLE_HTML, request=request)

    result = await _perform_search(
        'python', max_results=2, transport=httpx.MockTransport(handler)
    )
    assert result['source'] == 'bing'
    assert result['attempts'] == ('tavily', 'bing')
    assert result['total'] == 2
    assert result['results'][0]['url'] == 'https://example.com/bing'


@pytest.mark.asyncio
async def test_chain_falls_back_to_duckduckgo_when_bing_has_no_results():
    """Bing 也没结果时继续落到 DuckDuckGo——链要一路走到底。"""
    def handler(request):
        if request.url.host.endswith('bing.com'):
            return httpx.Response(200, text='<ol id="b_results"></ol>', request=request)
        return httpx.Response(200, text=SAMPLE_HTML, request=request)

    result = await _perform_search(
        'python', max_results=1, transport=httpx.MockTransport(handler)
    )
    assert result['source'] == 'duckduckgo'
    assert result['attempts'] == ('tavily', 'bing', 'duckduckgo')
    assert result['results'][0]['url'] == 'https://example.com/page'


@pytest.mark.asyncio
async def test_chain_reports_every_provider_when_all_fail():
    """全部提供方失败时汇总各家原因，便于定位是哪一层不可用。"""
    def handler(request):
        return httpx.Response(503, request=request)

    result = await _perform_search('python', transport=httpx.MockTransport(handler))
    assert result['results'] == []
    assert result['total'] == 0
    assert result['source'] is None
    assert result['attempts'] == ('tavily', 'bing', 'duckduckgo')
    for label in ('Tavily', 'Bing', 'DuckDuckGo'):
        assert label in result['error']
