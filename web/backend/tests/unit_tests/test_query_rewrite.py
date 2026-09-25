"""Tests for 查询改写（迭代 3 T3.4）——指代消解 + 多查询扩展 + HyDE。

改写是"锦上添花"型能力：它每次检索要多花一次 LLM 调用，因此三条底线必须守住：

1. **失败绝不阻断检索**——超时/报错/返回垃圾都退回原始查询；
2. **原始查询始终参与召回**——改写是扩召不是替换，模型跑偏时不能比不改更差；
3. **预算硬上限**——变体条数与历史轮数都有上限，不让提示词与延迟无限膨胀。
"""

import asyncio
import json

import pytest

from core.rag.query_rewrite import (
    DEFAULT_MAX_QUERIES,
    QueryRewriter,
    build_prompt,
    parse_rewrite_response,
)

pytestmark = pytest.mark.anyio


class FakeClient:
    """可编程的 ChatClient 替身。"""

    def __init__(self, reply=None, delay: float = 0.0, fail: bool = False):
        self.reply = reply
        self.delay = delay
        self.fail = fail
        self.prompts: list[str] = []
        self.systems: list[str | None] = []

    async def acomplete(self, prompt: str, system: str | None = None) -> str | None:
        self.prompts.append(prompt)
        self.systems.append(system)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail:
            raise RuntimeError("llm down")
        return self.reply


def make_rewriter(reply=None, **kwargs) -> tuple[QueryRewriter, FakeClient]:
    client = FakeClient(reply=reply, **{k: v for k, v in kwargs.items() if k != "rewriter"})
    rewriter = QueryRewriter(client, **kwargs.get("rewriter", {}))
    return rewriter, client


class TestParseRewriteResponse:
    def test_json_object_with_resolved_and_queries(self):
        payload = json.dumps({
            "resolved": "MySQL 主从复制的从库需要修改哪些参数",
            "queries": ["MySQL 主从同步从库配置", "slave 参数配置"],
        })
        queries, resolved, hyde = parse_rewrite_response(payload, "那从库要改哪些参数")

        assert resolved == "MySQL 主从复制的从库需要修改哪些参数"
        assert queries == ["MySQL 主从同步从库配置", "slave 参数配置"]
        assert hyde == ""

    def test_code_fence_is_stripped(self):
        """模型常无视"只输出 JSON"而加 ```json 围栏。"""
        payload = '```json\n{"resolved": "原问题", "queries": ["术语化查询"]}\n```'
        queries, _resolved, _hyde = parse_rewrite_response(payload, "原问题")
        assert queries == ["术语化查询"]

    def test_original_query_is_never_duplicated(self):
        """解析层就把与原始查询重复的变体剔掉，避免同一路召回两次。"""
        payload = json.dumps({"queries": ["原问题", "另一条"]})
        queries, _resolved, _hyde = parse_rewrite_response(payload, "原问题")
        assert queries == ["另一条"]

    def test_plain_text_lines_fallback(self):
        """完全不是 JSON 时按行拆，仍能救回若干条检索式。"""
        payload = "1. Kubernetes 集群搭建\n2. kubeadm 初始化\n"
        queries, resolved, _hyde = parse_rewrite_response(payload, "怎么搭 k8s")
        assert queries == ["Kubernetes 集群搭建", "kubeadm 初始化"]
        assert resolved == "怎么搭 k8s"

    def test_bullets_and_quotes_are_cleaned(self):
        payload = json.dumps({"queries": ['- "Nacos 集群部署"', "• Redis 分片集群"]})
        queries, _resolved, _hyde = parse_rewrite_response(payload, "q")
        assert queries == ["Nacos 集群部署", "Redis 分片集群"]

    def test_multiline_candidate_keeps_first_line(self):
        payload = json.dumps({"queries": ["Seata 部署\n（说明：这是分布式事务组件）"]})
        queries, _resolved, _hyde = parse_rewrite_response(payload, "q")
        assert queries == ["Seata 部署"]

    def test_max_queries_is_enforced(self):
        payload = json.dumps({"queries": [f"查询{i}" for i in range(10)]})
        queries, _resolved, _hyde = parse_rewrite_response(
            payload, "q", max_queries=3,
        )
        assert queries == ["查询0", "查询1"]

    def test_garbage_payload_returns_nothing(self):
        queries, resolved, hyde = parse_rewrite_response("", "原问题")
        assert queries == [] and resolved == "原问题" and hyde == ""

    def test_non_string_candidates_are_ignored(self):
        payload = json.dumps({"queries": [None, 42, {"x": 1}, "有效查询"]})
        queries, _resolved, _hyde = parse_rewrite_response(payload, "q")
        assert queries == ["有效查询"]


