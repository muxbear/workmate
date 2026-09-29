"""语义化版本号工具测试（core/versioning.py）.

`bump_patch` / `is_newer_version` 的既有用例在 test_expert_version.py 与
test_builtin_expert_seeding.py 里（它们经由 `api.experts.service` 的再导出导入，
顺带锁住「抽取到 core 之后导入路径不变」这件事）。这里只补次版本递增与
re-export 的一致性。
"""

from itertools import pairwise

import pytest

from api.experts.service import (
    DEFAULT_VERSION,
    bump_patch,
    is_newer_version,
)
from core import versioning


class TestBumpMinor:
    """`bump_minor`：递增次版本号，修订号归零."""

    @pytest.mark.parametrize(
        ("version", "expected"),
        [
            ("1.2.3", "1.3.0"),
            ("1.0.0", "1.1.0"),
            ("0.0.1", "0.1.0"),
            ("2.9.9", "2.10.0"),
            ("1.2.3-beta.1", "1.3.0"),
            ("1.2.3+build7", "1.3.0"),
        ],
    )
    def test_increments_minor_and_resets_patch(self, version: str, expected: str) -> None:
        assert versioning.bump_minor(version) == expected

    @pytest.mark.parametrize("version", [None, "", "abc", "1.2", "v1.2.3"])
    def test_invalid_input_falls_back_to_default(self, version: str | None) -> None:
        assert versioning.bump_minor(version) == DEFAULT_VERSION

    def test_repeated_bumps_are_monotonic(self) -> None:
        """连续递增不会回退（编辑弹窗每次打开都在上一次结果上再递增）。"""
        version = DEFAULT_VERSION
        seen = [version]
        for _ in range(5):
            version = versioning.bump_minor(version)
            seen.append(version)
        assert seen == ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0"]
        assert all(
            is_newer_version(later, earlier) for earlier, later in pairwise(seen)
        )


def test_experts_service_reexports_core_helpers() -> None:
    """专家模块的导入路径保持可用，且与 core 是同一份实现。"""
    assert DEFAULT_VERSION == versioning.DEFAULT_VERSION
    assert bump_patch is versioning.bump_patch
    assert is_newer_version is versioning.is_newer_version
    assert bump_patch("1.2.3") == versioning.bump_patch("1.2.3")
