-- 知识库数据模型硬化（迭代 5 T5.6）
--
-- 三件事：补索引、补外键级联、补唯一约束。
-- 全部是**加法**（不改列类型、不删数据），可在现有库安全执行；
-- 回滚见 0001_knowledge_base_hardening.down.sql。
--
-- 执行前已核对线上数据：无重名库、无孤儿行，因此约束能加上。
-- 该核对可复跑：`uv run python scripts/check_hardening_conflicts.py`（只读，逐项对照
-- 本文件要加的每个索引/约束，并检查列类型与同名对象占用）。

-- ── 1) 关键索引 ────────────────────────────────────────────────────────────
-- 这两列是最常用的过滤条件（"我的库"、"某个库的文档"），此前**没有索引**，
-- 库/文档一多就是全表扫描。
CREATE INDEX IF NOT EXISTS ix_knowledge_bases_user_id ON knowledge_bases (user_id);
CREATE INDEX IF NOT EXISTS ix_knowledge_bases_updated_at ON knowledge_bases (updated_at);
CREATE INDEX IF NOT EXISTS ix_kb_documents_kb_id ON knowledge_base_documents (kb_id);
CREATE INDEX IF NOT EXISTS ix_kb_documents_status ON knowledge_base_documents (status);
CREATE INDEX IF NOT EXISTS ix_kb_entities_kb_id ON knowledge_base_entities (kb_id);
CREATE INDEX IF NOT EXISTS ix_kb_relations_kb_id ON knowledge_base_relations (kb_id);

-- ── 2) 外键 + 级联删除 ─────────────────────────────────────────────────────
-- 此前没有任何外键：删库后文档/实体/关系的孤儿行要靠应用层逐个清理，漏一处就留垃圾。
-- ON DELETE CASCADE 让数据库兜住这件事。
ALTER TABLE knowledge_base_documents
    ADD CONSTRAINT fk_kb_documents_kb FOREIGN KEY (kb_id)
    REFERENCES knowledge_bases (id) ON DELETE CASCADE;

ALTER TABLE knowledge_base_entities
    ADD CONSTRAINT fk_kb_entities_kb FOREIGN KEY (kb_id)
    REFERENCES knowledge_bases (id) ON DELETE CASCADE;

ALTER TABLE knowledge_base_relations
    ADD CONSTRAINT fk_kb_relations_kb FOREIGN KEY (kb_id)
    REFERENCES knowledge_bases (id) ON DELETE CASCADE;

ALTER TABLE knowledge_base_shares
    ADD CONSTRAINT fk_kb_shares_kb FOREIGN KEY (kb_id)
    REFERENCES knowledge_bases (id) ON DELETE CASCADE;

-- 索引任务表：文档被删时任务行一并清理
ALTER TABLE knowledge_base_index_tasks
    ADD CONSTRAINT fk_kb_tasks_kb FOREIGN KEY (kb_id)
    REFERENCES knowledge_bases (id) ON DELETE CASCADE;

-- ── 3) 软删除列 ────────────────────────────────────────────────────────────
-- 删库会清空向量与磁盘文件，误删不可逆；先标记再清理。
-- 查询侧由 db.soft_delete 的全局过滤器统一排除，不需要逐个查询去补条件。
ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL;
CREATE INDEX IF NOT EXISTS ix_knowledge_bases_deleted_at ON knowledge_bases (deleted_at);

-- ── 4) 同一用户下库名唯一 ──────────────────────────────────────────────────
-- 应用层靠"先查后插"判重，并发下会漏（两个请求同时查不到、同时插入）。
-- 唯一约束把它交还给数据库。
-- **必须带 WHERE deleted_at IS NULL**（部分唯一索引）：软删除的库仍占着那一行，
-- 不带条件的话"删掉后想用同名重建"会撞唯一约束——用户完全无法理解为什么。
CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_user_name
    ON knowledge_bases (user_id, name) WHERE deleted_at IS NULL;
