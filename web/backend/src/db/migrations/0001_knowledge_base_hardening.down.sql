-- 回滚 0001：只撤销本迁移新增的对象（不动数据）
DROP INDEX IF EXISTS uq_kb_user_name;
DROP INDEX IF EXISTS ix_knowledge_bases_deleted_at;
ALTER TABLE knowledge_bases DROP COLUMN IF EXISTS deleted_at;
ALTER TABLE knowledge_base_index_tasks DROP CONSTRAINT IF EXISTS fk_kb_tasks_kb;
ALTER TABLE knowledge_base_shares DROP CONSTRAINT IF EXISTS fk_kb_shares_kb;
ALTER TABLE knowledge_base_relations DROP CONSTRAINT IF EXISTS fk_kb_relations_kb;
ALTER TABLE knowledge_base_entities DROP CONSTRAINT IF EXISTS fk_kb_entities_kb;
ALTER TABLE knowledge_base_documents DROP CONSTRAINT IF EXISTS fk_kb_documents_kb;
DROP INDEX IF EXISTS ix_kb_relations_kb_id;
DROP INDEX IF EXISTS ix_kb_entities_kb_id;
DROP INDEX IF EXISTS ix_kb_documents_status;
DROP INDEX IF EXISTS ix_kb_documents_kb_id;
DROP INDEX IF EXISTS ix_knowledge_bases_updated_at;
DROP INDEX IF EXISTS ix_knowledge_bases_user_id;
