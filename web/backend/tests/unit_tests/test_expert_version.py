"""专家语义化版本号测试（bump_patch / Schema 校验 / 响应默认值 / 同步载荷）。."""

import asyncio
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from api.experts.schemas import ExpertCreateRequest, ExpertInfo, ExpertUpdateRequest
from api.experts.service import DEFAULT_VERSION, ExpertAssembler, bump_patch


def _make_info(**overrides: object) -> ExpertInfo:
    """构造一个可用的 ExpertInfo（仅覆盖需要断言的字段）。"""
    now = datetime.now(UTC).replace(tzinfo=None)
    payload: dict = {
        "id": "e1",
        "name": "测试专家",
        "title": "测试",
        "description": "",
        "category": "custom",
        "tags": [],
        "icon": "",
        "color": "",
        "initials": "测",
        "rating": 0,
        "usage_count": 0,
        "featured": False,
        "sort_order": 0,
        "is_published": True,
        "status": "active",
        "system_prompt": "",
        "created_at": now,
        "updated_at": now,
    }
    payload.update(overrides)
    return ExpertInfo.model_validate(payload)


class TestBumpPatch:
    """`bump_patch`：递增语义化版本号的修订号。"""

    @pytest.mark.parametrize(
        ("version", "expected"),
        [
            ("1.0.0", "1.0.1"),
            ("1.2.3", "1.2.4"),
            ("1.0.9", "1.0.10"),
            ("9.9.9", "9.9.10"),
        ],
    )
    def test_increments_patch_only(self, version: str, expected: str) -> None:
        """只递增修订号，主版本与次版本保持不变。"""
        assert bump_patch(version) == expected

    @pytest.mark.parametrize(
        "version",
        ["1.2.3-beta.1", "1.2.3+build", "1.2.3-rc.1+build.5"],
    )
    def test_drops_prerelease_and_build_metadata(self, version: str) -> None:
        """预发布标识与构建元数据在递增后丢弃。"""
        assert bump_patch(version) == "1.2.4"

    @pytest.mark.parametrize("version", [None, "", "abc", "1.2", "v1.2.3"])
    def test_falls_back_to_default(self, version: str | None) -> None:
        """缺失或非法输入回退到默认版本。"""
        assert bump_patch(version) == DEFAULT_VERSION


class TestVersionSchema:
    """请求体中的版本号格式校验。"""

    def test_create_defaults_to_initial_version(self) -> None:
        """新建专家未指定版本号时默认 1.0.0。"""
        req = ExpertCreateRequest(name="测试专家", title="测试")
        assert req.version == DEFAULT_VERSION

    def test_update_defaults_to_none(self) -> None:
        """更新请求缺省时保持 None，避免把版本静默重置为 1.0.0。"""
        req = ExpertUpdateRequest(name="测试专家", title="测试")
        assert req.version is None

    @pytest.mark.parametrize("version", ["1.0.0", "10.20.30", "1.2.3-beta.1", "1.2.3+build"])
    def test_accepts_valid_versions(self, version: str) -> None:
        """接受标准语义化版本号。"""
        req = ExpertUpdateRequest(name="测试专家", title="测试", version=version)
        assert req.version == version

    @pytest.mark.parametrize("version", ["", "1.2", "1.2.3.4", "v1.2.3", "abc"])
    def test_rejects_invalid_versions(self, version: str) -> None:
        """拒绝非语义化版本号，避免脏数据写进卡片徽标。"""
        with pytest.raises(ValidationError):
            ExpertUpdateRequest(name="测试专家", title="测试", version=version)


class TestExpertInfoDefault:
    """`ExpertInfo` 的 version 必须带默认值。"""

    def test_version_has_default(self) -> None:
        """不传 version 也能构造 ExpertInfo（存量调用方无需同步改造）。"""
        assert _make_info().version == DEFAULT_VERSION


class TestSyncItemVersion:
    """同步载荷必须带上版本号，供桌面端比对后决定是否覆盖本地副本。"""

    def test_sync_item_carries_version(self) -> None:
        """专家版本透传到 ExpertSyncItem。"""
        item = asyncio.run(ExpertAssembler.to_sync_item(_make_info(version="1.2.3")))
        assert item.version == "1.2.3"

    def test_sync_item_falls_back_to_default(self) -> None:
        """库中版本为空的存量专家回落默认版本，避免客户端拿到空版本号。"""
        item = asyncio.run(ExpertAssembler.to_sync_item(_make_info(version="")))
        assert item.version == DEFAULT_VERSION
