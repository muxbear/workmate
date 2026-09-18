# 桌面版知识库 RAG 索引与检索实现方案

> 版本：v1 · 2026-09-17
> 定位：在《桌面版知识库实现方案》v4.5（下称「主方案」）的基础上，把**知识库页面已有功能 + 全局/按库/上传三级索引配置**落到一条可实施的 RAG 索引与检索链路上。只覆盖本地模式（SQLite + FTS5 + 可选向量/重排/图谱）；云端知识库、共享权限模型不在本次范围。
> 前置阅读：`desktop/docs/桌面版知识库实现方案.md`（数据模型、配置口径、既有决策）、`desktop/AGENTS.md`（严格三层、渲染层不传路径）。

---

## 一、目标与验收

### 1.1 要做到什么

| # | 能力 | 用户可见效果 | 判定标准 |
| --- | --- | --- | --- |
| 1 | 索引构建 | 上传时「创建默认索引 / 自定义索引」真正生效，列表显示索引状态与进度 | 上传完成后状态从 `queued` 走到 `indexed`；`knowledge_base_chunks` 有该文档的切片 |
| 2 | 索引管理 | 单文件/整库「重建索引」、失败重试、取消、删除与重命名级联清理 | 重建后切片与向量按新配置重算；删除文件时磁盘与索引数据一并清除 |
| 3 | 检索 | `knowledge:search` 返回带分数、来源与片段的命中列表 | 稀疏（FTS5 BM25）与混合（向量 + RRF）两条路径都能返回结果 |
| 4 | 问答 | `knowledge:ask` 流式回答并给出引用来源，可取消 | 回答按块推送，引用可定位到文档与切片序号 |
| 5 | Agent 集成 | 普通会话可通过 `kb_search` 工具检索知识库 | 工具在 `AgentManager.buildAgent()` 注册并可被模型调用 |
| 6 | 配置真正生效 | 主方案 13.1 表中的 14 个索引/检索项逐项影响行为 | 改 `chunkSize` 改变块数、改 `bm25K1` 改变排序、关 `sparseRetrieval` 走纯向量等 |

### 1.2 不在本次范围

- 云端知识库（`kind = shared / cloud` 的远端同步与账号级共享）
- 共享链接的权限模型（仍保持 `view` + token + 有效期）
- 图片/表格 OCR、多模态解析
- 引入 Milvus / Chroma / sqlite-vec 等外部或原生扩展

### 1.3 验收口径（可测）

| 验收项 | 方法 |
| --- | --- |
| 端到端闭环 | 隔离 `KE_WORK_HOME`：上传两种文件 → 建索引 → 重启应用 → 检索仍命中 |
| 配置生效 | 同一份文档分别用两套 `chunkSize` / `bm25K1` 建索引，块数与排序结果不同 |
| 降级 | 未配置 embedding 凭据时上传仍成功（纯稀疏），UI 明确提示「向量检索未启用」 |
| 失败可恢复 | 人为让 embedding 接口失败 → 文档 `failed` + `error_message` → 点重试后成功 |
| 隔离 | 未登录调用任一 `knowledge:*` 失败；A 用户无法读取 B 用户的库与切片 |
| 不回归 | 现有 19 个通道与页面（CRUD/上传/预览/共享/排序置顶）行为不变 |

---

## 二、页面功能与索引配置的完整对照

### 2.1 与索引/检索相关的页面功能（现状 → 本次要做）

| 功能点 | 入口 / 代码位置 | 现状 | 本次要做 |
| --- | --- | --- | --- |
| KP-19 索引状态与汇总 | `KnowledgePage.vue:256-281`（`indexTagText` / `indexStateText` / `indexedCount` / `fileSummary`） | 只可能显示「未索引」（`import` 恒传 `none`） | 用 `status`/进度显示「排队中 / 解析中 / 建立索引中 / 已索引 / 失败」；副标题补「索引中 N · 失败 N」 |
| KP-20 排序 | `changeSort` / `sortTree` | 已按 `sizeBytes`/时间戳排序 | 不改动（索引写切片时不动 `updated_at`，避免列表顺序跳动） |
| KP-21 / KP-22 上传（文件 / 文件夹 / 拖拽） | `KnowledgeUploadModal.vue`、`KnowledgePage.onUploadSubmit()` / `addFolderUpload()` | 已能取绝对路径 + `relPath`，但固定 `indexState=none` | 放开三选一；把 `config` 快照随导入提交并落库 |
| KP-23 查看详情 | `KnowledgeDetailModal.vue` / `detailItems` | 真实大小/时间/位置/索引状态 | 增切片数、实体数、字符数、是否截断、错误信息；增「重新索引」按钮 |
| KP-25 重建索引 | `rebuildIndex()`（当前仅 toast） | 无 IPC、无实现 | 接 `knowledge:reindex`（单文件 / 整库），订阅进度 |
| KP-28 待上传队列与去重 | `addFiles` / `queueKey` + 主进程 sha256 | 已实现 | 重复内容直接跳过（不重复消耗 embedding 调用）；与「已索引」状态联动提示 |
| KP-29 上传处理方式三选一 | `KNOWLEDGE_UPLOAD_OPTIONS` | 仅「只上传文件」可选 | 三选一全部可选；按方式写 `index_state` 与配置快照并触发索引 |
| KP-30 默认索引配置来源与预览 | `effectiveIndexConfig` / `defaultSummary` / `summarizeIndexConfig()` | 已按「全局 ← 按库覆盖」渲染 | 与主进程 `getEffective()` 保持同源（同 key、同区间），提交时用同一份值做快照 |
| KP-31 自定义索引向导 | `KNOWLEDGE_INDEX_STEPS`（4 步 / 14 项） | UI 已实现、不可达 | 提交时 `pickIndexConfig()` 只取 14 个索引项作为本次快照 |
| KP-32 配置校验 | `draftValueToOverride()` + `assertKnowledgeOverrides()` | 双端校验已实现 | 导入时主进程再校验一次配置快照（防止渲染层绕过） |
| KP-33 标签栏 / 文件预览 | `FilePreviewPane` + `knowledge:read-file` | 已实现（分页续读 + Markdown 相对图片） | 与索引解耦，不改动 |
| KP-34 知识库问答 | `ask()` + `.kb-qa-banner` | 固定文案「功能开发中」 | 接 `knowledge:ask` 流式 + 引用 + 取消；模型下拉接 `store/models` |
| KP-08 概览 | `KnowledgeOverviewModal.vue` + `knowledge:stats` | 4 张卡：知识库 / 文件 / 占用 / 最近更新 | 增切片数、实体数、索引中任务数；按文件数排序保留 |
| KP-36~KP-39 配置体系 | 设置页 + 按库弹窗 + `knowledgeFields.ts` | 读写与校验完整，但除目录与上传 3 项外无消费者 | 14 个索引/检索项接入引擎（见 2.3） |
| KP-42 用户隔离 | `session.requireUserId()` | 现有 19 通道已隔离 | 新增索引/检索/问答通道沿用；切片与图谱查询同时按 `kb_id + user_id` 过滤 |

### 2.2 索引配置的三层来源与合并规则

