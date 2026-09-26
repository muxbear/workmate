-- 回滚 0005：只撤销本迁移新增的列（不动其他数据、不动文档本身）。
--
-- 连列中的告警文本一并丢弃是**有意**的：回滚的是"能力"，留下一个既没人写也没人读的
-- 列只会让 schema 与代码对不上。需要保留那些文本的话，应在回滚前自行导出。

ALTER TABLE knowledge_base_documents DROP COLUMN IF EXISTS parse_warning;
