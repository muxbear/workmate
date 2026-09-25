-- 文档内容去重与来源记录（迭代 6 T6.1）
--
-- 两列都是**加法**（nullable、不改动存量数据），可在现有库安全执行；
-- 回滚见 0002_document_dedup.down.sql。

-- ── 1) 内容哈希 ────────────────────────────────────────────────────────────
-- 同一知识库里内容相同的文件不再重复索引：上传时按 sha256 判重，命中即**跳过**
-- 并在逐文件结果里说明"重复于《哪一篇》"。
--
-- **故意不加唯一约束**：跳过是"少建一篇"而非"禁止出现两篇"，并发窗口下最坏结果
-- 是留下两行重复内容——良性，且用户可自行删除（与库名唯一约束的取舍不同：那两个
-- 是身份冲突，这个是内容冗余）。若加唯一约束，撞约束会打毒 Postgres 事务，批量
-- 插入必须每次都用 SAVEPOINT 包住才能继续，复杂度与出错面都更大。
ALTER TABLE knowledge_base_documents
    ADD COLUMN IF NOT EXISTS content_hash VARCHAR(64) NULL;

-- 留空表示"该行不参与判重"：迁移前上传的存量文档没有哈希，重传同一文件会被放行。
-- 这是一次性的过渡态（可接受）；**回填脚本不在本轮范围**，别当成漏做了。
CREATE INDEX IF NOT EXISTS ix_kb_documents_kb_content_hash
    ON knowledge_base_documents (kb_id, content_hash);

-- ── 2) 来源 URL ────────────────────────────────────────────────────────────
-- URL/网页导入的文档要记得自己从哪来（界面展示与排查都要用）。
ALTER TABLE knowledge_base_documents
    ADD COLUMN IF NOT EXISTS source_url VARCHAR(1024) NULL;