class TestBuildPrompt:
    def test_history_is_included_oldest_to_newest(self):
        prompt = build_prompt("那从库呢", ["第一轮", "第二轮"])
        assert prompt.index("第一轮") < prompt.index("第二轮") < prompt.index("那从库呢")

    def test_history_is_capped_to_recent_turns(self):
        prompt = build_prompt("当前", [f"第{i}轮" for i in range(10)])
        assert "第9轮" in prompt
        assert "第0轮" not in prompt

    def test_hyde_instruction_only_when_requested(self):
        assert "hypothetical" not in build_prompt("q", None)
        assert "hypothetical" in build_prompt("q", None, hyde=True)


class TestQueryRewriter:
    async def test_applied_queries_include_original_first(self):
        """原始查询必须始终在列且排第一——失败兜底路径与扩召都依赖这一点。"""
        rewriter, _client = make_rewriter(json.dumps({
            "resolved": "完整问题", "queries": ["扩展一", "扩展二"],
        }))
        result = await rewriter.rewrite("原问题")

        assert result.applied is True
        assert result.queries[0] == "原问题"
        assert set(result.queries) == {"原问题", "完整问题", "扩展一", "扩展二"}

    async def test_resolved_is_inserted_right_after_original(self):
        rewriter, _client = make_rewriter(json.dumps({
            "resolved": "消解后的问题", "queries": ["扩展一"],
        }))
        result = await rewriter.rewrite("它怎么配")
        assert result.queries[:2] == ["它怎么配", "消解后的问题"]

    async def test_max_queries_caps_variants(self):
        rewriter, _client = make_rewriter(
            json.dumps({"resolved": "r", "queries": ["a", "b", "c", "d"]}),
            rewriter={"max_queries": 3},
        )
        result = await rewriter.rewrite("原问题")
        assert len(result.queries) == 3

    async def test_llm_failure_falls_back_to_original(self):
        rewriter, _client = make_rewriter(fail=True)
        result = await rewriter.rewrite("原问题")

        assert result.applied is False
        assert result.requested is True
        assert result.queries == ["原问题"]
        assert result.reason

    async def test_timeout_falls_back_to_original(self):
        client = FakeClient(reply="{}", delay=1.0)
        rewriter = QueryRewriter(client, timeout=0.01)
        result = await rewriter.rewrite("原问题")

        assert result.applied is False
        assert result.queries == ["原问题"]
        assert "超时" in result.reason

    async def test_empty_reply_falls_back(self):
        rewriter, _client = make_rewriter(None)
        result = await rewriter.rewrite("原问题")
        assert result.applied is False and result.queries == ["原问题"]

    async def test_empty_rewrite_result_falls_back(self):
        """模型返回了 JSON 但里面没有可用查询 → 视为未生效。"""
        rewriter, _client = make_rewriter(json.dumps({"queries": []}))
        result = await rewriter.rewrite("原问题")
        assert result.applied is False

    async def test_history_is_passed_into_the_prompt(self):
        rewriter, client = make_rewriter(json.dumps({"queries": ["x"]}))
        await rewriter.rewrite("那它呢", ["MySQL 主从怎么配"])
        assert "MySQL 主从怎么配" in client.prompts[0]

    async def test_hyde_is_appended_as_extra_variant(self):
        rewriter, _client = make_rewriter(json.dumps({
            "queries": ["扩展"], "hypothetical": "假设的文档原文",
        }))
        result = await rewriter.rewrite("问题", hyde=True)

        assert result.hyde_query == "假设的文档原文"
        assert result.variants[-1] == "假设的文档原文"
        assert "扩展" in result.variants

    async def test_hyde_variant_truncated_without_hyde_flag(self):
        """没开 HyDE 时解析出的 hypothetical 不应进入变体（避免静默多花一路开销）。"""
        rewriter, _client = make_rewriter(json.dumps({
            "queries": ["扩展"], "hypothetical": "假设文档",
        }))
        result = await rewriter.rewrite("问题", hyde=False)
        assert "假设文档" not in result.variants

    async def test_empty_query_short_circuits(self):
        rewriter, client = make_rewriter(json.dumps({"queries": ["x"]}))
        result = await rewriter.rewrite("   ")
        assert result.applied is False
        assert client.prompts == []

    async def test_default_max_queries_is_bounded(self):
        assert 3 <= DEFAULT_MAX_QUERIES <= 5