| 层级 | 入口 | 存储 | 覆盖范围 | 现有代码 |
| --- | --- | --- | --- | --- |
| 全局（18 项） | 用户菜单 →「设置」→ 左侧「知识库设置」 | `settings.json` | 全部知识库 | `SettingsStore` / `SettingsService`、`KnowledgeSettingsPage.vue` → `settingsStore.saveMany()` |
| 按库覆盖（17 项） | 条目三点菜单「知识库设置」/ 标题菜单「索引设置」 | `~/.ke-work/knowledge/kb-settings.json`（稀疏） | 单个知识库 | `KnowledgeSettingsStore` → `KnowledgeSettingsService.getEffective()` |
| 上传快照（14 项索引项） | 上传弹窗「创建默认索引 / 自定义索引」 | 随文档行落库（`knowledge_base_documents.config`，本次新增列） | 单次导入的这批文件 | `uploadIndex.ts` 的 `INDEX_FIELD_KEYS` / `pickIndexConfig()` / `summarizeIndexConfig()` |

**合并规则（必须三处一致）**

1. 生效配置 = **全局值 ← 按库逐项覆盖**；覆盖语义是「key 是否存在」，`false` / `0` / `1` 都是合法覆盖（主进程 `getEffective()`、渲染层 `effectiveFor()` 同规则）。
2. 上传时的**文档级快照** = 当时生效配置里的 14 个索引项（`INDEX_FIELD_KEYS`），不含上传 3 项与目录。
3. 检索（`knowledge:search` / `ask`）读**当前生效配置**；重建索引（`reindex`）同样用当前生效配置覆盖旧快照，保证「改了设置再重建」能生效。
4. 上传 3 项（`maxUploadSize` / `uploadTimeout` / `maxFilesPerBatch`）只在导入阶段消费，不落文档快照。

**附带修正**：`settings/schema.ts` 里 18 项 `knowledge.*` 目前全部 `applyTiming: pending`（UI 文案「后续版本生效」）。接入后改为 `instant`（保存即对后续索引生效；已在索引中的文档仍需重建，文案改为「修改后仅影响后续新增或重新索引的文件」）。

---

### 2.3 17 项配置 → 引擎消费点（逐项）

| 短 key | UI 标签 | 默认 | 取值 / 区间 | 生效阶段 | 引擎行为 | 降级 / 失败处理 |
| --- | --- | --- | --- | --- | --- | --- |
| `maxUploadSize` | 单文件最大大小 | 100 | 1~10240（MB，整数） | 导入 | 单文件超限直接 `failed`，不解析不索引 | 已实现 |
| `uploadTimeout` | 上传超时 | 10 | 1~600（分钟，整数） | 导入 | 整批 deadline，逐个文件前检查 | 超时文件 `failed` |
| `maxFilesPerBatch` | 单批次文件数 | 20 | 1~1000（整数） | 导入 | 超出部分计入 `skipped` 并回传原因 | 已实现 |
| `chunkStrategy` | 默认切片算法 | `semantic` | `semantic / fixed / markdown / recursive` | 切片 | 4 策略分派；`semantic` 按句向量相似度断点 | 无 embedding 凭据时降级为 `recursive`，并在文档上记 warning |
| `chunkSize` | 切片大小 | 800 | 100~8192（tokens，整数） | 切片 | 目标块长（按 `estimateTokens()` 计） | 越界由 schema 拒绝；单块超长按句号兜底切 |
| `chunkOverlap` | 重叠大小 | 120 | 0~4096（tokens，整数） | 切片 | 相邻块重叠 | `overlap >= size` 时钳到 `size/2` 并记 warning |
| `embeddingModel` | 向量化模型 | `text-embedding-3-large` | 枚举 + 自定义 | 向量化 | 解析 models.json 凭据 → POST `{baseURL}/embeddings` | 解析不到凭据 → 跳过向量化（纯稀疏），UI 提示「向量检索未启用」 |
| `vectorDimensions` | 向量维度 | 1024 | 1024 / 1536 / 3072 | 向量化 + 检索 | 请求 `dimensions`，校验返回长度 | 长度不符 → 该文档 `failed`（不写半截向量） |
| `sparseRetrieval` | 稀疏检索 | true | 布尔 | 检索 | 关则跳过 FTS5 分支 | 与向量同时不可用（无效组合）→ 检索报错并提示去设置页开启 |
| `bm25K1` | BM25 k1 | 1.5 | 0~10（数值） | 检索 | 作为 FTS5 `bm25(kb_chunk_fts, :k1, :b)` 实参 | 越界由 schema 拒绝 |
| `bm25B` | BM25 b | 0.75 | 0~1（数值） | 检索 | 同上 | 同上 |
| `hybridWeight` | 向量检索权重 | 0.65 | 0~1（数值） | 融合 | RRF 稠密分支权重 w（稀疏为 1-w） | 只有单路可用时忽略该权重 |
| `rerankEnabled` | 启用重排 | true | 布尔 | 重排 | 关则跳过；开则 POST `/rerank` | 端点/凭据不可用 → no-op 并回传 `rerankSkipped: true` |
| `rerankModel` | 重排模型 | `bge-reranker-v2-m3` | 枚举 + 自定义 | 重排 | 重排请求的 model 字段 | 同上 |
| `topK` | 召回 Top | 12 | 1~100（整数） | 检索 + 问答 | 稀疏/稠密各取 topK，融合后截断 topK | 无命中时返回空列表（问答回答「未找到相关内容」） |
| `graphEnabled` | 知识图谱抽取 | false | 布尔 | 图谱 | 开启才跑实体/关系抽取，并参与一跳扩展召回 | 抽取失败只记日志，文档仍进 `indexed` |
| `graphModel` | 抽取模型 | `GLM-5` | 枚举 + 自定义 | 图谱 | 经 models.json 取聊天模型（回退默认模型） | 无凭据 → 跳过抽取 |

### 2.4 页面状态与索引状态的映射

| 字段 | 取值 | 页面呈现 |
| --- | --- | --- |
| `index_state` | `none` | 行内标签「未索引」 |
| `index_state` | `default` | 不显示额外标签（默认已索引） |
| `index_state` | `custom` | 行内标签「自定义索引」 |
| `status` | `queued` / `indexing` | 行内标签「排队中 / 建立索引中 40%」，副标题计数「索引中 N」 |
| `status` | `indexed` | 与 `index_state` 组合显示 |
| `status` | `failed` | 红色标签「索引失败」，hover 显示 `error_message`，行菜单给「重试」 |

**阶段与进度（沿用主方案 10.3，对齐 web）**：`queued(0) → parsing(3) → chunking(15) → embedding(30) → bm25(55) → extracting(70) → indexed(100)`；失败 `failed`，取消 `canceled`（回落 `queued` 或 `none`）。

### 2.5 现状缺口清单（代码级）

| 层 | 缺口 | 证据 | 本方案落点 |
| --- | --- | --- | --- |
| 主进程服务 | 无索引/切片/向量/检索/重排/图谱/问答服务 | `src/main/knowledge/` 只有 7 个文件 | 第五章新增 7 个服务 |
| 数据层 | 无切片、向量、图谱与 FTS5 表；文档无进度与配置快照列 | `KnowledgeStore.MIGRATIONS` 仅 v1/v2，4 张表 | 第四章迁移 v3 |
| 导入 | 非 `none` 直接抛错 | `KnowledgeFileService.ts:91` | 按方式写 `index_state` 与快照并入队 |
| 文本读取 | 预览按 512KB 分页、默认 200KB、转换型上限 2MB，索引需要全文 | `FileLoaders.loadFileText` | 新增全量抽取方法（循环游标到上限 + `truncated` 落库） |
| IPC | 无 `reindex` / `search` / `ask` / `cancel-ask` / `activity` / `retry-doc` 与进度事件 | 已注册 19 通道均为管理/读取类 | 第六章新增 6 个通道 + 5 类事件 |
| 渲染层 | 上传三选一禁用、重建索引仅 toast、问答固定文案、详情无索引字段、概览无切片/实体 | `KnowledgePage.vue` / `KnowledgeUploadModal.vue` / `KnowledgeDetailModal.vue` / `KnowledgeOverviewModal.vue` | 第六章逐点改造 |
| 配置 | 14 项索引/检索配置无消费者，`applyTiming: pending` | 主方案 13.1 注 | 第二章逐项映射 + 保存即生效 |
| Agent | 无 `kb_search` 工具，`buildAgent()` 未 `setTools` | 全仓 grep 无命中 | P3 注册工具 |

