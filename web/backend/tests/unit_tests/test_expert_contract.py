"""专家能力契约一致性测试（Python 镜像 ↔ packages/expert-contract/contract.json）。"""

import inspect
import json
import typing
from pathlib import Path

from agent.experts.capabilities import ALL_CAPABILITIES
from api.experts.prompt_render import DEFAULT_ASSET_TOOL

# 仓库根目录：web/backend/tests/unit_tests/<file> → parents[4]
_REPO_ROOT = Path(__file__).resolve().parents[4]
_CONTRACT_PATH = _REPO_ROOT / "packages" / "expert-contract" / "contract.json"

# 提示词渲染支持的变量（与 contract.json 的 promptVariables 对齐）
_PROMPT_VARIABLES = ("delivery_dir", "asset_tool", "platform_notes")


def _load_contract() -> dict:
    """读取契约文件。"""
    return json.loads(_CONTRACT_PATH.read_text(encoding="utf-8"))


def test_contract_file_exists() -> None:
    """契约文件存在且版本为 1。"""
    contract = _load_contract()
    assert contract["version"] == 1
    assert contract["deliverable"]["webDeliveryRoot"].startswith("/artifacts/")


def test_contract_declares_resource_patterns_for_images_and_videos() -> None:
    """交付物契约同时表达配图与成片的命名（成片名为 成片-N，此前只写了 figure-N）。"""
    deliverable = _load_contract()["deliverable"]
    patterns = deliverable["resourcePatterns"]
    assert patterns["image"] == "figure-{n}.{ext}"
    assert patterns["video"].startswith("成片-")
    assert deliverable["root"] == "<title>.md"
    assert deliverable["resourceDir"] == "<title>/"


def test_python_mirror_matches_contract() -> None:
    """Python 侧镜像（能力 / 变量 / 素材工具名）与契约一致。"""
    contract = _load_contract()
    assert list(ALL_CAPABILITIES) == contract["capabilities"]
    assert list(_PROMPT_VARIABLES) == contract["promptVariables"]
    assert DEFAULT_ASSET_TOOL == contract["assetTool"]


def test_sync_api_platforms_match_contract() -> None:
    """同步接口允许的平台与契约一致（新增平台需同步修改）。"""
    from api.experts.sync_api import expert_sync_list

    signature = inspect.signature(expert_sync_list)
    annotation = signature.parameters["platform"].annotation
    assert sorted(typing.get_args(annotation)) == sorted(_load_contract()["platforms"])


def test_prompt_render_supports_contract_variables() -> None:
    """提示词渲染支持契约声明的全部变量。"""
    from api.experts.prompt_render import render_expert_prompt

    template = " ".join("{{" + name + "}}" for name in _PROMPT_VARIABLES)
    rendered = render_expert_prompt(
        template, platform="web", delivery_dir="/artifacts/t/turn-1/"
    )
    assert "{{" not in rendered
    assert "/artifacts/t/turn-1/" in rendered
    assert DEFAULT_ASSET_TOOL in rendered


def test_all_contract_platforms_have_notes() -> None:
    """契约登记的平台都必须在服务端有运行环境说明（含移动端）。"""
    from agent.experts.platforms import platform_notes

    for name in _load_contract()["platforms"]:
        assert platform_notes(name), name
    assert "移动端" in platform_notes("mobile")
