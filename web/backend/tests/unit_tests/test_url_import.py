"""URL / 网页导入的 SSRF 防护（迭代 6 T6.1）。

这是本轮唯一新增的**出网面**：让服务器去访问用户给的网址。守卫必须逐条钉死，
而且测试**绝不能真解析 DNS**——否则用例要么依赖外网、要么只能测字符串。

最重要的一条在最下面：**重定向到内网必须被拒，且不能真的发出第二个请求**。
只校验首跳是这类实现最常见的漏洞形态。
"""

from dataclasses import dataclass, field

import httpx
import pytest

from core.storage.safe_fetch import (
    FetchPolicy,
    UrlFetchError,
    check_url_static,
    decode_html,
    fetch_text_page,
    host_allowed,
    ip_is_public,
    suggested_filename,
    text_length,
)

pytestmark = pytest.mark.anyio

ALLOWED = ("example.com", "*.example.org")

#: 一块足够长的正文，避免撞上"正文有效性"的启发式阈值
_BODY = "这是一篇足够长的测试正文。" * 20


@dataclass
class _Recorder:
    """按路径路由的假传输层；记录**每一次真实发出的请求**。"""

    routes: dict[str, httpx.Response] = field(default_factory=dict)
    seen: list[httpx.Request] = field(default_factory=list)

    def transport(self) -> httpx.MockTransport:
        def handler(request: httpx.Request) -> httpx.Response:
            self.seen.append(request)
            response = self.routes.get(request.url.path)
            return response if response is not None else httpx.Response(404, text="nope")

        return httpx.MockTransport(handler)


class _Resolver:
    """假解析器：域名 → IP 列表；记录被问过的域名。"""

    def __init__(self, mapping: dict[str, list[str]]) -> None:
        self.mapping = mapping
        self.calls: list[str] = []

    async def __call__(self, host: str) -> list[str]:
        self.calls.append(host)
        return self.mapping.get(host, [])


def html_page(title: str = "示例页面", body: str = _BODY, charset: str = "utf-8") -> httpx.Response:
    document = (
        f"<html><head><meta charset=\"{charset}\"><title>{title}</title></head>"
        f"<body><p>{body}</p></body></html>"
    )
    return httpx.Response(
        200, content=document.encode(charset), headers={"content-type": f"text/html; charset={charset}"},
    )


# ─── 守卫：纯函数 ───────────────────────────────────────────────────────────


class TestIpGuard:
    @pytest.mark.parametrize("address", [
        "127.0.0.1", "10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.1",
        "169.254.169.254",   # 云元数据
        "100.100.100.200",   # 阿里云元数据（CGNAT 段）
        "0.0.0.0", "224.0.0.1", "255.255.255.255",
        "::1", "fe80::1", "fc00::1", "ff02::1",
        "::ffff:127.0.0.1",  # IPv4-mapped：不拆开就会以 IPv6 的形态溜过去
        "2002::1",
    ])
    def test_private_and_reserved_are_refused(self, address: str):
        assert ip_is_public(address) is False

    @pytest.mark.parametrize("address", ["1.1.1.1", "93.184.216.34", "8.8.8.8", "2606:4700::1111"])
    def test_public_addresses_are_allowed(self, address: str):
        assert ip_is_public(address) is True

    @pytest.mark.parametrize("garbage", ["", "not-an-ip", "999.1.1.1", "1.1.1.1.1"])
    def test_unparsable_is_refused(self, garbage: str):
        assert ip_is_public(garbage) is False


class TestHostAllowlist:
    def test_empty_rules_refuse_everything(self):
        """**默认拒绝**——与 asset_fetcher 的"空即放行"刻意相反。"""
        assert host_allowed("example.com", ()) is False

    def test_exact_rule(self):
        assert host_allowed("example.com", ALLOWED) is True
        assert host_allowed("Example.COM", ALLOWED) is True   # 大小写无关
        assert host_allowed("other.com", ALLOWED) is False

    def test_wildcard_matches_subdomains_only(self):
        assert host_allowed("a.example.org", ALLOWED) is True
        assert host_allowed("a.b.example.org", ALLOWED) is True
        # 裸域与"看起来像但不同"的域名都不能过
        assert host_allowed("example.org", ALLOWED) is False
        assert host_allowed("evilexample.org", ALLOWED) is False


