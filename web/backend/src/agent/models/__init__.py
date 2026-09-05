"""Agent model singletons with lazy embeddings loading."""

from typing import Any

from agent.models.llm import llm

__all__ = ['llm', 'embeddings']


def __getattr__(name: str) -> Any:
    """Lazily expose embeddings so resolving only the LLM does not require embedding credentials."""
    if name == 'embeddings':
        from agent.models.em import embeddings
        return embeddings
    raise AttributeError(f'module {__name__!r} has no attribute {name!r}')