---

## 三、目标架构

### 3.1 分层与新增 / 修改文件

| 层 | 文件 | 类型 | 说明 |
| --- | --- | --- | --- |
| 渲染层页面 | `views/KnowledgePage.vue` | 修改 | 上传三选一、索引状态/进度、重建索引、问答、概览入口 |
| 渲染层组件 | `components/knowledge/KnowledgeUploadModal.vue` | 修改 | 放开三选一、提交 config 快照、进度与结果文案 |
| 渲染层组件 | `KnowledgeDetailModal.vue` / `KnowledgeOverviewModal.vue` | 修改 | 详情补索引字段；概览补切片/实体/索引中 |
| 渲染层状态 | `store/knowledge.ts` | 修改 | 新增 `indexDoc` / `reindex` / `search` / `ask` / 进度与取消 |
| 桥接 | `src/preload/index.ts` / `index.d.ts` | 修改 | 新增 6 个方法与 5 类事件订阅（返回 off） |
| IPC | `src/main/ipc/knowledge-handlers.ts` | 修改 | 新增索引/检索/问答通道，沿用 ok/fail 与 `requireUserId` |
| 主进程编排 | `src/main/knowledge/KnowledgeIndexService.ts` | 新增 | 队列、状态机、进度事件、取消、幂等与重试 |
| 主进程切片 | `src/main/knowledge/ChunkingService.ts` | 新增 | 4 种切片策略 + `estimateTokens()` + heading |
| 主进程向量 | `src/main/knowledge/EmbeddingProvider.ts` | 新增 | 凭据解析、批量 `/embeddings`、维度校验、代理、缓存 |
| 主进程稀疏 | `src/main/knowledge/SparseIndexer.ts` | 新增 | `Intl.Segmenter` 分词 + FTS5 写入与 `bm25()` 查询 |
| 主进程检索 | `src/main/knowledge/RetrievalService.ts` | 新增 | 稀疏/稠密/RRF 加权/重排/图扩展/截断 |
| 主进程重排 | `src/main/knowledge/RerankProvider.ts` | 新增 | `/rerank` 调用与失败降级 |
| 主进程图谱 | `src/main/knowledge/GraphExtractor.ts` | 新增（P3） | 实体/关系抽取与一跳扩展 |
| 主进程问答 | `src/main/knowledge/KnowledgeQaService.ts` | 新增 | 检索 → 上下文与引用 → 聊天模型流式 |
| 数据层 | `KnowledgeStore.ts` | 修改 | 迁移 v3、切片/图谱仓储、FTS5 查询、统计扩展 |
| 文件层 | `KnowledgeFileService.ts` | 修改 | 全文抽取、导入时按方式写快照、删除级联清索引 |
| 装配 | `src/main/index.ts` | 修改 | 构造新服务、注入 `ModelService`、取消与退出清理 |

### 3.2 数据流

```
【索引】
上传(渲染层取绝对路径 + relPath)
  → knowledge:import（校验配额/去重 → 复制落盘 files/<kbId>/<docId>/）
  → 写 knowledge_base_documents（index_state + config 快照, status=queued）
  → KnowledgeIndexService.enqueue()
      parsing  : 全量抽取文本（loadFileText 循环游标，记录 char_count/truncated）
      chunking : ChunkingService.split(策略/大小/重叠) → chunks
      embedding: EmbeddingProvider.embed(批量) → chunk.embedding BLOB（可选）
      bm25     : SparseIndexer 分词写入 kb_chunk_fts（真 BM25）
      extracting: GraphExtractor（graphEnabled 时，可选）
      indexed  : 回写 status/progress/计数，推 knowledge:import-progress/done

【检索】
query → Intl.Segmenter 分词 → FTS5 bm25(k1,b) ｜ query 向量 → JS 余弦
  → RRF 加权融合(w=hybridWeight) → 重排(可选) → 图扩展(可选) → topK 截断
  → hits[{ chunkId, docId, docName, relPath, chunkIndex, heading, content, score, vecScore, bm25Score }]

【问答】
knowledge:ask(kbId, question, modelId?)
  → RetrievalService.retrieve() → 组装带 [n] 编号的上下文
  → 聊天模型流式（复用 ModelFactory 凭据）
  → knowledge:ask-chunk / ask-citation / ask-done / ask-error
```

### 3.3 文档索引状态机

| 阶段 | status | progress | 页面文案 | 失败 / 取消 |
| --- | --- | --- | --- | --- |
| 入队 | `queued` | 0 | 「排队中」 | 取消 → `none` |
| 解析 | `indexing` | 3 | 「解析文档」 | 解析失败 → `failed` |
| 切片 | `indexing` | 15 | 「文本切片」 | 同上 |
| 向量化 | `indexing` | 30 | 「向量化」 | 维度不符 / 接口失败 → `failed` |
| BM25 | `indexing` | 55 | 「建立倒排索引」 | 写 FTS5 失败 → `failed` |
| 图谱 | `indexing` | 70 | 「实体抽取」 | 失败仅记日志，继续到 `indexed` |
| 完成 | `indexed` | 100 | 「已索引」 | — |

> 每条阶段回写都遵循「先写库、后推事件」，保证渲染层刷新（`list-docs`）与事件两条路径看到的状态一致；应用启动时把残留的 `queued/indexing` 置为 `failed`（原因「应用退出中断」），避免僵尸态。

---

## 四、数据模型（迁移 v3）

### 4.1 设计原则

- 仍放在 `<knowledge.directory>/index.db`，沿用 `kb_meta.schema_version` 自管迁移（当前为 2），追加 `version: 3 / name: kb_rag_index`。
- **只加列加表，不改既有列语义**：`index_state` / `status` / `content_hash` / `error_message` 保持不变，旧库升级后可直接用。
- 向量存 BLOB（`Float32Array`），不引向量库；FTS5 的 `rowid` 对齐切片自增主键。
- **与主方案 9.2 的一处差异**：切片表**不冗余** `doc_name` / `doc_type`，检索结果用 `JOIN knowledge_base_documents` 取名称与相对路径。理由：重命名/移动文件时无需同步切片与 FTS 数据，只有 `rel_path` / `name` 一处真相。

### 4.2 既有表新增列

