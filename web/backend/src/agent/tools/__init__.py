"""Agent runtime tools — 通过 DB implementation 字段动态发现和加载。

__all__ 已改为自动生成，不再需要手动维护（改进6）。
新代码应使用 agent.tools.registry.resolve_agent_tools() 获取工具。
"""

from agent.tools.get_datetime import get_datetime
from agent.tools.http_request import http_request
from agent.tools.kb_search import kb_search, list_knowledge_bases
from agent.tools.tavily_search import tavily_search

# 自动生成 __all__（仅用于向后兼容）
__all__ = [
    name
    for name, obj in list(globals().items())
    if callable(obj) and not name.startswith("_")
]
