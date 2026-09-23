"""Agent runtime tools — 通过 DB implementation 字段动态发现和加载。

**不要在包内重导出与子模块同名的符号**：``from agent.tools.kb_search import
kb_search`` 会把包属性 ``agent.tools.kb_search`` 从「子模块」覆盖成「函数」，
于是 ``import agent.tools.kb_search`` / ``from agent.tools import kb_search`` 拿到
的东西取决于导入顺序，`get_datetime`、`http_request`、`kb_search`、`tavily_search`
都踩过这个坑。

统一约定：

- 需要工具函数 → ``from agent.tools.kb_search import kb_search``（指定子模块）
- 需要模块本身 → ``from agent.tools import kb_search``（现在得到模块，不会歧义）
- 运行期装配工具 → ``await agent.tools.registry.resolve_agent_tools(...)``
"""

from typing import TYPE_CHECKING

if TYPE_CHECKING:  # 仅供类型检查器识别子模块，运行时不产生导入副作用
    from agent.tools import (  # noqa: F401
        artifact_assets,
        execute_code,
        file_ops,
        get_datetime,
        http_request,
        image_generate,
        kb_search,
        tavily_search,
        text_embedding,
        web_scraper,
    )

__all__: list[str] = []
