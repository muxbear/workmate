"""安全地抓取远端**文本页面**（迭代 6 T6.1 的 URL 导入）。

为什么另起一条路，而不是复用仓库里既有的三处抓取实现：

- ``core/storage/asset_fetcher.fetch_asset`` 是素材（图片/视频）代理下载。它只把
  URL 字符串里的 host 与白名单比一下，**从不解析 DNS、没有任何 IP 判定**，白名单
  为空还是"放行"；重定向只在发起前校验一次，跳转后的目标主机不再检查。对"下载一张
  图"或许够用（自建部署合法地从内网拉图是常态），对"让服务器去访问用户给的任意
  网址"远远不够。
- ``agent/tools/web_scraper.py`` 是裸 ``urllib.request.urlopen``，零防护。
- ``agent/tools/http_request.py`` 用黑名单（``localhost``/``127.0.0.1``/``0.0.0.0``/
  ``::1`` + ``10.``/``192.168.`` 前缀），漏掉 ``169.254.169.254``（云元数据）、
  ``172.16/12``、IPv6 私网与 ULA、十进制 IP，且重定向同样不复检。

本模块的默认值与 ``asset_fetcher`` **刻意相反**：白名单为空 = **拒绝一切**
（而不是放行）。三处旧实现的收口（统一出网出口、各自显式声明是否允许内网）记在
安全待办里，不在本轮范围。

防护清单（逐条对应实现）：

1. 仅 ``http``/``https``；拒绝带 userinfo 的地址；长度上限；
2. 端口仅白名单（默认 80/443），挡掉 ``:9200`` 这类内网服务探测；
3. **域名白名单默认拒绝**，支持 ``*.example.com``（用 ``endswith(".example.com")``
   匹配，``evilexample.com`` 不会过）；
4. **解析 DNS 后逐个 IP 判定**，任一落在内网/保留网段即整体拒绝（"公网 + 内网
   双解析"正是 DNS rebinding 的形态）；IPv4-mapped 的 IPv6 先拆成 v4 再判；
5. **每一跳重定向都完整重跑 1–4**；
6. **连接钉扎**：连到已校验的 IP，同时带真实域名的 ``Host`` 与 TLS SNI
   （``sni_hostname`` 扩展）——校验与连接之间不存在第二次解析；
7. **流式大小上限**：``Content-Length`` 只作提前拒绝的加速项（可能缺失或撒谎），
   真正的上限靠边读边累计；
8. ``trust_env=False``：环境里的 ``HTTP(S)_PROXY`` 会让代理解析 DNS、把 4/6 全部
   绕过；
9. 内容类型限文本；**解码后重新按 UTF-8 编码**——下游的 ``BSHTMLLoader`` 写死了
   ``open_encoding="utf-8"``，GBK 页面不转码会整篇乱码（且不报错，最难发现）。

**残余风险（如实标注）**：钉扎关掉了"校验后换 IP"的窗口，但白名单里的域名若解析到
**另一个公网**主机，抓到的内容就是那台主机的——白名单本身就是运维的信任声明，属可
接受的残余。另外本模块**只做文本抽取前的抓取**：解析阶段用的是 ``BSHTMLLoader``，
它不会去取 ``<img>``/``<link>`` 等子资源，因此不会引入二次出网。
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import re
import socket
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)

#: 域名解析器：域名 → IP 列表。可注入——SSRF 的用例绝不能依赖真 DNS
Resolver = Callable[[str], Awaitable[list[str]]]

_MAX_URL_LEN = 2048
_DEFAULT_PORTS = (80, 443)

#: 可接受的文本内容类型
_TEXT_CONTENT_TYPES = frozenset({
    "text/html", "application/xhtml+xml", "text/plain", "text/markdown",
})

#: 正文有效性阈值（去掉标签后的非空白字符数）。低于它多半是"需要 JS 渲染的单页
#: 应用"或登录跳转页——宁可明确拒绝，也别入库一篇 0 切片的空文档。这是启发式，
#: 不是精确判据。
_MIN_TEXT_CHARS = 120

#: 内网 / 保留网段。**显式列出，不只依赖 ipaddress 的 is_private/is_global**：
#: 不同 Python 版本对这些网段的归类并不一致（100.64/10、2002::/16 都变过），
#: 安全判定不能建立在"这个版本恰好这么判"上。
#: 169.254.169.254（云元数据）落在 169.254/16；100.100.100.200（阿里云元数据）
#: 落在 100.64/10——删网段前先想清楚这两条。
_BLOCKED_NETWORKS = tuple(ipaddress.ip_network(c) for c in (
    # IPv4
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
    "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24",
    "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
    "224.0.0.0/4", "240.0.0.0/4",
    # IPv6
    "::/128", "::1/128", "::ffff:0:0/96", "64:ff9b::/96", "100::/64",
    "2001:db8::/32", "2002::/16", "fc00::/7", "fe80::/10", "ff00::/8",
))

_TAG_RE = re.compile(r"<[^>]+>")
_DROP_RE = re.compile(r"<(script|style)\b.*?</\1>", re.IGNORECASE | re.DOTALL)
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_META_CHARSET_RE = re.compile(
    rb"""<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9_\-]+)""", re.IGNORECASE,
)


class UrlFetchError(Exception):
    """抓取失败。``reason`` 是机器可读短码，``message`` 面向用户（可直接展示）。"""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason
        self.message = message


@dataclass(frozen=True)
class FetchPolicy:
    """抓取策略。**默认拒绝**：``allowed_hosts`` 为空时不抓任何地址。"""

    allowed_hosts: tuple[str, ...] = ()
    allowed_ports: tuple[int, ...] = _DEFAULT_PORTS
    max_bytes: int = 10 * 1024 * 1024
    timeout: float = 15.0
    max_redirects: int = 3
    user_agent: str = "ke-hermes-url-import/1.0"


@dataclass(frozen=True)
class FetchedPage:
    """抓取的页面——``content`` 已转码为 UTF-8，可直接落盘。"""

    content: bytes
    final_url: str
    content_type: str
    suggested_name: str
    declared_encoding: str | None = None


# ─── 守卫（纯函数，最容易测、也最该测）──────────────────────────────────────


def host_allowed(host: str, rules: Sequence[str]) -> bool:
    """域名白名单匹配；**空规则 = 拒绝**（与 ``asset_fetcher`` 的空即放行相反）。

    ``*.example.com`` 只匹配子域，不匹配裸域（与 ``asset_fetcher._host_allowed``
    的既有语义一致）；用 ``endswith(".example.com")`` 而不是裸后缀，否则
    ``evilexample.com`` 会被放行。
    """
    host = (host or "").strip().lower().rstrip(".")
    if not host or not rules:
        return False
    for rule in rules:
        candidate = (rule or "").strip().lower().rstrip(".")
        if not candidate:
            continue
        if candidate.startswith("*."):
            if host.endswith(candidate[1:]):
                return True
        elif host == candidate:
            return True
    return False


def ip_is_public(raw_ip: str) -> bool:
    """该地址是否属于"可以安全访问的公网"。

    IPv4-mapped 的 IPv6（``::ffff:127.0.0.1``）先拆成 v4 再判——否则回环地址会以
    IPv6 的形态溜过去。
    """
    try:
        ip = ipaddress.ip_address((raw_ip or "").strip())
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return not any(ip in network for network in _BLOCKED_NETWORKS)


def check_url_static(url: str, policy: FetchPolicy) -> httpx.URL:
    """静态校验（不解析 DNS）：协议 / 长度 / userinfo / 端口 / 域名白名单。"""
    if not url or len(url) > _MAX_URL_LEN:
        raise UrlFetchError("bad_url", "地址为空或过长")
    try:
        parsed = httpx.URL(url)
    except Exception as exc:  # noqa: BLE001 - 非法 URL 一律按"地址不合法"处理
        raise UrlFetchError("bad_url", "地址格式不正确") from exc

    if parsed.scheme not in ("http", "https"):
        raise UrlFetchError("scheme", f"只支持 http/https 地址（收到 {parsed.scheme or '空'}）")
    if parsed.userinfo:
        raise UrlFetchError("userinfo", "地址里不能带用户名或密码")
    host = parsed.host
    if not host:
        raise UrlFetchError("bad_url", "地址缺少主机名")
    if not host_allowed(host, policy.allowed_hosts):
        raise UrlFetchError(
            "host_not_allowed", f"{host} 不在允许导入的域名范围内",
        )
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if port not in policy.allowed_ports:
        raise UrlFetchError(
            "port_not_allowed",
            f"不支持的端口 {port}（仅允许 {', '.join(str(p) for p in policy.allowed_ports)}）",
        )
    return parsed


async def _default_resolver(host: str) -> list[str]:
    """默认解析器：线程里跑 ``getaddrinfo``（不阻塞事件循环）。"""
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    return [str(info[4][0]) for info in infos]


async def resolve_and_validate(
    parsed: httpx.URL, policy: FetchPolicy, resolver: Resolver | None = None,
) -> str:
    """解析域名并逐个 IP 判定；返回第一个可用 IP（供连接钉扎）。

    **任一**解析结果落在内网/保留网段就整体拒绝：只取第一个地址会把"公网 + 内网
    双解析"当成正常情况放过去。
    """
    host = parsed.host
    # 字面量 IP 不必解析（也避免解析器被绕过）
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        if not ip_is_public(host):
            raise UrlFetchError("blocked_ip", f"{host} 指向内网或保留地址，已拒绝")
        return host

    resolve = resolver or _default_resolver
    try:
        addresses = await resolve(host)
    except Exception as exc:  # noqa: BLE001 - 解析失败一律归为 DNS 问题
        raise UrlFetchError("dns_failed", f"域名解析失败：{host}") from exc
    if not addresses:
        raise UrlFetchError("dns_failed", f"域名解析无结果：{host}")
    for address in addresses:
        if not ip_is_public(address):
            raise UrlFetchError(
                "blocked_ip", f"{host} 解析到内网地址 {address}，已拒绝",
            )
    return addresses[0]


# ─── 内容处理 ───────────────────────────────────────────────────────────────


def _charset_from_content_type(content_type: str | None) -> str | None:
    if not content_type:
        return None
    for part in content_type.split(";")[1:]:
        key, _, value = part.strip().partition("=")
        if key.strip().lower() == "charset":
            return value.strip().strip('"').strip("'") or None
    return None


def decode_html(raw: bytes, declared: str | None = None) -> tuple[str, str]:
    """把响应体解码成文本，返回 ``(文本, 实际用的编码)``。

    顺序：响应头 charset → 页面 ``<meta charset>`` → UTF-8 → **GB18030** →
    UTF-8（``errors="replace"``）。

    中文站点里 GBK/GB2312 仍很常见，而下游解析器写死了 UTF-8——猜错编码的表现是
    **整篇乱码且不报错**，最难被发现。所以除了声明与 meta，还留一手：UTF-8 严格解码
    失败基本说明"这不是 UTF-8"，此时按 gb18030（gbk/gb2312 的超集）再试一次，
    比直接容错解码成乱码强得多。顺序不能颠倒——gb18030 几乎能解出任何字节，
    放在 UTF-8 前面会把正常的中文变成乱码。
    """
    candidates: list[str] = []
    if declared:
        candidates.append(declared)
    meta = _META_CHARSET_RE.search(raw[:4096])
    if meta:
        candidates.append(meta.group(1).decode("ascii", errors="ignore"))
    candidates.extend(("utf-8", "gb18030"))

    for encoding in candidates:
        try:
            return raw.decode(encoding), encoding
        except (LookupError, UnicodeDecodeError):
            continue
    # 全部失败时用 UTF-8 容错解码——宁可个别字符变成替换符，也别整篇失败
    return raw.decode("utf-8", errors="replace"), "utf-8"


def extract_title(html: str) -> str | None:
    """取 ``<title>``（正则足够，不做 DOM 解析）。"""
    match = _TITLE_RE.search(html)
    if not match:
        return None
    title = _TAG_RE.sub("", match.group(1))
    title = re.sub(r"\s+", " ", title).strip()
    return title or None


def text_length(html: str) -> int:
    """去掉脚本/样式/标签后的非空白字符数——正文有效性的启发式判据。"""
    stripped = _DROP_RE.sub(" ", html)
    text = _TAG_RE.sub(" ", stripped)
    return len(re.sub(r"\s+", "", text))


def suggested_filename(html: str, url: str, limit: int = 100) -> str:
    """建议的文件名：优先页面标题，否则 ``域名-路径末段``；**强制 ``.html``**。

    ``htm`` 不在后端的扩展名白名单里（``ALLOWED_EXTENSIONS``），按 URL 后缀命名会
    被判成未知类型而拒绝，所以这里统一叫 ``.html``。
    """
    name = extract_title(html)
    if not name:
        parsed = httpx.URL(url)
        segments = [s for s in parsed.path.split("/") if s]
        tail = segments[-1] if segments else ""
        name = f"{parsed.host}-{tail}" if tail else (parsed.host or "网页")
    # 只留基名与可打印字符：标题里出现 / : * 等字符时落盘会出问题
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name).strip(" ._") or "网页"
    # 去掉原有的文本类后缀再统一加 .html——否则 URL 末段是 report.htm 时会得到
    # "report.htm.html"
    stem = re.sub(r"\.(html?|xhtml|txt|markdown|md)$", "", name, flags=re.IGNORECASE)
    stem = stem.strip(" ._") or "网页"
    if len(stem) > limit:
        stem = stem[:limit]
    return f"{stem}.html"


# ─── 抓取 ───────────────────────────────────────────────────────────────────


async def fetch_text_page(
    url: str,
    policy: FetchPolicy,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    resolver: Resolver | None = None,
) -> FetchedPage:
    """抓取一个文本页面。

    Args:
        url: 目标地址。
        policy: 抓取策略（白名单为空时直接拒绝，连解析都不做）。
        transport: 可注入的传输层（测试用）。
        resolver: 可注入的域名解析器（测试用；**SSRF 用例绝不能真解析**）。

    Returns:
        内容已转码为 UTF-8 的 :class:`FetchedPage`。

    Raises:
        UrlFetchError: 任一道守卫不通过，或网络/内容处理失败。
    """
    if not policy.allowed_hosts:
        raise UrlFetchError(
            "not_configured",
            "URL 导入未启用：请在 .env 配置 KB_URL_IMPORT_ALLOWED_HOSTS"
            "（逗号分隔的域名白名单，支持 *.example.com）后重启服务",
        )

    timeout = httpx.Timeout(policy.timeout, connect=min(5.0, policy.timeout))
    current = url

    async with httpx.AsyncClient(
        timeout=timeout,
        transport=transport,
        # 环境里的 HTTP(S)_PROXY 会让代理解析 DNS，IP 校验与钉扎就全白做了
        trust_env=False,
    ) as client:
        for hop in range(policy.max_redirects + 1):
            parsed = check_url_static(current, policy)
            pinned_ip = await resolve_and_validate(parsed, policy, resolver)

            headers = {
                "User-Agent": policy.user_agent,
                "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9",
            }
            if pinned_ip != parsed.host:
                # 连的是 IP，但要让服务端与 TLS 都看到真实域名
                headers["Host"] = parsed.host
            extensions = (
                {"sni_hostname": parsed.host} if parsed.scheme == "https" else {}
            )

            try:
                async with client.stream(
                    "GET",
                    parsed.copy_with(host=pinned_ip),
                    headers=headers,
                    extensions=extensions,
                    follow_redirects=False,
                ) as response:
                    if response.status_code in (301, 302, 303, 307, 308):
                        location = response.headers.get("location")
                        if not location:
                            raise UrlFetchError("bad_redirect", "重定向响应缺少 Location")
                        if hop >= policy.max_redirects:
                            raise UrlFetchError(
                                "too_many_redirects",
                                f"重定向超过 {policy.max_redirects} 次",
                            )
                        # 相对跳转要按当前地址归一；**下一跳会完整重跑全部守卫**
                        current = str(httpx.URL(current).join(location))
                        logger.info("URL 导入跟随重定向（第 %d 跳）：%s", hop + 1, current)
                        continue

                    if response.status_code >= 400:
                        raise UrlFetchError(
                            "http_error", f"目标返回 HTTP {response.status_code}",
                        )

                    content_type = (response.headers.get("content-type") or "")
                    mime = content_type.split(";")[0].strip().lower()
                    if mime not in _TEXT_CONTENT_TYPES:
                        raise UrlFetchError(
                            "not_text",
                            f"链接指向的不是网页内容（Content-Type: {mime or '未知'}）",
                        )

                    declared_length = response.headers.get("content-length")
                    if declared_length and declared_length.isdigit() and (
                        int(declared_length) > policy.max_bytes
                    ):
                        raise UrlFetchError(
                            "too_large",
                            f"页面超过大小上限 {policy.max_bytes // (1024 * 1024)}MB",
                        )

                    chunks: list[bytes] = []
                    total = 0
                    async for chunk in response.aiter_bytes():
                        total += len(chunk)
                        if total > policy.max_bytes:
                            # 声明值可能缺失或撒谎，真正的上限只能边读边卡
                            raise UrlFetchError(
                                "too_large",
                                f"页面超过大小上限 {policy.max_bytes // (1024 * 1024)}MB",
                            )
                        chunks.append(chunk)
                    raw = b"".join(chunks)
                    declared_encoding = _charset_from_content_type(content_type)
            except UrlFetchError:
                raise
            except httpx.HTTPError as exc:
                raise UrlFetchError("network", f"访问失败：{type(exc).__name__}") from exc

            text, encoding = decode_html(raw, declared_encoding)
            if text_length(text) < _MIN_TEXT_CHARS:
                raise UrlFetchError(
                    "empty_content",
                    "页面没有可提取的正文，可能是需要 JS 渲染的单页应用",
                )
            logger.info(
                "URL 导入抓取成功：%s（%d 字节，编码 %s）", current, len(raw), encoding,
            )
            return FetchedPage(
                # 重新按 UTF-8 编码落盘：下游 BSHTMLLoader 写死了 open_encoding="utf-8"
                content=text.encode("utf-8"),
                final_url=current,
                content_type=mime,
                suggested_name=suggested_filename(text, current),
                declared_encoding=encoding,
            )

    raise UrlFetchError("too_many_redirects", "重定向次数超出上限")


__all__ = [
    "FetchPolicy",
    "FetchedPage",
    "Resolver",
    "UrlFetchError",
    "check_url_static",
    "decode_html",
    "extract_title",
    "fetch_text_page",
    "host_allowed",
    "ip_is_public",
    "resolve_and_validate",
    "suggested_filename",
    "text_length",
]