```sql
-- knowledge_base_documents：索引过程与结果
ALTER TABLE knowledge_base_documents ADD COLUMN progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_base_documents ADD COLUMN stage TEXT;              -- parsing/chunking/embedding/bm25/extracting
ALTER TABLE knowledge_base_documents ADD COLUMN char_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_base_documents ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_base_documents ADD COLUMN config TEXT;              -- 本次导入的 14 项索引配置快照(JSON)
ALTER TABLE knowledge_base_documents ADD COLUMN chunks_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_base_documents ADD COLUMN entities_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_base_documents ADD COLUMN relations_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_base_documents ADD COLUMN indexed_at INTEGER;

-- knowledge_bases：整库汇总（概览与列表用）
ALTER TABLE knowledge_bases ADD COLUMN chunks_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_bases ADD COLUMN entities_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_bases ADD COLUMN relations_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_bases ADD COLUMN indexed_docs_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_bases ADD COLUMN last_indexed_at INTEGER;
```

### 4.3 新增表

```sql
-- 切片：content 为原文；embedding 为 Float32 BLOB（无 provider 时为 NULL）
CREATE TABLE knowledge_base_chunks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,  -- 同时作为 kb_chunk_fts.rowid
  uid            TEXT NOT NULL UNIQUE,               -- 对外稳定标识（randomUUID）
  kb_id          TEXT NOT NULL,
  doc_id         TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  chunk_index    INTEGER NOT NULL,                   -- 文档内序号（0 起）
  content        TEXT NOT NULL,
  token_count    INTEGER NOT NULL DEFAULT 0,
  heading        TEXT,                               -- markdown 策略的标题路径
  char_start     INTEGER NOT NULL DEFAULT 0,         -- 原文偏移，便于定位与去重
  char_end       INTEGER NOT NULL DEFAULT 0,
  embedding      BLOB,
  embedding_model TEXT,
  embedding_dim  INTEGER,
  embedded_at    INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_kc_doc_chunk ON knowledge_base_chunks(doc_id, chunk_index);
CREATE INDEX idx_kc_kb ON knowledge_base_chunks(kb_id, user_id);
CREATE INDEX idx_kc_doc ON knowledge_base_chunks(doc_id);

-- 中文分词后的稀疏索引（contentless：原文在 chunks.content）
CREATE VIRTUAL TABLE kb_chunk_fts USING fts5(text_tokens, kb_id UNINDEXED, user_id UNINDEXED, content='', tokenize='unicode61');

-- 图谱（graphEnabled 时写入；P3）
CREATE TABLE knowledge_base_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kb_id TEXT NOT NULL, doc_id TEXT NOT NULL,
  user_id TEXT NOT NULL, chunk_id INTEGER, name TEXT NOT NULL, type TEXT NOT NULL,
  mentions INTEGER NOT NULL DEFAULT 1, source_text TEXT, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_ke_unique ON knowledge_base_entities(kb_id, doc_id, name, type);

CREATE TABLE knowledge_base_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kb_id TEXT NOT NULL, doc_id TEXT NOT NULL,
  user_id TEXT NOT NULL, chunk_id INTEGER, from_entity TEXT NOT NULL,
  to_entity TEXT NOT NULL, label TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_kr_kb ON knowledge_base_relations(kb_id, doc_id);
```

### 4.4 写入 / 清理策略

- **写入顺序**：先插 `chunks`（拿自增 id）→ 再插 `kb_chunk_fts(rowid, text_tokens)` → 再写 `embedding`。整个过程包在一个 `better-sqlite3` 事务里，避免「切片入库但 FTS 缺失」的半成品。
- **重建**：按 `doc_id` 先删 FTS（先查 rowid 再 `DELETE FROM kb_chunk_fts WHERE rowid = ?`）、再删 chunks/entities/relations，然后重新跑流水线（不重复落盘原始文件）。
- **删除文件/文件夹**：`KnowledgeFileService.removeDocuments()` 现在只删文档行与磁盘；新增「按 doc_id 集合清理索引」调用（与记录删除同一事务顺序：先清索引再删文档行）。
- **删库**：`KnowledgeService.deleteBase()` 级联清理该 `kb_id` 的全部切片/图谱/FTS 行（现有共享与磁盘清理保持）。
- **重命名**：不动索引数据（名称/路径从文档表 JOIN 得到），也不动 FTS。
- **体积**：1024 维 float32 约 4KB/块；1 万块约 40MB 向量 + 原文与 FTS 开销，属于可接受范围。

### 4.5 兼容与旧数据处理

1. 旧库（`schema_version = 2`）：启动时自动跑 v3，已有文档保持 `index_state = none / status = none`，不会自动建索引。
2. UI 兜底：知识库为空索引时，文件区副标题显示「N 份文件 · 索引功能开发中」的逻辑改为「N 份文件 · 0 份已建立索引」，并在知识库标题菜单/详情里提供「为全部文件建立索引」。
3. 历史 mock ID：`kb-settings.json` 里若残留旧 mock 知识库 id 的覆盖项，删除知识库时已会清理，不需要迁移。
4. 目录切换：`knowledge.directory` 变更即换一套 `index.db`（旧库不迁移），与现有语义一致，本方案不改变。

---

## 五、主进程服务设计

### 5.1 KnowledgeIndexService（编排 / 队列 / 取消 / 事件）

```ts
class KnowledgeIndexService {
  constructor(deps: {
    store: KnowledgeStore
    files: KnowledgeFileService
    chunking: ChunkingService
    embedding: EmbeddingProvider
    sparse: SparseIndexer
    graph: GraphExtractor
    settings: KnowledgeSettingsService
    onProgress: (p: KnowledgeIndexProgress) => void  // handler 注入 event.sender 守卫
  })

  enqueue(userId: string, kbId: string, docIds: string[]): { queued: number }
  cancel(userId: string, kbId: string, docIds?: string[]): { canceled: number }
  recoverOnStartup(): number   // queued/indexing → failed(应用退出中断)
  stats(userId: string): { indexingCount: number }
}
```

行为要点：

1. **串行队列**：并发 1（本地磁盘 + 主进程 CPU 友好），FIFO；同一 `docId` 在队列或运行中则跳过，避免重复建索引。
2. **配置来源**：每个文档开始时取一次 `settings.getEffective(userId, kbId)`；`config` 快照写入 `knowledge_base_documents.config`（JSON），保证「这次索引用的是哪套参数」可追溯。
3. **阶段推进**：按 3.3 的状态机逐阶段写库（`status/stage/progress`）后再推事件；每个阶段开始与结束都检查取消标志。
4. **进度节流**：embedding 阶段按批推送、其余阶段按阶段推送；同一文档 200ms 内最多推一次，避免 IPC 抖动。
5. **失败隔离**：单个文档失败不影响队列中其它文档；写入 `error_message` 后继续下一个。
6. **幂等**：若该文档 `status = indexed` 且 `content_hash` 未变、`config` 快照与当前生效配置一致，则可跳过（用于「整库重建」时避免重复消耗 embedding 调用）。
7. **取消**：`Map<docId, AbortController>`；取消后把状态回落为 `queued`（保留 `index_state`）或 `none`，并清理写了一半的 chunks（事务保证不会留下半截 FTS）。
8. **退出清理**：`app.on(before-quit)` 时 abort 全部并关闭 `index.db`；启动时 `recoverOnStartup()` 把残留 `queued/indexing` 置 `failed`。

### 5.2 ChunkingService（4 种切片策略）

```ts
interface Chunk {
  index: number; content: string; tokenCount: number
  heading?: string; charStart: number; charEnd: number
}
split(text: string, opts: { strategy: ChunkStrategy; chunkSize: number; chunkOverlap: number; embedder?: EmbeddingBatch }): Chunk[]
estimateTokens(text: string): number  // CJK 记 1，其余按 ceil(字符数 / 4)
```

