-- 解析部分成功的告警列（迭代 6 T6.4 批次③）
--
-- 一件事：给文档表加一列，承载"索引成功但内容不完整"的说明。
-- 纯加法（可空列），存量行保持 NULL，不受影响；回滚见 0005_ocr_parse_warning.down.sql。
--
-- 与既有的 graph_error 并列而不是复用，是刻意的：graph_error 在界面上渲染成
-- 「图谱未生成：…」，把 OCR 的告警塞进去会给出错误的解释。
--
-- 为什么需要它：扫描件 OCR 到时间预算或页数上限就会停下，此时文档是**成功**的。
-- 没有这一列的话，"一份 500 页的扫描件只识别了前 200 页"与"这份文档本来就只有
-- 200 页字"在界面上完全一样——用户只会发现后半本检索不到，而没有任何线索。

ALTER TABLE knowledge_base_documents ADD COLUMN IF NOT EXISTS parse_warning TEXT NULL;
