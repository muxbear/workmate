-- 文档的目录归属（让知识库的"文档"页签能按原始目录结构浏览）
--
-- 一件事：给文档表加一列，记录它上传时来自哪个相对目录（'/'-分隔、无首尾斜杠），
-- NULL 表示知识库根目录。存量行全部落在根目录，与升级前的平铺展示一致，故不回填。
-- 纯加法（可空列），可在现有库安全执行；回滚见 0007_kb_document_folder.down.sql。
--
-- 为什么需要它：整目录上传此前只保留文件名，落库后目录结构丢失，不同子目录里的
-- 同名文件还会被加序号区分（"报告(2).md"）。这一列让文档页签能像文件管理器一样
-- 逐级浏览，也让同名文件在各自主目录里保持本名。
--
-- 注意：folder 只是展示/过滤维度，**不参与落盘**——文件仍在
-- <upload_dir>/<kb_id>/<doc_id>/<name>，因此这一列不携带任何路径穿越风险。

ALTER TABLE knowledge_base_documents
    ADD COLUMN IF NOT EXISTS folder VARCHAR(512) NULL;

-- 列表过滤（按目录取一页）与目录聚合（GROUP BY folder）都按 (kb_id, folder) 取
CREATE INDEX IF NOT EXISTS ix_kb_documents_kb_folder
    ON knowledge_base_documents (kb_id, folder);
