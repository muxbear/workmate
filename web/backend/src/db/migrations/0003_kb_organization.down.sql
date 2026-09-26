-- 回滚 0003：只撤销本迁移新增的对象（不动数据；分组数据随表一起消失）
ALTER TABLE knowledge_bases DROP CONSTRAINT IF EXISTS fk_kb_group;
DROP INDEX IF EXISTS ix_knowledge_bases_group_id;
ALTER TABLE knowledge_bases DROP COLUMN IF EXISTS group_id;
DROP TABLE IF EXISTS knowledge_base_groups;
DROP INDEX IF EXISTS ix_knowledge_bases_user_order;
ALTER TABLE knowledge_bases DROP COLUMN IF EXISTS sort_order;
ALTER TABLE knowledge_bases DROP COLUMN IF EXISTS is_pinned;
