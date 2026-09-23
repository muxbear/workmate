"""Agent 模型模块：对话模型按需从「模型」页面解析，embeddings 懒加载。.

对话模型没有模块级单例——它来自「模型」页面配置的提供商与模型，需要在请求时
异步查库解析，因此统一走 ``agent.models.resolver``：

>>> from agent.models.resolver import resolve_default_llm, resolve_llm
"""

from typing import Any

__all__ = ['embeddings']


def __getattr__(name: str) -> Any:
    """Lazily expose embeddings so resolving only the LLM does not require embedding credentials."""
    if name == 'embeddings':
        from agent.models.em import embeddings
        return embeddings
    raise AttributeError(f'module {__name__!r} has no attribute {name!r}')
