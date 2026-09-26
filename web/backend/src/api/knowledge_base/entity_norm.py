"""实体归一——归一键与受控词表（迭代 6 T6.5）。

**这是归一规则的唯一事实来源**：抽取提示词、写侧落库、读侧分组、迁移回填、用例
都从这里取。同一套规则散成两份，就会出现"写侧算出的键与迁移回填的键对不上"，
而那种错的表现是**同一实体永远合并不了**，且没有任何报错。

实测的两个缺陷（288 个实体、85 条关系）：

- 大小写重名并存：`LangChain` 与 `langchain` 各占一个节点（归一后 288 → 281）；
- 类型词表三处不一致：提示词 12 类、设计文档 8 类、前端配色只认 5 类。

归一口径**只做确定性折叠**（空白 + 大小写），不做同义/别名合并：模糊合并一旦误合
就会**静默丢信息**（把两个不同实体的关系并到一起，界面上看不出来），需要人工确认
回路才谈得上。实测"去掉标点后仍重名"的有 18 组（`Deep Agents`/`deepagents`、
`@tool`/`tool`、`langchain[openai]`/`langchain_openai`…），那是下一轮的候选输入。

**刻意不做 NFKC（全半角）折叠**：实测含全角字符的名字只有 3 个，且全是中文全角
括号（`短期记忆（状态）`）——把 `（` 折成 `(` 在中文里反而是错的，那本来就是正确
写法。附带好处是归一可以用一条 SQL 精确表达，于是迁移能用 SQL 回填，不必引入
Python 回填脚本。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import func

#: 受控词表——与设计说明书、前端图例的口径一致（8 类）。
ENTITY_TYPES: tuple[str, ...] = (
    "人物",
    "组织",
    "产品",
    "概念",
    "算法",
    "地点",
    "时间",
    "事件",
)

#: 提示词此前用的 12 类 → 8 类的映射。收敛方向是"具体的软件产物归产品、抽象概念归
#: 概念"——8 类里没有"技术/框架/模型/数据集"这四个槽位。
LEGACY_TYPE_MAP: dict[str, str] = {
    "框架": "产品",
    "模型": "产品",
    "数据集": "产品",
    "技术": "概念",
}

#: 兜底类型。与既有实现保持一致（`_convert_extractions` 与 `_persist` 原先都用它）。
DEFAULT_ENTITY_TYPE = "概念"

#: 迁移 0006 回填用的 SQL 表达式。归一函数必须与它逐字等价，否则写侧与迁移产出的
#: 键会分叉；用例 `test_entity_norm.py` 会断言二者在代表性输入上一致。
#:
#: **顺序要紧**：先 `regexp_replace` 折叠空白、再 `btrim` 去两端。反过来写会漏掉
#: 制表符——Postgres 的 `btrim`（不带参数时）只去**空格**，不去 `\t`/`\n`，于是
#: `"\tfoo"` 会被折成 `" foo"`（带前导空格），与 Python 的 `" ".join(s.split())`
#: 不一致。（实测线上 288 个名字里没有这种输入，但表达式本身不该依赖数据恰好干净。）
NAME_KEY_SQL = "lower(btrim(regexp_replace(name, '\\s+', ' ', 'g')))"


def normalize_name(name: str | None) -> str:
    """实体名的归一键：折叠空白 + 小写。

    与迁移里的 ``NAME_KEY_SQL`` 等价。展示用的原名仍按写入时的写法保留——不归一
    展示名，否则 `LangChain` 会显示成 `langchain`。

    Args:
        name: 实体名。

    Returns:
        归一键；``None`` 与纯空白都返回空串（调用方据此跳过，与既有行为一致）。
    """
    return " ".join((name or "").split()).lower()


def name_key_expr(key_column: Any, name_column: Any) -> Any:
    """读侧取归一键的 SQL 表达式：列优先，NULL 时退回一个**近似**兜底。

    兜底只折大小写与两端空白（``lower(trim(name))``），**不折内部空白**——它刻意只用
    各方言都有的函数，因为读路径要能在内存 SQLite 上跑（后端单测的既有做法）。
    所以它不是归一规则的第二份实现，只是一张安全网：迁移与代码部署之间可能有旧进程
    写入的行，让那几行落进同一个空键节点，比"整块实体从图上消失"更难排查。

    归一规则的**唯一事实来源**是 :func:`normalize_name`（写侧）与迁移 0006 的回填
    SQL（存量数据）。这里不复制那份规则。
    """
    return func.coalesce(key_column, func.lower(func.trim(name_column)))


def canonical_type(raw: str | None) -> str:
    """把任意类型值折进受控词表。

    先过旧词表映射（12 → 8），再校验；未知值一律落 :data:`DEFAULT_ENTITY_TYPE`。
    模型不遵守提示词时不该把越界类型原样存进库里——那会让前端配色表永远缺一档。
    """
    value = (raw or "").strip()
    if not value:
        return DEFAULT_ENTITY_TYPE
    if value in ENTITY_TYPES:
        return value
    # 映射表的值都在受控词表内（用例断言这一点），命中即可直接返回
    return LEGACY_TYPE_MAP.get(value, DEFAULT_ENTITY_TYPE)
