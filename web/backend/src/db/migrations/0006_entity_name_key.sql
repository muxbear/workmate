-- 实体归一键：给实体与关系加归一身份列（迭代 6 T6.5）
--
-- 三件事：实体加 name_key、关系加 from_key/to_key、补上按名查询的索引。
-- 纯加法（加列 + 建索引 + 回填），存量行不受影响；回滚见 0006_entity_name_key.down.sql。
--
-- 为什么要落成列，而不是读的时候现算：
--   1. 分组从"读时按名字"变成"按归一键"，规则必须只有一处，否则写侧与迁移会分叉；
--   2. 关系端点只有名字、没有类型，边要挂到稳定节点上就必须有同一套键；
--   3. 现有两张表除主键外**只有 kb_id 一个索引**，而读写都在按名字查——归一是把
--      索引建得起来的前提。
--
-- 口径（与 src/api/knowledge_base/entity_norm.normalize_name 逐字等价）：
--   lower(btrim(regexp_replace(name, '\s+', ' ', 'g')))
-- 先折空白、再去两端、再小写。**顺序要紧**：Postgres 的 btrim 不带参数时只去空格，
-- 不去制表符与换行，所以必须先把空白折成一个空格再 trim——否则制表符开头的名字会
-- 折成前导空格，与 Python 侧 " ".join(s.split()) 的结果对不上。
--
-- **刻意不做 NFKC**（全半角折叠）：实测含全角字符的名字只有 3 个、且全是中文全角
-- 括号，把「（」折成「(」在中文里反而是错的。
--
-- 列保持可空：回填后全部有值，但迁移与代码部署之间可能有旧进程写入的行，读侧用
-- coalesce(name_key, <同一表达式>) 兜底，比"多出几行看不见的实体"便宜得多。

-- ── 1) 实体：归一键 ────────────────────────────────────────────────────────
ALTER TABLE knowledge_base_entities ADD COLUMN IF NOT EXISTS name_key VARCHAR(256) NULL;

UPDATE knowledge_base_entities
   SET name_key = lower(btrim(regexp_replace(name, '\s+', ' ', 'g')))
 WHERE name_key IS NULL;

-- ── 2) 关系：两端的归一键 ──────────────────────────────────────────────────
-- 关系存的是端点的**名字**（不是外键），所以它的键就是那个名字的归一形式。
ALTER TABLE knowledge_base_relations ADD COLUMN IF NOT EXISTS from_key VARCHAR(256) NULL;
ALTER TABLE knowledge_base_relations ADD COLUMN IF NOT EXISTS to_key VARCHAR(256) NULL;

UPDATE knowledge_base_relations
   SET from_key = lower(btrim(regexp_replace(from_entity, '\s+', ' ', 'g')))
 WHERE from_key IS NULL;

UPDATE knowledge_base_relations
   SET to_key = lower(btrim(regexp_replace(to_entity, '\s+', ' ', 'g')))
 WHERE to_key IS NULL;

-- ── 3) 索引 ────────────────────────────────────────────────────────────────
-- 归一并组之后，这两条是图谱读写的主路径。索引的事实来源是迁移文件，ORM 侧不写
-- index=True（见 src/db/models/knowledge_base_document.py 的同款说明）。
CREATE INDEX IF NOT EXISTS ix_kb_entities_kb_name_key
    ON knowledge_base_entities (kb_id, name_key);

CREATE INDEX IF NOT EXISTS ix_kb_relations_kb_from_to_key
    ON knowledge_base_relations (kb_id, from_key, to_key);
