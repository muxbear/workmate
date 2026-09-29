"""语义化版本号工具——统一的递增、解析与比较口径。

原先这几个函数长在 `api/experts/service.py` 里，只有专家一个调用方。定时任务模板
也需要版本号（编辑默认递增次版本），若就地复制会出现第二份口径。这里抽出公共实现，
专家与模板共用一份。

约定：**客户端传了版本号就用客户端的**，服务端的 `bump_*` 只作为「调用方未传」时的
兜底——编辑弹窗里默认值由前端算好并允许手工修改。
"""

from __future__ import annotations

import re

#: 版本号缺省值（新建资源时的起点）
DEFAULT_VERSION = "1.0.0"

#: 只匹配前三段数字，预发布标识与构建元数据（`-beta.1` / `+build`）不参与递增与比较
_VERSION_PATTERN = re.compile(r"^(\d+)\.(\d+)\.(\d+)")


def bump_patch(version: str | None) -> str:
    """递增语义化版本号的修订号（patch）：1.2.3 -> 1.2.4.

    预发布标识与构建元数据（``1.2.3-beta.1`` / ``1.2.3+build``）在递增后丢弃。
    非法或缺失的输入回退到 ``1.0.0``。
    """
    match = _VERSION_PATTERN.match(version or "")
    if match is None:
        return DEFAULT_VERSION
    major, minor, patch = match.groups()
    return f"{major}.{minor}.{int(patch) + 1}"


def bump_minor(version: str | None) -> str:
    """递增语义化版本号的次版本号（minor）：1.2.3 -> 1.3.0.

    次版本递增时修订号归零，预发布标识与构建元数据同样丢弃。
    非法或缺失的输入回退到 ``1.0.0``。
    """
    match = _VERSION_PATTERN.match(version or "")
    if match is None:
        return DEFAULT_VERSION
    major, minor, _patch = match.groups()
    return f"{major}.{int(minor) + 1}.0"


def version_key(version: str | None) -> tuple[int, int, int]:
    """把语义化版本号解析为可比较的数值三元组；非法或缺失回退 0.0.0。."""
    match = _VERSION_PATTERN.match(version or "")
    if match is None:
        return (0, 0, 0)
    major, minor, patch = match.groups()
    return (int(major), int(minor), int(patch))


def is_newer_version(candidate: str | None, current: str | None) -> bool:
    """判断 candidate 是否比 current 更新（预发布标识不参与比较，与桌面端一致）。

    内置资源的种子用它做**版本单调推进**：只有声明版本更高时才写库，
    既能把定义变更推给各端重新同步，也不会把界面上手工调高的版本号回退掉。
    """
    return version_key(candidate) > version_key(current)