class TestStaticUrlCheck:
    def policy(self, **kwargs) -> FetchPolicy:
        return FetchPolicy(allowed_hosts=ALLOWED, **kwargs)

    @pytest.mark.parametrize("url", [
        "file:///etc/passwd",
        "ftp://example.com/x",
        "data:text/html,<h1>x</h1>",
        "gopher://example.com/",
    ])
    def test_non_http_schemes_are_refused(self, url: str):
        with pytest.raises(UrlFetchError) as exc:
            check_url_static(url, self.policy())
        assert exc.value.reason == "scheme"

    def test_userinfo_is_refused(self):
        with pytest.raises(UrlFetchError) as exc:
            check_url_static("http://user:pw@example.com/", self.policy())
        assert exc.value.reason == "userinfo"

    def test_host_outside_allowlist_is_refused(self):
        with pytest.raises(UrlFetchError) as exc:
            check_url_static("https://evil.com/", self.policy())
        assert exc.value.reason == "host_not_allowed"

    def test_non_standard_port_is_refused(self):
        """``:9200`` 这类端口是内网服务探测的常见目标。"""
        with pytest.raises(UrlFetchError) as exc:
            check_url_static("http://example.com:9200/", self.policy())
        assert exc.value.reason == "port_not_allowed"

    def test_standard_ports_pass(self):
        assert check_url_static("https://example.com/x", self.policy()).host == "example.com"
        assert check_url_static("http://example.com:80/x", self.policy()).host == "example.com"


# ─── 抓取：注入 transport 与 resolver ───────────────────────────────────────


class TestFetch:
    def policy(self, **kwargs) -> FetchPolicy:
        return FetchPolicy(allowed_hosts=ALLOWED, **kwargs)

    async def test_not_configured_when_no_hosts(self):
        """白名单为空 → 连解析都不做，直接说清怎么开。"""
        recorder = _Recorder()
        with pytest.raises(UrlFetchError) as exc:
            await fetch_text_page(
                "https://example.com/", FetchPolicy(), transport=recorder.transport(),
            )
        assert exc.value.reason == "not_configured"
        assert "KB_URL_IMPORT_ALLOWED_HOSTS" in exc.value.message
        assert recorder.seen == []

    async def test_successful_fetch_pins_ip_and_keeps_host_header(self):
        recorder = _Recorder({"/doc": html_page("导入示例")})
        resolver = _Resolver({"example.com": ["93.184.216.34"]})

        page = await fetch_text_page(
            "https://example.com/doc", self.policy(),
            transport=recorder.transport(), resolver=resolver,
        )

        assert page.final_url == "https://example.com/doc"
        assert page.suggested_name == "导入示例.html"
        assert "测试正文" in page.content.decode("utf-8")
        # 连接钉扎：请求打到已校验的 IP，Host 头仍是真实域名
        request = recorder.seen[0]
        assert request.url.host == "93.184.216.34"
        assert request.headers["host"] == "example.com"

    async def test_private_dns_answer_is_refused(self):
        recorder = _Recorder({"/": html_page()})
        resolver = _Resolver({"example.com": ["10.0.0.5"]})

        with pytest.raises(UrlFetchError) as exc:
            await fetch_text_page(
                "https://example.com/", self.policy(),
                transport=recorder.transport(), resolver=resolver,
            )

        assert exc.value.reason == "blocked_ip"
        assert recorder.seen == [], "被拒的地址不该发出任何请求"

    async def test_mixed_dns_answers_are_refused(self):
        """公网 + 内网双解析是 rebinding 的典型形态：任一不合格即拒。"""
        recorder = _Recorder({"/": html_page()})
        resolver = _Resolver({"example.com": ["93.184.216.34", "10.0.0.5"]})

        with pytest.raises(UrlFetchError) as exc:
            await fetch_text_page(
                "https://example.com/", self.policy(),
                transport=recorder.transport(), resolver=resolver,
            )

        assert exc.value.reason == "blocked_ip"

    async def test_redirect_to_metadata_endpoint_is_refused_before_request(self):
        """**本文件最重要的一条**：跳转后的地址必须重跑全部守卫。

        只校验首跳是这类实现最常见的漏洞形态——白名单里的站点只要回一个 302
        就能把服务器带去访问云元数据。
        """
        recorder = _Recorder({
            "/jump": httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data/"}),
        })
        resolver = _Resolver({"example.com": ["93.184.216.34"]})

        with pytest.raises(UrlFetchError) as exc:
            await fetch_text_page(
                "https://example.com/jump", self.policy(),
                transport=recorder.transport(), resolver=resolver,
            )

        assert exc.value.reason in ("host_not_allowed", "blocked_ip")
        # 只发了首跳那一个请求——重定向目标连碰都没碰
        assert [r.url.path for r in recorder.seen] == ["/jump"]

    async def test_redirect_to_another_allowed_host_is_followed(self):
        recorder = _Recorder({
            "/jump": httpx.Response(302, headers={"location": "/target"}),
            "/target": html_page("跳转后的页面"),
        })
        resolver = _Resolver({"example.com": ["93.184.216.34"]})

        page = await fetch_text_page(
            "https://example.com/jump", self.policy(),
            transport=recorder.transport(), resolver=resolver,
        )

        assert page.final_url == "https://example.com/target"
        assert page.suggested_name == "跳转后的页面.html"

    async def test_too_many_redirects_is_refused(self):
        recorder = _Recorder({
            f"/r{i}": httpx.Response(302, headers={"location": f"/r{i + 1}"})
            for i in range(5)
        })
        resolver = _Resolver({"example.com": ["93.184.216.34"]})

        with pytest.raises(UrlFetchError) as exc:
            await fetch_text_page(
                "https://example.com/r0", self.policy(max_redirects=2),
                transport=recorder.transport(), resolver=resolver,
            )

        assert exc.value.reason == "too_many_redirects"

    async def test_non_text_content_type_is_refused(self):
        recorder = _Recorder({
            "/x.pdf": httpx.Response(
                200, content=b"%PDF-1.4", headers={"content-type": "application/pdf"},
            ),
        })
        resolver = _Resolver({"example.com": ["93.184.216.34"]})

        with pytest.raises(UrlFetchError) as exc:
            await fetch_text_page(
                "https://example.com/x.pdf", self.policy(),
                transport=recorder.transport(), resolver=resolver,
            )

        assert exc.value.reason == "not_text"
        assert "pdf" in exc.value.message

    async def test_streaming_size_cap_stops_oversized_body(self):
        """声明值不可信：Content-Length 撒谎时也要在读取途中卡住。"""
        recorder = _Recorder({
            "/big": httpx.Response(
                200,
                content=b"<html><body>" + b"x" * 5000 + b"</body></html>",
                headers={"content-type": "text/html", "content-length": "10"},
            ),
        })
        resolver = _Resolver({"example.com": ["93.184.216.34"]})

        with pytest.raises(UrlFetchError) as exc:
            await fetch_text_page(
                "https://example.com/big", self.policy(max_bytes=1024),
                transport=recorder.transport(), resolver=resolver,
            )

        assert exc.value.reason == "too_large"

    async def test_declared_size_is_refused_early(self):
        recorder = _Recorder({
            "/big": httpx.Response(
                200, content=b"x" * 4096,
                headers={"content-type": "text/html", "content-length": "4096"},
            ),
        })
        resolver = _Resolver({"example.com": ["93.184.216.34"]})

        with pytest.raises(UrlFetchError) as exc:
            await fetch_text_page(
                "https://example.com/big", self.policy(max_bytes=1024),
                transport=recorder.transport(), resolver=resolver,
            )

        assert exc.value.reason == "too_large"

    async def test_page_without_meaningful_text_is_refused(self):
        """SPA / 登录跳转页会入库成 0 切片文档，宁可明确拒绝。"""
        recorder = _Recorder({
            "/spa": httpx.Response(
                200, content=b"<html><body><div id=app></div></body></html>",
                headers={"content-type": "text/html"},
            ),
        })
        resolver = _Resolver({"example.com": ["93.184.216.34"]})

        with pytest.raises(UrlFetchError) as exc:
            await fetch_text_page(
                "https://example.com/spa", self.policy(),
                transport=recorder.transport(), resolver=resolver,
            )

        assert exc.value.reason == "empty_content"

    async def test_http_error_is_reported(self):
        recorder = _Recorder({"/gone": httpx.Response(410, text="gone")})
        resolver = _Resolver({"example.com": ["93.184.216.34"]})

        with pytest.raises(UrlFetchError) as exc:
            await fetch_text_page(
                "https://example.com/gone", self.policy(),
                transport=recorder.transport(), resolver=resolver,
            )

        assert exc.value.reason == "http_error"


