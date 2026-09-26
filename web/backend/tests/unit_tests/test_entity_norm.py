"""实体归一与受控词表（迭代 6 T6.5）。

归一规则有两份实现——应用侧是 Python（`entity_norm.normalize_name`），迁移 0006 的
回填是 SQL。两份**必须逐字等价**：不等价的表现是"写侧算出的键与迁移回填的键对不上"，
于是同一实体永远合并不了，而且没有任何报错。所以这里用 SQLite 真跑一遍迁移里的
SQL 表达式，与 Python 结果对拍。

（回填 SQL 只用到 lower / regexp_replace / btrim，SQLite 都能跑——迁移本身是
Postgres 方言，但这段表达式是标准 SQL 子集，可以拿来对拍。）
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

import pytest

from api.knowledge_base.entity_norm import (
    DEFAULT_ENTITY_TYPE,
    ENTITY_TYPES,
    LEGACY_TYPE_MAP,
    NAME_KEY_SQL,
    canonical_type,
    normalize_name,
)

#: 迁移 0006 里回填用的表达式（这里直接引用常量，另有一条用例断言它与迁移文件一致）
_BACKFILL_SQL = NAME_KEY_SQL


def _sqlite_with_postgres_helpers() -> sqlite3.Connection:
    """内存 SQLite + 两个 Postgres 函数的等价实现。

    ``btrim`` 与 ``regexp_replace`` 是 Postgres 专有，SQLite 没有。这里按 Postgres
    的语义补上（``btrim(s)`` 只去**空格**——不去制表符，这一点是本用例要验的顺序
    问题所在；``regexp_replace(s, pat, repl, 'g')`` 即全局替换）。

    **说清楚这验的是什么**：它验的是"这条表达式按 Postgres 语义求值，与 Python 归一
    一致"，也验表达式本身没写错（参数顺序、嵌套）。真跑 Postgres 需要另建库，不在
    单测范围内——所以它不证明 Postgres 的实际行为，只证明组合是对的。
    """
    conn = sqlite3.connect(":memory:")
    conn.create_function("btrim", 1, lambda s: s.strip(" ") if s else s)
    conn.create_function(
        "regexp_replace",
        4,
        lambda s, pat, repl, _flags: re.sub(pat, repl, s or ""),
    )
    return conn


class TestNormalizeName:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("LangChain", "langchain"),
            ("langchain", "langchain"),
            ("  OpenAI  ", "openai"),
            ("SYSTEM_PROMPT", "system_prompt"),
            ("Deep  Agents", "deep agents"),
            ("Deep\tAgents", "deep agents"),
            ("结构化输出", "结构化输出"),  # 中文没有大小写，原样保留
            ("短期记忆（状态）", "短期记忆（状态）"),
            ("", ""),
            ("   ", ""),
            (None, ""),
        ],
    )
    def test_folds_case_and_whitespace(self, raw, expected):
        assert normalize_name(raw) == expected

    def test_does_not_fold_fullwidth_punctuation(self):
        """刻意不做 NFKC：中文全角括号是正确写法，折成半角反而错。

        实测含全角字符的名字只有 3 个，且全是 `（）`——这条用例把这个判断钉住，
        免得将来有人"顺手"补上 NFKC 折叠。
        """
        assert normalize_name("短期记忆（状态）") == "短期记忆（状态）"
        assert normalize_name("短期记忆（状态）") != normalize_name("短期记忆(状态)")

    def test_case_variants_collapse_to_one_key(self):
        """实测的 7 组重名正是这一类——归一是本次要修的核心缺陷。"""
        variants = ["LangChain", "langchain", "LANGCHAIN", " langchain "]
        assert len({normalize_name(v) for v in variants}) == 1


class TestPythonMatchesMigrationSql:
    """Python 归一与迁移回填 SQL 必须逐字等价。"""

    NAMES = [
        "LangChain",
        "langchain",
        "  OpenAI  ",
        "SYSTEM_PROMPT",
        "Deep  Agents",
        "Deep\tAgents",
        "结构化输出",
        "短期记忆（状态）",
        "langchain[openai]",
        "@tool",
        "",
        "   ",
        "A",
        "a",
        "Mixed  CASE  Name",
        # 制表符/换行开头或结尾——btrim 只去空格，这几条正是"顺序写反就露馅"的输入
        "\tfoo",
        "foo\t",
        "\nfoo\n",
        " foo\tbar ",
        "\t\t",
    ]

    def test_sql_and_python_agree(self):
        conn = _sqlite_with_postgres_helpers()
        try:
            rows = conn.execute(
                "WITH t(name) AS (VALUES " + ",".join("(?)" for _ in self.NAMES) + ") "
                f"SELECT name, {_BACKFILL_SQL} AS key FROM t",
                self.NAMES,
            ).fetchall()
        finally:
            conn.close()

        mismatches = [
            (name, sql_key, normalize_name(name))
            for name, sql_key in rows
            if sql_key != normalize_name(name)
        ]
        assert not mismatches, f"Python 与迁移 SQL 归一结果不一致: {mismatches}"

    def test_tab_leading_name_would_diverge_if_trim_came_first(self):
        """回归：先 btrim 再折空白会漏掉制表符。

        Postgres 的 ``btrim`` 不带参数时只去空格。若表达式写成
        ``btrim(name)`` 在前，``"\\tfoo"`` 不会被 trim，随后被折成 ``" foo"``（带
        前导空格），与 Python 的 ``"foo"`` 分叉——而分叉的表现是同一实体永远合并不了，
        且没有任何报错。这里直接钉住错误写法的差异。
        """
        right = "lower(btrim(regexp_replace(?, '\\s+', ' ', 'g')))"
        wrong = "lower(regexp_replace(btrim(?), '\\s+', ' ', 'g'))"

        conn = _sqlite_with_postgres_helpers()
        try:
            correct = conn.execute(f"SELECT {right}", ("\tfoo",)).fetchone()[0]
            buggy = conn.execute(f"SELECT {wrong}", ("\tfoo",)).fetchone()[0]
        finally:
            conn.close()

        assert correct == normalize_name("\tfoo") == "foo"
        assert buggy != correct, "错误写法竟然也对，说明这条回归用例失效了"

    def test_name_key_sql_constant_matches_the_migration_file(self):
        """常量与迁移文件里真正跑的表达式不能分叉。"""
        migration = (
            Path(__file__).resolve().parents[2]
            / "src/db/migrations/0006_entity_name_key.sql"
        ).read_text(encoding="utf-8")
        assert NAME_KEY_SQL in migration, "迁移里的表达式与 NAME_KEY_SQL 不一致"


class TestCanonicalType:
    @pytest.mark.parametrize("value", ENTITY_TYPES)
    def test_controlled_vocabulary_passes_through(self, value):
        assert canonical_type(value) == value

    @pytest.mark.parametrize(
        ("legacy", "expected"),
        [("框架", "产品"), ("模型", "产品"), ("数据集", "产品"), ("技术", "概念")],
    )
    def test_legacy_types_are_mapped(self, legacy, expected):
        """提示词此前的 12 类折进 8 类——具体的软件产物归产品，抽象概念归概念。"""
        assert canonical_type(legacy) == expected

    def test_every_legacy_target_is_in_the_vocabulary(self):
        """映射表的值必须都在受控词表内，否则折完还是越界。"""
        assert set(LEGACY_TYPE_MAP.values()) <= set(ENTITY_TYPES)

    @pytest.mark.parametrize("value", [None, "", "   ", "未知类型", "PERSON", "技术栈"])
    def test_unknown_values_fall_back_to_concept(self, value):
        """模型不遵守提示词时不该把越界类型原样入库——那会让前端配色表永远缺一档。"""
        assert canonical_type(value) == DEFAULT_ENTITY_TYPE

    def test_vocabulary_matches_the_design_documents(self):
        """8 类，与设计说明书和前端图例同口径。"""
        assert ENTITY_TYPES == (
            "人物",
            "组织",
            "产品",
            "概念",
            "算法",
            "地点",
            "时间",
            "事件",
        )
