"""专家提示词平台化渲染单元测试。"""

from api.experts.prompt_render import render_expert_prompt


def test_render_platform_variables() -> None:
    """交付目录、素材工具与平台说明按平台注入。"""
    template = "目录={{delivery_dir}} 工具={{asset_tool}} 说明={{platform_notes}}"

    web = render_expert_prompt(
        template, platform="web", delivery_dir="/artifacts/t/turn-1/"
    )
    assert "目录=/artifacts/t/turn-1/" in web
    assert "工具=download_asset" in web
    assert "Linux" in web

    desktop = render_expert_prompt(template, platform="desktop")
    assert "工具=download_asset" in desktop
    assert "本地工作区" in desktop
    assert "Linux" not in desktop


def test_render_keeps_unknown_placeholder() -> None:
    """未知占位符原样保留，模板写错变量名时不静默丢失。"""
    rendered = render_expert_prompt("a {{unknown_var}} b", platform="web")
    assert "{{unknown_var}}" in rendered


def test_builtin_doc_expert_prompt_is_platform_neutral() -> None:
    """内置「文档写作专家」提示词不含平台专属命令，并绑定素材工具。"""
    from api.experts.service import BUILTIN_EXPERTS

    doc = next(item for item in BUILTIN_EXPERTS if item["name"] == "文档写作专家")
    prompt = str(doc["system_prompt"])
    for banned in ("curl", "powershell", "PowerShell", "mkdir", "if not exist", "curl.exe"):
        assert banned not in prompt
    assert "{{asset_tool}}" in prompt
    assert "{{platform_notes}}" in prompt
    assert doc.get("capabilities") == ["image.generate", "document.assemble"]


def test_builtin_doc_expert_forbids_code_fence_article() -> None:
    """内置「文档写作专家」明确禁止把正文放进代码块（否则聊天区无法渲染配图）。"""
    from api.experts.service import BUILTIN_EXPERTS

    doc = next(item for item in BUILTIN_EXPERTS if item["name"] == "文档写作专家")
    prompt = str(doc["system_prompt"])

    assert "正文不要放进代码块" in prompt
    assert "![](" in prompt


def test_builtin_video_expert_prompt_is_platform_neutral() -> None:
    """内置「视频创作专家」提示词不含平台专属命令，并绑定素材工具。

    回归守卫：历史上该提示词硬编码了 Windows 命令行与反斜杠路径，
    在 Web 沙箱（Linux）与桌面默认分类（无 execute 工具）下都无法执行。
    """
    from api.experts.service import BUILTIN_EXPERTS

    video = next(item for item in BUILTIN_EXPERTS if item["name"] == "视频创作专家")
    prompt = str(video["system_prompt"])
    for banned in (
        "curl",
        "wget",
        "powershell",
        "PowerShell",
        "mkdir",
        "if not exist",
        "Invoke-WebRequest",
        "\\",
    ):
        assert banned not in prompt
    assert "{{asset_tool}}" in prompt
    assert "{{platform_notes}}" in prompt
    assert video.get("capabilities") == ["video.generate", "document.assemble"]


def test_builtin_video_expert_deliverable_contract() -> None:
    """内置「视频创作专家」声明了"文档 + 同名视频目录"的交付契约与可播放标签。"""
    from api.experts.service import BUILTIN_EXPERTS

    video = next(item for item in BUILTIN_EXPERTS if item["name"] == "视频创作专家")
    prompt = str(video["system_prompt"])

    assert "成片-1.mp4" in prompt
    assert "<video controls" in prompt
    assert "controls" in prompt
    assert "正文不要放进代码块" in prompt
    # 省成本档位可被显式要求（用于试片与端到端验证）
    assert "duration=2" in prompt
    assert "480P" in prompt


def test_platform_normalization_and_notes() -> None:
    """平台标识规范化：未知值回退 web；三个平台都有运行环境说明。"""
    from agent.experts.platforms import PLATFORMS, normalize_platform, platform_notes

    assert PLATFORMS == ("desktop", "web", "mobile")
    assert normalize_platform("MOBILE") == "mobile"
    assert normalize_platform("") == "web"
    assert normalize_platform("unknown-client") == "web"
    for name in PLATFORMS:
        assert platform_notes(name)
    # 移动端复用 Web 后端：沙箱口径一致，额外提示客户端通过产物接口取件
    assert "Linux" in platform_notes("mobile")
    assert "移动端" in platform_notes("mobile")


def test_render_can_skip_platform_notes() -> None:
    """图构建期渲染可关闭平台说明（改由请求级中间件按平台注入）。"""
    skipped = render_expert_prompt(
        "环境：{{platform_notes}}", platform="web", include_platform_notes=False
    )
    assert skipped == "环境："
    assert render_expert_prompt("环境：{{platform_notes}}", platform="web") != skipped
