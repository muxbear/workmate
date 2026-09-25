"""core 包：基础设施层。

子模块**按需导入**（PEP 562），不在包初始化时拉起：``core.cache`` 与 ``core.security``
会反向读取 ``agent.config.settings``，而 agent 侧现在也依赖 ``core.config``——包初始化
时若提前导入它们，就会形成

    agent.config → core.config → core.cache → agent.config

的环，而且**只在从 agent 侧入口导入时炸**（应用、运维脚本、评测脚本都从那边进来），
从 core 侧入口反而正常，属于"换个入口就 500"的那类问题。惰性导出保留
``from core import KeyValueCache`` 这类写法，行为与直接导入子模块一致。
"""

from importlib import import_module
from typing import Any

#: 包级导出 → 定义它的子模块
_LAZY_EXPORTS: dict[str, str] = {
    "KeyValueCache": "core.cache",
    "create_cache": "core.cache",
    "cached": "core.decorators",
    "handle_errors": "core.decorators",
    "log_call": "core.decorators",
    "rate_limit": "core.decorators",
    "retry": "core.decorators",
    "ApiResponse": "core.response",
    "error": "core.response",
    "ok": "core.response",
    "create_token_pair": "core.security",
    "decode_token": "core.security",
    "decrypt_password": "core.security",
    "get_public_key": "core.security",
    "hash_password": "core.security",
    "verify_password": "core.security",
}

__all__ = sorted(_LAZY_EXPORTS)


def __getattr__(name: str) -> Any:
    """按需导入子模块中的名字（PEP 562）。"""
    module_name = _LAZY_EXPORTS.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    return getattr(import_module(module_name), name)


def __dir__() -> list[str]:
    """让 ``dir(core)`` 仍列出全部导出名（IDE 补全与调试用）。"""
    return list(__all__)
