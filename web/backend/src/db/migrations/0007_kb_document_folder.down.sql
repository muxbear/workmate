-- 回滚 0007：只撤销本迁移新增的索引与列（不动文档本身、不动已落盘的文件）。
--
-- 连目录归属一并丢弃是**有意**的：回滚的是"能力"，留下一个既没人写也没人读的列
-- 只会让 schema 与代码对不上。需要保留目录归属的话，应在回滚前自行导出。

DROP INDEX IF EXISTS ix_kb_documents_kb_folder;
ALTER TABLE knowledge_base_documents DROP COLUMN IF EXISTS folder;
