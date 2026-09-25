-- 回滚 0002：只撤销本迁移新增的对象（不动数据）
DROP INDEX IF EXISTS ix_kb_documents_kb_content_hash;
ALTER TABLE knowledge_base_documents DROP COLUMN IF EXISTS source_url;
ALTER TABLE knowledge_base_documents DROP COLUMN IF EXISTS content_hash;