| 策略 | 实现 | 备注 |
| --- | --- | --- |
| `recursive` | 分隔符 `[\\n\\n, \\n, 。, ！, ？, ., 空格, 空串]` 逐级递归合并到 `chunkSize` | 默认兜底；对齐 web `splitters.py` |
| `markdown` | 按 ATX 标题（`#..######`）分段，段内再递归切分 | 标题路径写入 `heading`（如「一级 / 二级」） |
| `fixed` | 按 `chunkSize` 的 token 估算换算窗口，相邻窗口回退 `chunkOverlap` | 简单可预期，适合日志/代码 |
| `semantic` | 先按句切分 → 批量算句向量 → 相邻余弦低于阈值处断点 → 合并到 `chunkSize` | 阈值先用常量 0.75；无 embedding 时降级 `recursive` |

边界处理（必须有单测）：空文本返回 `[]`；`overlap >= chunkSize` 时钳到 `chunkSize / 2`；超长单句按 `chunkSize` 硬切；`charStart/charEnd` 与原文可精确切片还原；全角标点与中英混排不丢字。

> **依赖取舍**：主方案曾建议引入 `@langchain/textsplitters`（当前未安装）。本方案建议**自研**（约 150~200 行、可完全掌控 token 估算与 heading 语义、零新增依赖）；若选择引库，接口保持不变，仅在 `split()` 内改实现。此点待确认。

### 5.3 文档全文抽取（索引侧）

现状（`FileLoaders.loadFileText`）：默认单次 200KB；预览显式 512KB 分页、可用 `cursor` 续读；纯文本 `cursor` 为字节偏移，docx/xlsx/pptx/pdf 为抽取文本字符偏移；转换型文档总上限 `MAX_CONVERTED_TEXT_CHARS = 2MB`。索引需要的是**整篇**，因此：

```ts
// KnowledgeFileService 新增（主进程内部调用，不经 IPC）
async readDocumentFullText(userId, kbId, docId): Promise<{ text: string; charCount: number; truncated: boolean }>
```

- 实现：循环 `loadFileText(path, ext, { cursor, maxChars: PREVIEW_PAGE_CHARS })` 累加，`truncated` 为 false 或累计达到 `INDEX_TEXT_LIMIT_CHARS`（取 2MB，与转换型上限一致）时停止。
- 结果落库：`char_count`、`truncated`；详情弹窗提示「文档过大，仅索引前 2MB」。
- 前置校验：源文件 > 20MB（`MAX_BINARY_BYTES`）或 `ppt` 旧格式 → 直接 `failed`，原因写 `error_message`。
- 不新增依赖、不改预览行为：预览仍走 512KB 分页，索引走全量循环。

### 5.4 EmbeddingProvider（向量化）

**凭据解析（本方案最大的前置不确定项）**：`ModelRecord` 目前没有「模型类型」字段，`url` 是 chat 端点（如 `https://api.deepseek.com/chat/completions`）。建议解析顺序：

1. `modelService.getCredential(embeddingModel)` 命中 → `baseURL = normalizeBaseUrl(url)`（去掉 `/chat/completions`），POST `{baseURL}/embeddings`。
2. 未命中 → 在 `models.json` 的全部模型中按 `id` 精确匹配；仍未命中则认为**无 embedding 凭据**。
3. 无凭据 → `available() = false`：跳过向量化（`chunking → bm25`），检索走纯稀疏，设置页/上传弹窗显示「向量检索未启用」。

> **待确认（建议同步做）**：在「系统设置 → 模型」增加模型类型（`chat / embedding / rerank`），或在设置页新增 `knowledge.embeddingEndpoint` / `rerankEndpoint`；否则用户无法直观表达「这个 apiKey/端点用来做向量化」。在决策落地前，用「默认 embedding 模型名与 models.json 里已有模型同名」这条路径先跑通。

请求与校验：

- `POST {baseURL}/embeddings`，body `{ model, input: string[], encoding_format: float }`；兼容端点忽略未知字段。
- 批量 32 条/批（常量 `EMBED_BATCH_SIZE`），指数退避重试 2 次，单批超时 60s。
- **代理显式处理**：读 `network.proxyMode` / `network.proxyUrl` 构造 axios `httpsAgent`（axios 不走 Electron session，见主方案 2.2 第 2 个坑）。
- 维度校验：返回向量长度 !== `vectorDimensions` → 抛错，文档 `failed`（避免静默写坏索引）。
- 存储：`Float32Array` 的 buffer 直接写 `embedding` BLOB，并记 `embedding_model` / `embedding_dim`。
- 可选缓存（P2）：按 `sha1(model + dim + chunkText)` 复用向量，重建索引时显著省调用。

---

### 5.5 SparseIndexer（FTS5 + Intl.Segmenter）

```ts
class SparseIndexer {
  tokenize(text: string): string   // Intl.Segmenter(zh, { granularity: word }) → 去空白/标点 → 空格拼接
  insert(chunkIds: number[], texts: string[], kbId: string, userId: string): void
  remove(chunkIds: number[]): void
  search(kbId, userId, query, opts: { k1: number; b: number; limit: number }): SparsHit[]
}
// SparsHit = { chunkId: number; bm25: number }
```

- **写入**：`INSERT INTO kb_chunk_fts(rowid, text_tokens, kb_id, user_id) VALUES (?, ?, ?, ?)`，与 chunks 同事务。
- **查询**：`WHERE kb_chunk_fts MATCH ? AND kb_id = ? AND user_id = ? ORDER BY bm25(kb_chunk_fts, :k1, :b) LIMIT ?`；FTS5 `bm25()` 返回负数（越小越相关），对外分数取 `-bm25` 便于展示。
- **过滤**：FTS 表带 `kb_id / user_id UNINDEXED` 两列，避免「先全库检索再过滤」；删除文档时按 chunk id 精确删除。
- **中文**：`Intl.Segmenter` 零依赖、Electron 内置；查询串同样先分词。分词后 token 少于 2 个时，额外做一次 `content LIKE %q%` 兜底（上限 50 条）。
- **空查询**：分词后无有效 token → 直接返回空结果，不落到 SQL。

### 5.6 RetrievalService（检索与融合）

```ts
interface Hit {
  chunkId: number; docId: string; docName: string; relPath: string
  chunkIndex: number; heading: string (可空); content: string
  score: number; vecScore: number (可空); bm25Score: number (可空)
  source: sparse / dense / graph
}
retrieve(input: { userId, kbId, query, topK?, mode?: hybrid / sparse / dense }): Promise<{
  hits: Hit[]; rerankSkipped: boolean; sparseSkipped: boolean; vectorSkipped: boolean
}>
```

1. **稀疏分支**：`sparseRetrieval = true` 时执行（见 5.5），否则标记 `sparseSkipped`。
2. **稠密分支**：`embedding.available(embeddingModel)` 且该库存在非空向量时执行；查询向量化后对候选块做 JS 内暴力余弦（`Float32Array` 逐位累乘，读 BLOB 后不转数组）。
3. **融合（RRF 加权）**：两路都有结果时 `score = w / (60 + rankDense) + (1 - w) / (60 + rankSparse)`，`w = hybridWeight`，rank 从 1 起；只有单路时直接用该路排名（不做 RRF，避免放大单路噪声）。
4. **重排**：`rerankEnabled` 且 RerankProvider 可用 → 取融合前 `topK * 3` 候选重排后截断 `topK`；不可用或调用失败 → `rerankSkipped = true`，保留融合顺序。
5. **图扩展（P3）**：`graphEnabled` 时用命中块内的实体做一跳关联召回，追加候选并标记 `source = graph`（权重低于主结果）。
6. **截断与返回**：最终 `topK` 条；每条命中带文档名与相对路径（JOIN `knowledge_base_documents`，见 4.1 的差异说明），渲染层据此显示引用。
7. **性能**：候选规模按该库全部非空向量估计；万级块 × 1024 维单次扫描约几十毫秒，符合主方案「不引向量库」的决策。超过 10 万块再评估 `sqlite-vec`（主方案第十一章第 2 条）。

