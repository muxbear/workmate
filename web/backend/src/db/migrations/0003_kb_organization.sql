-- 知识库的组织能力：置顶 / 手工排序 / 自定义分组（迭代 6 T6.2）
--
-- 三列 + 一张新表，全部是加法，可在现有库安全执行（存量库的 is_pinned=false、
-- sort_order=0、group_id=NULL，与升级前的展示顺序一致）。
-- 回滚见 0003_kb_organization.down.sql。

-- ── 1) 列表排序 ────────────────────────────────────────────────────────────
-- 置顶与手工排序都落在**每个用户自己的列表**上：这两个字段是"我的视图偏好"，
-- 不是知识库的公共属性。排序规则：is_pinned DESC, sort_order ASC, updated_at DESC。
ALTER TABLE knowledge_bases
    ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE knowledge_bases
    ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

-- 列表查询按 (user_id, is_pinned, sort_order) 取，索引跟着它建
CREATE INDEX IF NOT EXISTS ix_knowledge_bases_user_order
    ON knowledge_bases (user_id, is_pinned, sort_order);

-- ── 2) 自定义分组 ──────────────────────────────────────────────────────────
-- 分组是**用户私有**的（不同人对同一个库可以有不同归类），因此挂 user_id 而不是
-- 挂在知识库上做全局属性。
CREATE TABLE IF NOT EXISTS knowledge_base_groups (
    id          VARCHAR(36) PRIMARY KEY,
    user_id     VARCHAR(36) NOT NULL,
    name        VARCHAR(64) NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 同一用户下分组名唯一（与库名同样的取向：应用层先查后插在并发下会漏）
CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_group_user_name
    ON knowledge_base_groups (user_id, name);

ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS group_id VARCHAR(36) NULL;
CREATE INDEX IF NOT EXISTS ix_knowledge_bases_group_id ON knowledge_bases (group_id);

-- 删分组时**不删库**，只把归属置空（库是用户的数据资产，不能因为整理分组而丢）
ALTER TABLE knowledge_bases
    ADD CONSTRAINT fk_kb_group FOREIGN KEY (group_id)
    REFERENCES knowledge_base_groups (id) ON DELETE SET NULL;
