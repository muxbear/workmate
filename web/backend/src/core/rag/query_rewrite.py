"""查询改写——指代消解 + 多查询扩展（+ 可选 HyDE）。

动机：用户提问与文档表述很少字面重合。实测两类查询几乎必然召回失败：

1. **多轮追问**——「那它的从库怎么配」里的"它"指上一轮的 MySQL，单独拿去检索
   等于在问一个没有主语的句子；
2. **口语化提问**——「我想自己搭一套 k8s 玩一玩，要看哪一章」与文档标题
   「搭建 Kubernetes 环境」只有 `k8s` 一个词重合。

本模块用一次 LLM 调用同时解决两者：把指代还原成完整问题（``resolved``），
再产出若干条互补的**检索式**（术语化改写、同义说法、关键词串），交由检索层
多路召回后按排名融合（见 ``api.knowledge_base.search_service._fuse_variants``）。

设计约束：

- **一次调用、严格预算**：无论历史多长、扩展几条，都只发一次请求，超时即放弃；
- **失败绝不阻断检索**：任何异常/超时/解析失败都退化为"只用原始查询"，并把原因
  写在 ``RewriteResult.reason`` 里，供前端与评测观测（此前 rerank 静默失败过一轮，
  这里不重复同样的错误）；
- **不开改写时零开销**：不构造客户端、不发请求。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass

from core.rag.llm import ChatClient

logger = logging.getLogger(__name__)

#: 改写结果里最多保留几条查询（含原始查询）。折叠后 3~5 条足够互补，
#: 再多只会让 RRF 被弱相关路稀释。
DEFAULT_MAX_QUERIES = 4

#: 参与指代消解的历史轮数上限（只取最近 N 轮用户提问）
DEFAULT_MAX_HISTORY_TURNS = 3

#: 单次改写调用的超时（秒）——检索路径的额外延迟预算，宁可放弃改写
DEFAULT_REWRITE_TIMEOUT = 12.0

#: 单条查询长度上限，避免模型输出跑飞后把长文塞进检索
MAX_QUERY_CHARS = 200

_SYSTEM_PROMPT = (
    "你是检索查询改写助手。用户会给出「对话历史」与「当前问题」，"
    "你的任务是把它改写成适合在技术文档库里做检索的查询。\n"
    "要求：\n"
    "1. resolved：把当前问题里的代词、省略补全成一个**独立可理解**的完整问题"
    "（结合历史；没有可消解的内容时原样返回当前问题）；\n"
    "2. queries：给出 2~4 条**互补**的检索式，覆盖同一个问题的不同表述方式：\n"
    "   - 术语化改写（口语 → 文档里更可能出现的专业表述）；\n"
    "   - 同义说法/别名（如 k8s ↔ Kubernetes、大模型 ↔ LLM）；\n"
    "   - 关键名词组合（去掉虚词，保留最具区分度的词）；\n"
    "3. 每条查询都必须是**独立完整的检索式**，不依赖上下文也能看懂；\n"
    "4. 不要编造原问题里没有的技术名词，不要回答问题本身。\n"
    '只输出 JSON，不要解释：{"resolved": "...", "queries": ["...", "..."]}'
)

_HYDE_INSTRUCTION = (
    "\n5. 另外给出一条 hypothetical：「假设这是文档里的一段原文」，"
    "用文档的语气写出最可能包含答案的一小段内容（80~150 字，可含术语，不必正确）。"
)

#: 候选查询开头的项目符号或序号（`- ` / `• ` / `1. ` / `2) ` / `3、`）
_BULLET_PREFIX = re.compile(r"^\s*(?:[-•*]|\(?\d+[.)、])\s*")


@dataclass
class RewriteResult:
    """查询改写结果。

    Attributes:
        queries: 用于多路召回的查询变体（**始终包含原始查询**，已去重截断）。
        resolved: 指代消解后的完整问题；未生效时等于原始查询。
        applied: LLM 改写是否真的生效（失败/超时/未开启均为 False）。
        reason: 未生效的原因（可观测用；生效时为空串）。
        hyde_query: HyDE 假设文档（仅在开启且成功时非空）。
    """

    queries: list[str]
    resolved: str
    applied: bool = False
    #: 是否**要求**改写（开关打开）——用于区分"没开这个功能"与"开了但没成功"
    requested: bool = False
    reason: str = ""
    hyde_query: str = ""

    @property
    def variants(self) -> list[str]:
        """全部检索变体 = 扩展查询 + HyDE 假设文档（若有）。"""
        if self.hyde_query:
            return [*self.queries, self.hyde_query]
        return list(self.queries)


def _fallback(query: str, reason: str) -> RewriteResult:
    """构造"未改写"的结果——只用原始查询。

    ``requested=True``：走到这里说明调用方**要求**改写，只是没成功——前端据此
    提示"改写未生效（原因）"，而不是把失败伪装成"没开这个功能"。
    """
    return RewriteResult(
        queries=[query], resolved=query, applied=False, requested=True, reason=reason,
    )


def build_prompt(
    query: str,
    history: list[str] | None,
    *,
    hyde: bool = False,
    max_queries: int = DEFAULT_MAX_QUERIES,
) -> str:
    """构造单轮改写提示词（历史只取最近若干轮，避免长上下文稀释）。"""
    lines = []
    turns = [h.strip() for h in (history or []) if h and h.strip()]
    if turns:
        recent = turns[-DEFAULT_MAX_HISTORY_TURNS:]
        lines.append("对话历史（从旧到新）：")
        lines.extend(f"- {turn[:MAX_QUERY_CHARS]}" for turn in recent)
        lines.append("")
    lines.append(f"当前问题：{query}")
    lines.append(f"最多给出 {max_queries - 1} 条 queries。")
    prompt = "\n".join(lines)
    return prompt + (_HYDE_INSTRUCTION if hyde else "")


def _strip_fence(text: str) -> str:
    """剥掉 ```json ... ``` 代码块围栏（模型常无视"只输出 JSON"）。"""
    fenced = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.DOTALL)
    return fenced.group(1) if fenced else text


def _clean_candidate(text: object) -> str:
    """清洗单条候选查询：去项目符号/序号/引号/换行，限长。

    用正则而不是 ``lstrip`` 剥序号：``lstrip("0123456789.")`` 会把
    「2PC 事务」剥成「PC 事务」——它以数字开头但不是编号。
    """
    if not isinstance(text, str):
        return ""
    cleaned = text.strip()
    # 模型可能同时加项目符号与引号（`- "查询"`），顺序不定，剥到稳定为止
    for _ in range(3):
        before = cleaned
        cleaned = _BULLET_PREFIX.sub("", cleaned).strip()
        cleaned = cleaned.strip("\"'“”「」").strip()
        if cleaned == before:
            break
    if not cleaned:
        return ""
    # 只保留首行——模型有时会在一条查询后面跟解释
    return cleaned.splitlines()[0].strip()[:MAX_QUERY_CHARS]


def parse_rewrite_response(
    payload: str | None,
    original: str,
    *,
    max_queries: int = DEFAULT_MAX_QUERIES,
) -> tuple[list[str], str, str]:
    """解析模型输出。

    容忍三种形态（按模型的听话程度降级）：完整 JSON 对象 → JSON 数组 →
    纯文本行列表。无法解析时返回空列表，由调用方走回退。

    Returns:
        ``(queries, resolved, hyde)``——queries 已去重、已截断，**不含**原始查询。
    """
    if not payload or not payload.strip():
        return [], original, ""

    text = _strip_fence(payload.strip())
    resolved = original
    raw_queries: list[object] = []
    hyde = ""

    try:
        data = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        data = None

    if isinstance(data, dict):
        resolved = _clean_candidate(data.get("resolved")) or original
        candidates = data.get("queries")
        if isinstance(candidates, list):
            raw_queries = candidates
        elif isinstance(candidates, str):
            raw_queries = [candidates]
        hyde = _clean_candidate(data.get("hypothetical"))
    elif isinstance(data, list):
        raw_queries = data
    else:
        # 非 JSON：按行拆（模型直接给了一串检索式）
        raw_queries = [line for line in text.splitlines() if line.strip()]

    queries: list[str] = []
    for item in raw_queries:
        cleaned = _clean_candidate(item)
        if not cleaned or cleaned == original or cleaned in queries:
            continue
        queries.append(cleaned)
        if len(queries) >= max_queries - 1:
            break

    return queries, resolved, hyde


class QueryRewriter:
    """基于 LLM 的查询改写器（一次调用完成指代消解与多查询扩展）。

    Args:
        client: 聊天补全客户端（``core.rag.llm.ChatClient``）。
        max_queries: 变体总数上限（含原始查询）。
        timeout: 单次调用超时（秒）。
    """

    def __init__(
        self,
        client: ChatClient,
        *,
        max_queries: int = DEFAULT_MAX_QUERIES,
        timeout: float = DEFAULT_REWRITE_TIMEOUT,
    ) -> None:
        self._client = client
        self._max_queries = max(1, max_queries)
        self._timeout = timeout

    async def rewrite(
        self,
        query: str,
        history: list[str] | None = None,
        *,
        hyde: bool = False,
    ) -> RewriteResult:
        """改写查询；任何失败都退化为"只用原始查询"。

        Args:
            query: 用户当前问题。
            history: 最近的用户提问（从旧到新），用于指代消解。
            hyde: 是否额外生成 HyDE 假设文档（作为一路检索变体）。

        Returns:
            ``RewriteResult``——``applied`` 为 False 时 ``queries == [query]``。
        """
        query = (query or "").strip()
        if not query:
            return _fallback(query, "空查询")

        prompt = build_prompt(
            query, history, hyde=hyde, max_queries=self._max_queries,
        )
        try:
            payload = await asyncio.wait_for(
                self._client.acomplete(prompt, system=_SYSTEM_PROMPT),
                timeout=self._timeout,
            )
        except TimeoutError:
            logger.warning("查询改写超时（%.1fs），回退原始查询", self._timeout)
            return _fallback(query, f"改写超时（>{self._timeout:.0f}s）")
        except Exception:
            logger.warning("查询改写调用失败，回退原始查询", exc_info=True)
            return _fallback(query, "改写调用失败")

        if not payload:
            return _fallback(query, "改写无返回")

        extra, resolved, hyde_text = parse_rewrite_response(
            payload, query, max_queries=self._max_queries,
        )
        if not hyde:
            # 没开 HyDE 就不认这个字段：模型可能自作主张带回来，
            # 静默多跑一路"假设文档"召回既花时间又改变排序
            hyde_text = ""
        if not extra and not hyde_text:
            return _fallback(query, "改写结果为空")

        resolved = resolved or query
        # 原始查询始终参与召回：改写是**扩召**，不是替换——模型跑偏时至少不会
        # 比不开改写更差（"改写把好结果挤掉"是这类功能最常见的翻车方式）。
        queries = [query]
        for candidate in extra:
            if len(queries) >= self._max_queries:
                break
            if candidate not in queries:
                queries.append(candidate)

        # 指代消解后的完整问题本身就是一条高质量变体，优先级排在扩展式之前
        if resolved != query and resolved not in queries:
            queries.insert(1, resolved)
            del queries[self._max_queries:]

        return RewriteResult(
            queries=queries,
            resolved=resolved,
            applied=True,
            requested=True,
            hyde_query=hyde_text,
        )