### 5.7 RerankProvider（重排，P2）

- 凭据解析与代理策略同 5.4；端点 `POST {baseURL}/rerank`，body `{ model, query, documents: string[], top_n }`。
- 解析 `results[]` 的 `index` / `relevance_score` 映射回原始候选；返回 null 表示不可用（调用方 no-op）。
- 不同厂商字段名可能不同（`score` / `relevance_score`），解析时两者兼容；失败只记日志并降级。

### 5.8 GraphExtractor（图谱抽取，P3）

- `graphEnabled` 时按块抽取：聊天模型经 `ModelService.getCredential(graphModel)` → `createModelFromCredential()`，取不到则回退 `resolveDefaultModel()`。
- 结构化输出：`{ entities: [{ name, type, source_text }], relations: [{ from, to, label, weight }] }`；实体类型移植 web `graph_service.py`（人物/组织/概念/产品/地点/时间/模型/算法/框架/技术）。
- 落库去重：实体按 `(kb_id, doc_id, name, type)` upsert，`mentions` 累加；关系按 `(kb_id, doc_id, from_entity, to_entity, label)` 去重。
- **失败不阻断**：抽取异常只记日志并跳过，文档仍然 `indexed`（与 web 一致）。
- 检索侧 `expandByGraph(seedEntities, hops = 1)` 提供一跳关联召回。

### 5.9 KnowledgeQaService（问答，P2）

```ts
ask(input: {
  userId; kbId; question; modelId?
  onCitations: (citations: Citation[]) => void
  onChunk: (text: string) => void
  signal: AbortSignal
}): Promise<{ ok: boolean; error?: string }>
```

1. 先 `retrieve()`（用当前生效配置）；**无命中**时直接回答「知识库中没有找到与该问题相关的内容」，不编造并结束。
2. 上下文拼装：每条命中带 `[n] 文档名 › 相对路径 › 切片 #k` 前缀；总预算约 6k tokens，按分数从高到低装填，超出即止。
3. 模型：`modelId` 经 `getCredential()` 校验，失败回退默认模型（与 `agent:send` 的 customModelId 处理一致）。
4. System Prompt 约束：只依据给定上下文；引用用 `[n]` 标注；无依据时说不知道。
5. 流式：`for await (const piece of model.stream(messages))` → `onChunk`（IPC 推 `knowledge:ask-chunk`）；引用在开始时一次性推送。
6. 取消：`Map<windowId, AbortController>`（沿用主进程现有 `abortControllers` 模式）；取消推 `knowledge:ask-done { canceled: true }`。
7. 登录退出：`cancelAllAgents()` 同一处一并取消所有问答。

---

## 六、IPC / Preload / 渲染层契约

### 6.1 新增通道

全部通道沿用现有约定：先 `session.requireUserId()`，返回 `{ success: true, data }` 或 `{ success: false, error }`；渲染层只传 ID 与库内相对路径。

| 通道 | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `knowledge:reindex` | `kbId, relPaths?` | `{ queued: number }` | 省略 relPaths = 整库；入队后走本节点进度事件 |
| `knowledge:retry-doc` | `kbId, relPath` | `{ queued: true }` | 仅 `failed` 允许重试 |
| `knowledge:cancel-index` | `kbId, relPaths?` | `{ canceled: number }` | 取消排队与运行中任务 |
| `knowledge:search` | `{ kbId, query, topK?, mode? }` | `{ hits, rerankSkipped, sparseSkipped, vectorSkipped }` | 同步检索（无流式） |
| `knowledge:ask` | `{ kbId, question, modelId? }` | `{ started: true }` | 结果走 ask-* 事件 |
| `knowledge:cancel-ask` | `kbId` | `{ aborted: true }` | 按窗口 id 取消 |
| `knowledge:activity` | `{ kbId?, limit? }` | `IndexActivity[]` | 概览「最近索引活动」（P3，可选） |

**既有通道的一处扩展**：`knowledge:import` 由 `(kbId, items, indexState)` 扩展为 `(kbId, items, indexState, config?)`，`config` 为本次导入的索引项快照（默认索引可省略，由主进程取生效配置；自定义索引必须传）。

### 6.2 事件（主进程 → 渲染层）

| 事件 | 载荷 | 用途 |
| --- | --- | --- |
| `knowledge:import-progress` | `{ kbId, docId, relPath, status, stage, progress, chunks, entities, relations, error? }` | 阶段进度与计数 |
| `knowledge:import-done` | `{ kbId, docId }` | 单文档完成 |
| `knowledge:import-error` | `{ kbId, docId, error }` | 单文档失败（详情可看 error_message） |
| `knowledge:ask-chunk` | `{ kbId, text }` | 问答流式增量 |
| `knowledge:ask-citation` | `{ kbId, citations }` | 引用来源（开始时一次性推送） |
| `knowledge:ask-done` | `{ kbId, canceled? }` | 结束（含取消） |
| `knowledge:ask-error` | `{ kbId, error }` | 失败 |

推送实现沿用 `expert-sync:progress` 的写法：从 `IpcMainInvokeEvent` 取 `event.sender`，先判 `isDestroyed()` 再 `send()`；订阅端沿用 `onAgentChunk` 的「返回 off 函数」写法（`ipcRenderer.removeListener`）。

### 6.3 渲染层 store 扩展（`store/knowledge.ts`）

- **state**：`indexProgress: Record<docId, { status; stage; progress; chunks }>`、`searchState`（结果 + 三个 skipped 标记）、`askState`（question / answer / citations / streaming / error）。
- **actions**：`reindex(relPaths?)`、`retryDoc(relPath)`、`cancelIndex(relPaths?)`、`search(query, options)`、`ask(question, modelId)`、`cancelAsk()`。
- **订阅**：在 store 初始化时订阅 7 个事件并写入 `indexProgress` / `askState`；返回的 off 在 store 的 `reset()`（登出）里调用。事件到达后用 `loadDocuments(kbId)` 或局部 patch 同步文档列表。
- 所有 IPC 继续走 `call()` 收敛，避免「点了没反应」（主方案 18.7.1 的教训）。

### 6.4 页面改造逐点

