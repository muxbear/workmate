"""Agent 共享工具——消除 main_agent 与 subagents_operate 之间的代码重复。

所有关键导入使用懒加载以避免循环导入（agent ↔ api ↔ core ↔ db 之间的复杂依赖）。
"""

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from langchain_core.language_models import BaseChatModel

logger = logging.getLogger(__name__)


def get_tool_registry() -> dict[str, object]:
    """[已废弃] 使用 agent.tools.registry.get_tool_registry(db) 替代。

    过渡期：仍返回硬编码的工具列表，但发出 DeprecationWarning。

    这里显式从各子模块导入，而不是遍历 ``agent.tools.__all__``：包内曾把工具函数
    重导出到与子模块同名的属性上（如 ``agent.tools.kb_search``），既遮蔽了子模块，
    也让工具清单依赖导入顺序。
    """
    import warnings

    from agent.tools.get_datetime import get_datetime
    from agent.tools.http_request import http_request
    from agent.tools.kb_search import kb_search, list_knowledge_bases
    from agent.tools.tavily_search import tavily_search

    warnings.warn(
        "get_tool_registry() 已废弃，请使用 agent.tools.registry.get_tool_registry(db)",
        DeprecationWarning,
        stacklevel=2,
    )
    return {
        "get_datetime": get_datetime,
        "http_request": http_request,
        "kb_search": kb_search,
        "list_knowledge_bases": list_knowledge_bases,
        "tavily_search": tavily_search,
    }


async def resolve_model(
    provider_id: str | None,
    model_id: str | None,
) -> "BaseChatModel":
    """解析主智能体/子智能体/专家使用的 LLM 实例。

    - 同时给出 ``provider_id`` 与 ``model_id``：按该组合解析（失败抛 RuntimeError）；
    - 任一为空：解析「模型」页面配置的默认对话模型（显式 ``is_default`` 优先，
      否则按页面顺序兜底）。

    模型来源只有「模型」页面（``providers`` / ``ai_models``）一处，不再读环境变量。

    Raises:
        RuntimeError: 显式组合解析失败，或页面中没有任何可用对话模型。
    """
    # 懒加载以避免循环导入
    from agent.models.resolver import resolve_default_llm, resolve_llm

    if provider_id and model_id:
        return await resolve_llm(provider_id, model_id)

    if provider_id or model_id:
        # 只给了一半的标识无法定位模型，按默认模型处理并留痕便于排查。
        logger.warning(
            "provider_id/model_id 未成对提供（provider=%s, model=%s），改用默认对话模型",
            provider_id,
            model_id,
        )
    return await resolve_default_llm()
