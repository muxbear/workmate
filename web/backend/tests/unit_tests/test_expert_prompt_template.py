"""内置专家「使用提示词模板」下发（方案 P1-9）。

桌面端把该模板插入输入框作为主智能体的委派指令；此前服务端恒返回空串，
桌面端只能退回本地兜底文案，导致主智能体只回摘要、丢掉专家产出里的
Markdown 图片 / <video> 标签。
"""

from api.experts.service import BUILTIN_EXPERTS, builtin_prompt_template


def test_builtin_experts_declare_prompt_template() -> None:
    """两个内置专家都声明了模板，且带客户端可替换的占位符。"""
    for name in ("文档写作专家", "视频创作专家"):
        template = builtin_prompt_template(name)
        assert template, name
        assert "{name}" in template
        assert "{title}" in template


def test_template_requires_forwarding_expert_deliverable() -> None:
    """模板必须要求原样转发专家产出（否则交付物里的标签会被摘要掉）。"""
    template = builtin_prompt_template("视频创作专家")
    assert "原样保留" in template
    assert "<video>" in template
    assert "代码块" in template


def test_template_requires_full_requirements_on_delegation() -> None:
    """模板要求把用户硬性参数（时长/分辨率等）一并交代，避免专家按默认值返工。"""
    template = builtin_prompt_template("视频创作专家")
    assert "完整需求" in template
    assert "硬性参数" in template


def test_non_builtin_expert_has_empty_template() -> None:
    """自定义专家没有内置模板：客户端按空串走本地兜底。"""
    assert builtin_prompt_template("不存在的专家") == ""


def test_all_builtin_entries_use_shared_template() -> None:
    """内置条目直接声明模板，避免各处再写一份。"""
    for item in BUILTIN_EXPERTS:
        assert item.get("prompt_template"), item["name"]
