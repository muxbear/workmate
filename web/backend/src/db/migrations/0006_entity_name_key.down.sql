-- 回滚 0006：只撤销本迁移新增的列与索引（不动实体、关系数据本身）。
--
-- 归一列是**派生值**——它由 name / from_entity / to_entity 现算得出，丢掉不损失信息，
-- 需要时重跑迁移即可重建。这也是它敢用可空列、敢在回滚时直接丢弃的原因。

DROP INDEX IF EXISTS ix_kb_relations_kb_from_to_key;
DROP INDEX IF EXISTS ix_kb_entities_kb_name_key;

ALTER TABLE knowledge_base_relations DROP COLUMN IF EXISTS to_key;
ALTER TABLE knowledge_base_relations DROP COLUMN IF EXISTS from_key;

ALTER TABLE knowledge_base_entities DROP COLUMN IF EXISTS name_key;