| 位置 | 现在 | 改造后 |
| --- | --- | --- |
| 上传弹窗处理方式 | 仅「只上传文件」可选 | 三项全开；默认索引显示生效配置摘要，自定义索引进 4 步向导 |
| 上传提交 | 固定 indexState 为 none | 按所选方式传 indexState（default / custom / none）与 config 快照 |
| 文件行索引标签 | 只能「未索引」 | 「排队中 / 建立索引中 N% / 已索引 / 自定义索引 / 失败（红）」 |
| 文件区副标题 | 「N 份文件 · 索引功能开发中」 | 「N 份文件 · M 份已建立索引 · K 索引中」，失败单独计数 |
| 文件行菜单 | 「重建索引」仅 toast | 接 knowledge:reindex；失败项追加「重试」；运行中追加「取消索引」 |
| 知识库标题菜单 | 重命名 / 打开文件夹 / 创建共享 / 索引设置 / 删除 | 增「为全部文件建立索引」（整库重建） |
| 详情弹窗 | 大小 / 更新时间 / 位置 / 索引状态 | 增切片数、实体数、字符数、截断提示、错误信息与「重新索引」 |
| 问答面板 | 固定文案提示 | 真实检索问答：流式回答 + 引用列表 + 取消 + 错误态；模型下拉接 store/models |
| 概览弹窗 | 4 张文件维度卡片 | 增切片数 / 实体数 / 索引中任务；保留按文件数排序 |
| 设置页 | 「索引与检索能力开发中」 | 改为「已生效：本地存储、文件上传、RAG 索引、混合检索与重排、知识图谱抽取」；保留「修改仅影响后续新增或重新索引的文件」 |

---

## 七、实施步骤（按价值与依赖排序）

原则：**先用零模型依赖的稀疏链路跑通闭环**（P0），再叠加向量、重排、问答与图谱；每一阶段结束都能独立验收，不出现「半截功能」。

### P0：稀疏索引闭环（可独立交付，不依赖任何模型）

| 步骤 | 内容 | 主要文件 |
| --- | --- | --- |
| 1 数据层 | 迁移 v3（4.2 / 4.3）；仓储：切片插入/按文档删除/按库统计/FTS 写入与查询；启动恢复僵尸态 | `KnowledgeStore.ts` |
| 2 切片 | 4 种策略 + token 估算 + 边界处理 + 单测 | `ChunkingService.ts`（新） |
| 3 分词与 FTS | `Intl.Segmenter` 分词、写入与 `bm25(k1, b)` 查询、LIKE 兜底 | `SparseIndexer.ts`（新） |
| 4 编排 | 队列、状态机、进度节流、取消、幂等、启动恢复 | `KnowledgeIndexService.ts`（新） |
| 5 导入打通 | 去掉「仅 none」，按方式写 `index_state` 与配置快照并入队；`knowledge:import` 增加 `config` 参数 | `KnowledgeFileService.ts`、`knowledge-handlers.ts` |
| 6 索引管理通道 | `reindex` / `retry-doc` / `cancel-index` / `search` + 进度事件 | `knowledge-handlers.ts`、`preload/index.*` |
| 7 渲染层 | 上传三选一放开、状态与进度标签、副标题、详情字段、行菜单（重建/重试/取消）、概览入口 | `KnowledgePage.vue`、`KnowledgeUploadModal.vue`、`KnowledgeDetailModal.vue`、`store/knowledge.ts` |

**P0 验收**：在完全未配置 embedding 的环境下，上传文件 → 列表走到「已索引」→ 重启应用后仍在 → `knowledge:search` 能按中文关键词命中并返回片段；改 `bm25K1` 后重建，排序结果变化。

### P1：向量化与混合检索

| 步骤 | 内容 | 主要文件 |
| --- | --- | --- |
| 8 向量化 | 凭据解析（5.4）、批量 `/embeddings`、显式代理、维度校验、BLOB 落库 | `EmbeddingProvider.ts`（新） |
| 9 稠密检索 | 查询向量化 + JS 暴力余弦 + 与稀疏的 RRF 加权融合 | `RetrievalService.ts`（新） |
| 10 降级与提示 | 无凭据时跳过向量化并在上传弹窗/设置页显示「向量检索未启用」 | `KnowledgeSettingsPage.vue`、`KnowledgeUploadModal.vue` |

**P1 验收**：同一批文档在「有/无 embedding 凭据」两种环境下都能建索引；配了凭据后混合检索能命中语义相近但不含关键词的片段；维度填错时该文档失败并给出明确原因。

### P2：重排与知识库问答

| 步骤 | 内容 | 主要文件 |
| --- | --- | --- |
| 11 重排 | `/rerank` 调用、`rerankSkipped` 降级 | `RerankProvider.ts`（新） |
| 12 问答服务 | 检索 → 上下文与引用 → 聊天模型流式；无命中不编造 | `KnowledgeQaService.ts`（新） |
| 13 问答通道与事件 | `ask` / `cancel-ask` + `ask-chunk/citation/done/error` | `knowledge-handlers.ts`、`preload/index.*` |
| 14 问答 UI | 流式渲染、引用列表、取消按钮、错误态；模型下拉接 `store/models` | `KnowledgePage.vue`、`store/knowledge.ts` |

**P2 验收**：提问后能看到流式回答与引用；点取消立即停下；问知识库里没有的内容时回答「未找到相关内容」；embedding/rerank 未配置时仍可问答（纯稀疏）。

### P3：图谱、Agent 工具与体验增强

| 步骤 | 内容 | 主要文件 |
| --- | --- | --- |
| 15 图谱抽取 | `graphEnabled` 时按块抽取实体与关系、一跳扩展召回 | `GraphExtractor.ts`（新） |
| 16 Agent 工具 | `kb_search`（+ `list_knowledge_bases`）注册到 `AgentManager.buildAgent()` | `agent/tools/KnowledgeTool.ts`（新）、`AgentManager.ts` |
| 17 概览增强 | `knowledge:activity` + 切片/实体/索引中统计 | `knowledge-handlers.ts`、`KnowledgeOverviewModal.vue` |
| 18 性能与成本 | embedding 结果缓存、批量调优、必要时 `worker_threads` 承载解析/切片 | `EmbeddingProvider.ts`、`KnowledgeIndexService.ts` |
| 19 云端预留 | `CloudKnowledgeRepository` 接口与字段映射（不在本次实现） | `database/repositories/`（规划） |

**粗略工作量（单人，按现有代码基础）**：P0 约 5~7 天，P1 约 3~4 天，P2 约 3~4 天，P3 约 4~6 天；其中 P1 的凭据模型决策与 P3 的图谱提示词移植是主要不确定项。

---

## 八、测试策略

### 8.1 单元测试（`tests/unit`）

| 对象 | 用例 |
| --- | --- |
| `ChunkingService` | 4 策略各 2~3 例；空文本 / 超长单句 / 中英混排 / `overlap >= chunkSize` / markdown 标题路径 / `charStart-charEnd` 可还原原文 |
| `estimateTokens` | 纯中文、纯英文、混合、空串 |
| `SparseIndexer` | 中文分词结果稳定、MATCH 语法转义、空查询返回空、`bm25` 参数改变排序 |
| `RetrievalService` | RRF 加权公式（含单路降级）、`topK` 截断、`rerankSkipped`、空结果 |
| `EmbeddingProvider` | 凭据解析分支、维度不符抛错、批量切分、代理配置组装（axios 桩） |
| `KnowledgeIndexService` | 状态机顺序、失败隔离、取消、`recoverOnStartup()`、幂等跳过 |
| 配置一致性 | 渲染层 `knowledgeFields` 与主进程 `SETTINGS_SCHEMA` 的 key/区间/枚举一致（沿用现有单测钉住）；上传快照 = `INDEX_FIELD_KEYS` |

### 8.2 集成测试（真实 SQLite，`ELECTRON_RUN_AS_NODE=1` 运行）

