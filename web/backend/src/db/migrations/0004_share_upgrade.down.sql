-- 回滚 0004：只撤销本迁移新增的对象（不动数据）
ALTER TABLE knowledge_base_grants DROP CONSTRAINT IF EXISTS fk_kb_grants_kb;
DROP INDEX IF EXISTS ix_kb_grants_kb;
DROP INDEX IF EXISTS uq_kb_grant_target;
DROP TABLE IF EXISTS knowledge_base_grants;
ALTER TABLE knowledge_base_share_links DROP CONSTRAINT IF EXISTS fk_kb_share_links_kb;
DROP INDEX IF EXISTS ix_kb_share_links_kb;
DROP INDEX IF EXISTS uq_kb_share_links_token;
DROP TABLE IF EXISTS knowledge_base_share_links;
DROP INDEX IF EXISTS ix_kb_shares_link_id;
ALTER TABLE knowledge_base_shares DROP COLUMN IF EXISTS link_id;
ALTER TABLE knowledge_base_shares DROP COLUMN IF EXISTS expires_at;
