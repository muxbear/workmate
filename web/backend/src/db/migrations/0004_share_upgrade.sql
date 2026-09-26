-- 分享能力升级：有效期 / 链接式分享 / 部门与角色维度（迭代 6 T6.3）
--
-- 三件事：给既有分享表加有效期与来源链接、新建链接分享表、新建部门/角色授权表。
-- 全部是**加法**（加列 + 建表），存量数据不受影响；回滚见 0004_share_upgrade.down.sql。

-- ── 1) 既有分享：有效期 + 来源链接 ─────────────────────────────────────────
-- expires_at 为空表示永久。**过期不设新状态**（不写 status='expired'）：它是派生态，
-- 由读条件现算（`expires_at IS NULL OR expires_at > now`），否则每个消费 status 的
-- 地方（列表/邀请/撤销判定）都要跟着多一个分支。
ALTER TABLE knowledge_base_shares ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP NULL;

-- 这一行是"通过哪条链接落成的"。**刻意不建外键**：链接是软撤销、永不硬删，
-- 悬空 id 无害，而外键会阻止"删链接行"这种将来可能的运维动作。
ALTER TABLE knowledge_base_shares ADD COLUMN IF NOT EXISTS link_id VARCHAR(36) NULL;
CREATE INDEX IF NOT EXISTS ix_kb_shares_link_id ON knowledge_base_shares (link_id);

-- ── 2) 链接分享 ────────────────────────────────────────────────────────────
-- token **只存 sha256 摘要**（明文只在创建响应里出现一次）：数据库泄露时明文 token
-- 等于把所有库直接交出去。对照的是 oauth2_refresh_token 的存法，而不是桌面版
-- knowledge_shares 的明文列。
CREATE TABLE IF NOT EXISTS knowledge_base_share_links (
    id               VARCHAR(36) PRIMARY KEY,
    kb_id            VARCHAR(36) NOT NULL,
    created_by       VARCHAR(36) NOT NULL,
    token_hash       VARCHAR(64) NOT NULL,
    permission       VARCHAR(16) NOT NULL DEFAULT 'read',
    expires_at       TIMESTAMP NULL,
    revoked_at       TIMESTAMP NULL,
    accept_count     INTEGER NOT NULL DEFAULT 0,
    last_accepted_at TIMESTAMP NULL,
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_share_links_token
    ON knowledge_base_share_links (token_hash);
CREATE INDEX IF NOT EXISTS ix_kb_share_links_kb
    ON knowledge_base_share_links (kb_id);
ALTER TABLE knowledge_base_share_links
    ADD CONSTRAINT fk_kb_share_links_kb FOREIGN KEY (kb_id)
    REFERENCES knowledge_bases (id) ON DELETE CASCADE;

-- ── 3) 部门 / 角色维度授权 ─────────────────────────────────────────────────
-- **另建表**而不是往分享表加 target_type：分享有 pending/accepted 与"接受"动作、
-- 靠 grantee_id join 账号、撤销是硬删；授权立即生效、没有账号可 join、撤销要留痕。
-- 混在一张表里，每处既有查询都得补 `target_type='user'` 过滤——漏一处就是部门行
-- 混进"已分享用户"列表并被人接受。
CREATE TABLE IF NOT EXISTS knowledge_base_grants (
    id              VARCHAR(36) PRIMARY KEY,
    kb_id           VARCHAR(36) NOT NULL,
    target_type     VARCHAR(16) NOT NULL,
    target_id       VARCHAR(64) NOT NULL,
    include_subtree BOOLEAN NOT NULL DEFAULT true,
    permission      VARCHAR(16) NOT NULL DEFAULT 'read',
    created_by      VARCHAR(36) NOT NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at      TIMESTAMP NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_grant_target
    ON knowledge_base_grants (kb_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS ix_kb_grants_kb ON knowledge_base_grants (kb_id);
ALTER TABLE knowledge_base_grants
    ADD CONSTRAINT fk_kb_grants_kb FOREIGN KEY (kb_id)
    REFERENCES knowledge_bases (id) ON DELETE CASCADE;