- 导入 → 索引（桩向量化）→ 检索闭环；断言 `chunks` / `kb_chunk_fts` / 文档计数一致。
- **配置真正生效**：`bm25K1` / `bm25B` 改变 → 同一查询排序变化；`chunkSize` 改变 → 块数变化。
- 重建索引：同一文档重建后 chunk 数按新配置变化，且旧 FTS 行被清理（`kb_chunk_fts` 无孤儿 rowid）。
- 重命名后检索仍命中（验证 JOIN 而非冗余列）；删除文件夹后该前缀下所有切片与 FTS 行被清除。
- 重启（重新构造服务）后索引数据仍在，检索结果一致。
- 迁移：`schema_version = 2` 的旧库升级到 3，旧文档保持 `none` 且不报错。

### 8.3 安全与隔离

- 未登录调用任一新增通道失败；A 用户的 `kbId` 在 B 用户下返回「知识库不存在」。
- FTS 查询串先分词再拼 MATCH，禁止把原始用户输入直接拼进 MATCH（防语法错误与注入）。
- 检索结果只返回 `relPath` 与文档名，不返回 `storage_path`。

### 8.4 端到端（Playwright + 真实 Electron）

1. 新建知识库 → 上传 Markdown（选「创建默认索引」）→ 列表出现「建立索引中」→ 变「已索引」。
2. 搜索结果出现在问答/检索 UI，引用可定位到文件。
3. 提问 → 流式回答 + 引用；取消按钮生效。
4. 重启应用 → 索引状态、检索与问答仍可用。
5. 把 embedding 模型改成不存在的名字 → 重建后文档失败并显示原因 → 改回后重试成功。

### 8.5 性能基线（验收参考）

| 场景 | 目标 |
| --- | --- |
| 单文件 1MB / 约 500 块索引 | < 3s（不含 embedding 网络耗时） |
| 1000 文件 / 约 1 万块首建 | 可后台完成，UI 不卡顿（进度可见、可取消） |
| 检索（1 万块，稀疏 + 稠密） | < 300ms |
| 索引库体积（1 万块 + 1024 维向量） | 约 40~80MB |

---

## 九、风险与待确认

| # | 风险 / 待确认 | 影响 | 建议 |
| --- | --- | --- | --- |
| 1 | `models.json` 没有「模型类型」，`embeddingModel` / `rerankModel` 可能匹配不到可用凭据 | P1 向量化与重排无法真正生效（只能纯稀疏） | **最高优先级待确认**：模型配置增加类型（chat / embedding / rerank），或新增 `knowledge.embeddingEndpoint` / `rerankEndpoint`；决策前先用「与已有模型同名」的路径 |
| 2 | 与 web/backend 的配置口径差异（chunkSize 800 vs 512、topK 12 vs 5、sparse 布尔 vs 枚举、graphModel 单个 vs 两个、rerank 默认值相反） | 云端模式同一份配置两边解释不同 | 按主方案 5.3 先定共享契约；桌面默认值本方案保持现状，字段映射后置到云端对接阶段 |
| 3 | web 的 BM25 实为客户端 TF 计数、`bm25_k1/bm25_b` 未被读取 | 两端检索质量不一致 | 保留桌面「FTS5 真 BM25」的既有决策（主方案第八章） |
| 4 | 大文件解析/切片占用主进程 | UI 卡顿、索引变慢 | 2MB 文本截断 + 批量间让出事件循环；>20MB 直接拒绝；P3 视情况用 `worker_threads` |
| 5 | 中文分词与查询召回 | 短查询/新词召回不足 | `Intl.Segmenter` + 短查询 LIKE 兜底；后续可评估更强分词（需权衡原生依赖） |
| 6 | 旧库文档不会自动建索引 | 用户误以为「已索引」 | 副标题显示真实计数 + 「为全部文件建立索引」入口 + 首次进入的引导提示 |
| 7 | embedding 调用成本与限流 | 费用、批量失败 | 内容哈希去重（已有）+ 向量缓存（P3）+ 批量 32 + 重试 2 次 + 可取消 |
| 8 | FTS5 在目标环境不可用 | 稀疏检索直接不可用 | 启动自检（建表失败即在设置页提示）；本机 `better-sqlite3` 已编译 FTS5，补单测断言 |
| 9 | 索引库体积增长 | 磁盘占用 | 向量 4KB/块；设置页复用 `computeDirSize()` 展示占用（后续） |
| 10 | 未启用重排时的相关性提示 | 用户以为检索不准 | 检索结果带 `rerankSkipped` 时在 UI 轻提示「未启用重排」 |

---

## 十、附录

### 10.1 配置速查（本次接入的 17 项 + 目录）

- **索引 6 项**：`chunkStrategy` / `chunkSize` / `chunkOverlap`（切片） + `embeddingModel` / `vectorDimensions`（向量化）
- **检索与重排 7 项**：`sparseRetrieval` / `bm25K1` / `bm25B` / `hybridWeight` / `rerankEnabled` / `rerankModel` / `topK` 
- **图谱 2 项**：`graphEnabled` / `graphModel` ；**上传 3 项**：`maxUploadSize` / `uploadTimeout` / `maxFilesPerBatch` ；**目录**：`knowledge.directory` 

### 10.2 新增 / 修改文件清单

| 类型 | 文件 |
| --- | --- |
| 新增服务 | `src/main/knowledge/{KnowledgeIndexService,ChunkingService,EmbeddingProvider,RerankProvider,SparseIndexer,RetrievalService,GraphExtractor,KnowledgeQaService}.ts` |
| 修改服务 | `KnowledgeStore.ts`（迁移 v3 + 仓储）、`KnowledgeFileService.ts`（全文抽取 + 导入方式 + 级联清理）、`KnowledgeService.ts`（reindex/search/ask 门面） |
| 修改 IPC / 桥接 | `src/main/ipc/knowledge-handlers.ts`、`src/preload/index.ts`、`src/preload/index.d.ts`、`src/main/index.ts`（装配与取消） |
| 修改渲染层 | `views/KnowledgePage.vue`、`store/knowledge.ts`、`components/knowledge/{KnowledgeUploadModal,KnowledgeDetailModal,KnowledgeOverviewModal}.vue`、`components/settings/pages/KnowledgeSettingsPage.vue` |
| 修改配置 | `src/main/settings/schema.ts`（知识库项 `applyTiming` 改 `instant`） |
| P3 新增 | `src/main/agent/tools/KnowledgeTool.ts`、`src/main/agent/AgentManager.ts`（setTools） |

### 10.3 与主方案章节的对应关系

| 主方案 | 本方案落点 |
| --- | --- |
| 9.2 目标数据模型 | 第四章（迁移 v3；不冗余 doc_name/doc_type 的差异见 4.1） |
| 10.2 ChunkingService | 5.2 |
| 10.3 IngestionPipeline | 3.3（状态机）+ 5.1（队列与事件） |
| 10.4 EmbeddingProvider | 5.4 |
| 10.5 RetrievalService | 5.6（+ 5.5 稀疏、5.7 重排） |
| 10.6 GraphExtractor | 5.8（P3） |
| 13.1 配置消费路径 | 2.3（逐项映射） |
| 14.2 规划中通道与事件 | 6.1 / 6.2 |
| 18.6 接入索引的改动点 | 第七章（P0~P3） |

### 10.4 需要拍板的三件事

1. **切片实现**：自研（推荐，零新增依赖）还是引入 `@langchain/textsplitters`。
2. **embedding / rerank 凭据来源**：模型配置加类型，还是设置页新增端点配置（影响 5.4 的解析顺序）。
3. **与 web/backend 的口径**：先按桌面默认值实现、云端阶段再做映射，还是先统一共享契约（影响 2.3 与云端对接成本）。