class TestContentHandling:
    def test_gbk_page_is_transcoded_to_utf8(self):
        """GBK 页面必须转码：下游 BSHTMLLoader 写死了 open_encoding="utf-8"。

        不转码的表现是**整篇乱码且不报错**，是最难被发现的一类问题。
        """
        raw = "<html><body><p>中文内容测试</p></body></html>".encode("gbk")

        text, encoding = decode_html(raw, None)   # 没有 charset 声明，靠 meta/兜底

        assert "中文内容测试" in text
        assert text.encode("utf-8").decode("utf-8") == text

    def test_declared_charset_wins(self):
        raw = "<html><body>中文</body></html>".encode("gbk")
        text, encoding = decode_html(raw, "gbk")
        assert encoding == "gbk"
        assert "中文" in text

    def test_text_length_ignores_scripts_and_tags(self):
        html = "<html><script>var x = 1;</script><body><p>正文</p></body></html>"
        assert text_length(html) == len("正文")

    def test_suggested_name_falls_back_to_host_and_path(self):
        name = suggested_filename("<html><body>无标题</body></html>", "https://example.com/a/b/report.htm")
        assert name == "example.com-report.html", "htm 不在白名单里，一律叫 .html"

    def test_suggested_name_strips_path_separators(self):
        name = suggested_filename("<title>a/b:c*d</title>", "https://example.com/")
        assert "/" not in name and ":" not in name and "*" not in name
        assert name.endswith(".html")
