"""Knowledge Base API — Pydantic schemas."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

# ─── IndexConfig ────────────────────────────────────────────────────────────

class IndexConfigSchema(BaseModel):
    """索引配置（对应前端 IndexConfig）。

    provider 字段可空：为空时按模型名在全部提供商中解析（``select_usable_models``
    的兜底顺序），指定后则把解析范围收窄到该提供商，避免同名模型歧义。
    """
    chunk_strategy: str = Field(
        default="recursive",
        description="fixed|recursive|semantic|markdown|agentic|parent_child；"
                    "parent_child 下 chunk_size 表示**子块**大小",
    )
    chunk_size: int = Field(default=512, ge=128, le=2048)
    chunk_overlap: int = Field(default=64, ge=0, le=512)
    #: 父子块策略的父块大小（承载返回给用户/模型的上下文）
    parent_chunk_size: int = Field(default=1536, ge=256, le=8192)
    #: 最小块长：低于该长度的切片并入相邻块，避免"只有标题"的碎片进入索引
    min_chunk_size: int = Field(default=32, ge=0, le=512)
    embedding_model: str = Field(default="text-embedding-v4")
    embedding_provider_id: str | None = Field(default=None, description="embedding 模型所属提供商")
    embedding_dim: int = Field(default=1024)
    sparse_algo: str = Field(default="bm25", description="bm25|bm25_plus|tf_idf|none")
    bm25_k1: float = Field(default=1.5)
    bm25_b: float = Field(default=0.75)
    entity_model: str = Field(default="deepseek-v3")
    relation_model: str = Field(default="deepseek-v3")
    enable_graph: bool = Field(default=True)
    reranker_model: str = Field(default="bge-reranker-v2-m3")
    reranker_provider_id: str | None = Field(default=None, description="reranker 模型所属提供商")
    #: 精排默认开启：它是当前性价比最高的质量开关（默认关闭时"配了但没生效"，
    #: 用户很难发现）。模型不可用时检索会如实标注 rerank_applied=false。
    enable_reranker: bool = Field(default=True)
    top_k: int = Field(default=5, ge=1, le=50)
    hybrid_alpha: float = Field(default=0.7, ge=0.0, le=1.0)
    #: 最低余弦相似度——最高相似度低于该值时判定"知识库中没有相关内容"。
    #: 0.53 由黄金集校准（见 search_service.DEFAULT_MIN_SIMILARITY）
    min_similarity: float = Field(default=0.53, ge=0.0, le=1.0)
    #: 相对截断：丢弃低于「最高分 × 该比例」的结果，0 表示不截断
    score_threshold: float = Field(default=0.0, ge=0.0, le=1.0)
    #: 同一文档最多占用的结果条数（0 表示不限制；候选只来自一个文档时自动失效）
    max_chunks_per_doc: int = Field(default=3, ge=0, le=20)
    #: 近重复判定阈值：与已选结果余弦相似度 ≥ 该值的候选被丢弃，0 表示关闭
    dedup_similarity: float = Field(default=0.92, ge=0.0, le=1.0)
    #: 查询改写默认**关闭**：每次检索要多发一次 LLM 调用（延迟 + 成本），
    #: 按方案 §12.1 的灰度策略"默认关闭、按库开启"。改写失败的降级路径已覆盖，
    #: 开启后最坏情况是回到改写前的行为（原始查询始终参与召回）。
    enable_query_rewrite: bool = Field(default=False)
    #: HyDE（假设文档嵌入）默认关闭：它会在多路召回里增加一路"最不像查询、
    #: 最像答案"的变体，对语义类问题收益明显，但会让延迟再涨一截。
    enable_hyde: bool = Field(default=False)
    #: OCR 默认**关闭**：扫描件与图片会逐页调用外部视觉模型（延迟、费用、内容出网），
    #: 按方案 §12.1 的灰度策略"默认关闭、按库开启"。开启后同时覆盖扫描件 PDF、
    #: 直接上传的图片，以及文档内嵌图片的说明文字。
    enable_ocr: bool = Field(default=False)
    #: OCR 用的视觉模型（模型页 type=vision）。留空时按模型页顺序取第一个可用者，
    #: 与 reranker_model 的解析方式一致。
    ocr_model: str = Field(default="", description="留空时取模型页第一个可用的 vision 模型")
    ocr_provider_id: str | None = Field(default=None, description="OCR 模型所属提供商")


# ─── KnowledgeBase ──────────────────────────────────────────────────────────

class KBCreateRequest(BaseModel):
    """创建知识库请求（对应前端 CreateKBRequest）。"""
    name: str = Field(..., min_length=1, max_length=128)
    description: str = ""
    tags: list[str] = []
    config: IndexConfigSchema = Field(default_factory=IndexConfigSchema)
    visibility: Literal["private", "public"] | None = Field(
        default=None, description="可见范围，缺省 private"
    )


class KBUpdateRequest(BaseModel):
    """更新知识库请求。"""
    name: str | None = Field(default=None, max_length=128)
    description: str | None = None
    tags: list[str] | None = None
    config: IndexConfigSchema | None = None
    visibility: Literal["private", "public"] | None = Field(
        default=None, description="可见范围：private 私有 | public 公共"
    )


class KBResponse(BaseModel):
    """知识库响应。"""
    id: str
    name: str
    description: str
    status: str
    docs_count: int
    chunks_count: int
    entities_count: int
    relations_count: int
    size_bytes: int
    size_display: str
    tags: list[str]
    config: IndexConfigSchema
    created_at: datetime
    updated_at: datetime
    visibility: str = "private"
    is_owner: bool = True
    owner_name: str | None = None
    #: 访问级别（迭代 6 T6.3）：owner 可读写可管理 | write 可改内容 | read 只读。
    #: ``is_owner`` 保留 = ``access == "owner"``——前端 12 处消费点里只有文档页签
    #: 需要看 write，其余（配置/图谱/发布/组织/删除）本就是库主专属
    access: str = "owner"
    #: 置顶与手工排序（迭代 6 T6.2）——**本人列表视图偏好**，只影响自己的排序
    is_pinned: bool = False
    sort_order: int = 0
    group_id: str | None = None

    model_config = {"from_attributes": True}


class KBShareLinkCreateRequest(BaseModel):
    """创建链接分享。"""
    permission: Literal["read", "write"] = "read"
    #: 有效期档位（枚举而非任意天数：服务端才能硬编码上限）
    expires_in: Literal["1d", "7d", "30d", "never"] = "never"


class KBShareLinkPreview(BaseModel):
    """免登录预览的响应——**字段白名单**。

    用显式模型而不是 ``dict`` 拼装：白名单是"漏字段"的唯一可靠防线（测试还会断言
    键集合**恰好等于**它）。**刻意不含** kb_id / token / 文档名 / 任何正文——
    拿到链接的人只需要知道"这是什么库、谁分享的、能不能进"。
    """
    valid: bool = True
    kb_name: str
    description: str
    docs_count: int
    chunks_count: int
    owner_name: str | None = None
    permission: str
    expires_at: datetime | None = None


class KBGroupResponse(BaseModel):
    """知识库分组。"""
    id: str
    name: str
    sort_order: int = 0
    kb_count: int = 0


class KBGroupCreateRequest(BaseModel):
    """新建分组。"""
    name: str = Field(..., min_length=1, max_length=64)


class KBGroupUpdateRequest(BaseModel):
    """重命名分组。"""
    name: str = Field(..., min_length=1, max_length=64)


class KBCopyRequest(BaseModel):
    """复制知识库（只复制定义与配置，不复制文档与向量）。"""
    name: str | None = Field(default=None, max_length=128)


class KBPinRequest(BaseModel):
    """置顶 / 取消置顶。"""
    pinned: bool


class KBMoveRequest(BaseModel):
    """在列表里上移 / 下移一位。"""
    direction: Literal["up", "down"]


class KBAssignGroupRequest(BaseModel):
    """把知识库归入分组；``group_id`` 传 null 表示移出分组。"""
    group_id: str | None = None


class KBListResponse(BaseModel):
    """知识库分页列表。"""
    items: list[KBResponse]
    total: int
    page: int
    page_size: int


class KBStatsResponse(BaseModel):
    """知识库统计信息。"""
    total_kbs: int
    total_docs: int
    total_chunks: int
    total_entities: int
    total_indexing: int


# ─── Document ───────────────────────────────────────────────────────────────

class DocStageInfo(BaseModel):
    """索引流水线阶段信息。"""
    name: str
    status: str  # pending|running|done|failed
    pct: int


class KBDocResponse(BaseModel):
    """文档响应。"""
    id: str
    name: str
    type: str
    size_display: str
    status: str
    progress: int
    chunks_count: int
    entities_count: int
    relations_count: int
    uploaded_at: datetime
    indexed_at: datetime | None = None
    error_message: str | None = None
    #: 图谱抽取失败原因（索引本身仍成功）
    graph_error: str | None = None
    stages: list[DocStageInfo] = []
    config: IndexConfigSchema | None = None

    model_config = {"from_attributes": True}


class KBDocListResponse(BaseModel):
    """文档分页列表。"""
    items: list[KBDocResponse]
    total: int
    page: int
    page_size: int


# 说明：上传接口直接返回 KBDocResponse（完整字段），此处不再单独定义
# KBDocUploadResponse——它此前只声明 7 个字段，与文档列表的形状不一致，
# 前端读取 progress/chunks_count/stages 会拿到 undefined（见 T0.7）。


# ─── Graph ──────────────────────────────────────────────────────────────────

class EntityResponse(BaseModel):
    """实体。"""
    id: str
    name: str
    type: str
    mentions: int
    source_text: str | None = None

    model_config = {"from_attributes": True}


class RelationResponse(BaseModel):
    """关系。"""
    id: str
    from_entity: str
    to_entity: str
    label: str
    weight: float
    source_entity_id: str | None = None
    target_entity_id: str | None = None

    model_config = {"from_attributes": True}


class GraphDataResponse(BaseModel):
    """图谱数据。"""
    entities: list[EntityResponse]
    relations: list[RelationResponse]


# ─── Search ──────────────────────────────────────────────────────────────────


class SearchRequest(BaseModel):
    """检索请求。"""
    query: str = Field(..., min_length=1, max_length=2000, description="检索查询文本")
    mode: str = Field(default="hybrid", description="检索模式: hybrid | vector | bm25")
    top_k: int = Field(default=5, ge=1, le=50, description="返回结果数量")
    alpha: float | None = Field(default=None, ge=0.0, le=1.0, description="混合检索向量权重")
    min_similarity: float | None = Field(
        default=None, ge=0.0, le=1.0,
        description="最低余弦相似度——最高相似度低于该值时判定"
                    "「知识库中没有相关内容」并返回空结果；None 表示用知识库配置或系统默认",
    )
    score_threshold: float | None = Field(
        default=None, ge=0.0, le=1.0,
        description="相对截断比例——丢弃低于「最高分 × 该比例」的结果；"
                    "None 表示用知识库配置（默认关闭）",
    )
    enable_rerank: bool | None = Field(
        default=None,
        description="是否启用精排；None 表示用知识库配置（默认启用）。"
                    "评测与高级检索面板用它做单次覆盖。",
    )
    max_chunks_per_doc: int | None = Field(
        default=None, ge=0, le=20,
        description="同一文档最多占用的结果条数（0 表示不限制）；"
                    "None 表示用知识库配置（默认 3）",
    )
    dedup_similarity: float | None = Field(
        default=None, ge=0.0, le=1.0,
        description="近重复判定阈值（0 表示关闭去重）；None 表示用知识库配置（默认 0.92）",
    )
    doc_ids: list[str] | None = Field(
        default=None, max_length=50,
        description="只在指定文档内检索（文档 ID 列表）；None 表示不限",
    )
    doc_types: list[str] | None = Field(
        default=None, max_length=20,
        description="只在指定文件类型内检索，如 ['pdf', 'md']；None 表示不限",
    )
    kb_ids: list[str] | None = Field(
        default=None, max_length=5,
        description="跨知识库联合检索：给定多个知识库 ID 时按排名融合各自结果；"
                    "None 或单个 ID 表示只检索当前库",
    )
    use_rewrite: bool | None = Field(
        default=None,
        description="是否做查询改写（指代消解 + 多查询扩展）；"
                    "None 表示用知识库配置（默认关闭）。开启会额外调用一次 LLM。",
    )
    use_hyde: bool | None = Field(
        default=None,
        description="是否额外生成 HyDE 假设文档作为一路检索变体；"
                    "None 表示用知识库配置（默认关闭）。仅在启用改写时生效。",
    )
    history: list[str] | None = Field(
        default=None, max_length=10,
        description="最近几轮的用户提问（从旧到新），供指代消解使用——"
                    "多轮追问里的「它/这个」需要靠它还原成完整问题",
    )


class ChunkMatch(BaseModel):
    """匹配到的分片。

    分数口径（**每个字段的含义是固定的**，不再随模式变化）：

    - ``score``：最终排序分，含义由 ``score_kind`` 标注——
      ``cosine``（余弦相似度）/ ``bm25``（BM25 得分）/ ``rrf``（归一化融合分，
      榜首恒为 1.0）/ ``rerank``（精排相关度）；
    - ``vec_score`` / ``bm25_score``：**原始**余弦相似度与 BM25 得分。
      此前混合模式下这两个字段是候选集内的 min-max 相对值，与单路模式的原始分
      同名不同义，前端把两者都当"得分"展示会误导用户。
    """
    id: str
    doc_id: str
    doc_name: str
    chunk_index: int
    content: str
    score: float
    #: score 的含义：cosine | bm25 | rrf | rerank
    score_kind: str = ""
    vec_score: float | None = None
    bm25_score: float | None = None
    #: 引用定位（来源页码与章节路径），来自切片元数据
    page: int | None = None
    section: str = ""
    #: 来源知识库（跨库检索时用于标注结果出处）
    kb_id: str = ""
    kb_name: str = ""
    #: 正文是否是「父块扩展」的结果（parent_child 策略下命中子块、返回父块正文）
    parent_expanded: bool = False


class SearchResponse(BaseModel):
    """检索响应。"""
    query: str
    mode: str
    total: int
    results: list[ChunkMatch]
    #: 知识库配置是否要求精排
    rerank_requested: bool = False
    #: 精排是否**实际生效**（模型不可用或调用失败时为 False）
    rerank_applied: bool = False
    #: 结果分（score）的含义：cosine | bm25 | rrf | rerank
    score_kind: str = ""
    #: 是否判定为「知识库中没有相关内容」——最高余弦低于门槛，结果被清空
    no_relevant_result: bool = False
    #: 本次生效的最低余弦门槛（None 表示该模式不做绝对门槛，如纯 BM25）
    min_similarity: float | None = None
    #: 被门槛过滤掉的条数（绝对门槛或相对截断）
    filtered_count: int = 0
    #: 因近重复或单文档配额被丢弃的条数（结果已由后续候选补足）
    deduped_count: int = 0
    #: 实际参与检索的知识库（跨库检索时可能有库因"无相关内容"被剔除）
    searched_kb_ids: list[str] = []
    #: 本次检索是否要求做改写（请求开关或知识库配置）
    rewrite_requested: bool = False
    #: 改写是否**实际生效**（未开启、LLM 不可用、超时或解析失败均为 False）
    rewrite_applied: bool = False
    #: 实际参与召回的查询式（首条恒为原始查询）；未改写时只有一条
    rewrite_queries: list[str] = []
    #: 本次是否额外用了一路 HyDE 假设文档（**不在** rewrite_queries 里，它是整段文字）
    rewrite_hyde: bool = False
    #: 改写未生效的原因（如"改写超时"）——此前 rerank 静默失败过一次，不再重蹈
    rewrite_reason: str = ""


# ─── Chunk ───────────────────────────────────────────────────────────────────


class ChunkResponse(BaseModel):
    """切片响应（对应前端 DocChunk 接口）。"""
    id: str
    index: int
    content: str
    token_count: int
    char_count: int
    page_ref: str = ""
    section: str = ""
    entities: list[str] = []


class ChunkDetailResponse(BaseModel):
    """切片详情（含上下文）。"""
    chunk: ChunkResponse
    prev_chunk: ChunkResponse | None = None
    next_chunk: ChunkResponse | None = None


class ChunkUpdateRequest(BaseModel):
    """更新切片请求。"""
    content: str


class BatchChunkRequest(BaseModel):
    """批量操作请求。"""
    action: str  # "save_all" | "delete"
    chunks: list[dict] = []     # [{id, content}, ...]
    chunk_ids: list[str] = []   # for delete action


class BatchDocRequest(BaseModel):
    """文档级批量操作请求（删除 / 重试）。

    上限 50 与分享邀请保持一致：批量是**逐项提交**的，条数直接决定请求耗时。
    """
    action: Literal["delete", "retry"]
    doc_ids: list[str] = Field(..., min_length=1, max_length=50)


class TextDocRequest(BaseModel):
    """粘贴文本建文档请求。"""
    name: str | None = Field(default=None, max_length=200)
    content: str = Field(..., min_length=1)
    config: IndexConfigSchema | None = None


class UrlImportRequest(BaseModel):
    """URL / 网页导入请求。"""
    url: str = Field(..., min_length=8, max_length=2048)
    config: IndexConfigSchema | None = None


# ─── Share ──────────────────────────────────────────────────────────────────


class KBShareCreateRequest(BaseModel):
    """邀请用户浏览知识库请求。"""
    user_ids: list[str] = Field(..., min_length=1, max_length=50)
    #: 迭代 6 T6.3：可写分享（write 只放开内容操作）与有效期
    permission: Literal["read", "write"] = "read"
    expires_in: Literal["1d", "7d", "30d", "never"] = "never"


class KBShareResponse(BaseModel):
    """单条分享记录（含被邀请人展示信息）。

    ``kb_name`` 仅在「共享给我的」场景填充——接收方需要显示知识库名称，
    而该库里可能对他不可读（如邀请被拒绝后），不能靠再查列表兜底。
    """
    id: str
    kb_id: str
    user_id: str
    username: str | None = None
    nickname: str = ""
    avatar: str = ""
    status: str
    permission: str = "read"
    #: 有效期（迭代 6 T6.3）：为空表示永久。过期是派生态，由读条件现算
    expires_at: datetime | None = None
    created_at: datetime
    accepted_at: datetime | None = None
    kb_name: str | None = None


class KBShareListResponse(BaseModel):
    """分享记录列表。"""
    items: list[KBShareResponse]
    total: int


class KBVisibilityUpdateRequest(BaseModel):
    """发布 / 取消发布公共库请求。"""
    visibility: Literal["private", "public"]


# ─── Core Response ──────────────────────────────────────────────────────────

class ApiResponse(BaseModel):
    """统一 API 响应包装（通用泛型，前端 response wrapper 匹配）。"""
    code: int = 0
    data: object | None = None
    message: str = "ok"
