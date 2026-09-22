"""平台定义与运行环境说明（agent 层，供提示词渲染与中间件共用）。

平台标识与 ``packages/expert-contract/contract.json`` 的 ``platforms`` 对齐；
把定义放在 agent 层，避免 agent 中间件反向依赖 api 层。
"""

from __future__ import annotations

# 支持的平台（与契约文件对齐）
PLATFORMS: tuple[str, ...] = ("desktop", "web", "mobile")

# 各平台运行环境说明（注入专家提示词 / 请求级指令）
PLATFORM_NOTES: dict[str, str] = {
    "web": (
        "运行环境是 Linux 沙箱：禁止使用 curl / wget / PowerShell 等命令下载图片，"
        "配图一律用素材工具保存；文件工具使用以 / 开头的虚拟绝对路径。"
    ),
    "desktop": (
        "运行环境是用户本地工作区：文件工具的虚拟根 / 即工作区目录，"
        "配图一律用素材工具保存到工作区，不要依赖 curl / PowerShell 下载图片。"
    ),
    "mobile": (
        "运行环境与 Web 版一致：智能体在服务端 Linux 沙箱中执行，"
        "配图一律用素材工具保存，禁止使用 curl / wget / PowerShell 等命令下载图片；"
        "客户端为移动端，交付物通过产物接口（HTTP 预览 / 下载 / 打包）获取，"
        "回复与文档中不要引用本地文件路径。"
    ),
}


def normalize_platform(raw: str | None) -> str:
    """规范化平台标识；空值或未知值回退 web。"""
    candidate = (raw or "").strip().lower()
    return candidate if candidate in PLATFORMS else "web"


def platform_notes(platform: str | None) -> str:
    """返回该平台的运行环境说明（未知平台回退 web）。"""
    return PLATFORM_NOTES.get(normalize_platform(platform), "")


__all__ = ["PLATFORMS", "PLATFORM_NOTES", "normalize_platform", "platform_notes"]
