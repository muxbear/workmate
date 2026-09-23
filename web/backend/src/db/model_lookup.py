"""可用的模型行查询——统一「模型」页面（providers / ai_models）的取用策略。.

「模型」页面写入的提供商与模型是后端解析 LLM / Embedding 的唯一来源
（不再有 .env 兜底）。本模块集中两件事，供对话默认模型解析与知识库共用：

1. 按页面拖拽顺序（``Provider.sort_order`` → ``AIModel.sort_order``）排序，
   显式标记的默认模型（``AIModel.is_default``）优先；
2. 只返回真正可用的行——提供商必须有 ``api_base``，``api_key`` 必须能解密且非空。

依赖仅限 ``db.models.*`` + ``core.security``，不引入 agent/api 层，避免循环导入。
"""

import logging
from collections.abc import Sequence
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.security import decrypt_api_key
from db.models.ai_model import AIModel
from db.models.provider import Provider

logger = logging.getLogger(__name__)

# 取用候选上限：足够覆盖多提供商/多模型的配置，同时避免无界查询。
DEFAULT_LOOKUP_LIMIT = 50


def effective_api_base(model: AIModel, provider: Provider) -> str:
    """取模型实际应使用的 API 地址——模型级覆盖优先，为空时继承提供商。

    「模型」页面允许为单个模型单独填写 API_BASE（同一提供商下不同模型走不同
    网关/地域时使用）。所有构造客户端的调用方都应经由此函数取地址，否则该
    字段会退化成「界面能填但不生效」的假配置。
    """
    return (model.api_base or "").strip() or (provider.api_base or "").strip()


async def select_usable_models(
    db: AsyncSession,
    *,
    types: Sequence[str],
    status: str = "active",
    model_name: str | None = None,
    provider_id: str | None = None,
    prefer_default: bool = False,
    limit: int = DEFAULT_LOOKUP_LIMIT,
) -> list[tuple[AIModel, Provider, str]]:
    """按「模型」页面的配置取用可用模型行。.

    排序规则为「显式默认优先 → 提供商顺序 → 模型顺序 → 创建时间」；
    地址与密钥均缺失（``effective_api_base`` 为空、``api_key`` 解密失败或为空）
    的行会被跳过并记日志，因此返回的每一项都保证可直接用于构造 LLM / Embedding
    客户端。

    Args:
        db: 数据库会话。
        types: 允许的模型类型（如 ``("llm", "multimodal")``）。
        status: 允许的模型状态，默认仅 ``active``。
        model_name: 限定模型机器名。
        provider_id: 限定提供商 ID。
        prefer_default: 是否让 ``is_default`` 的模型排在候选最前。
        limit: 候选行上限。

    Returns:
        ``(model, provider, api_key)`` 列表，``api_key`` 为已解密的明文。
        取地址请用 :func:`effective_api_base`。
    """
    conditions = [AIModel.type.in_(tuple(types)), AIModel.status == status]
    if model_name:
        conditions.append(AIModel.name == model_name)
    if provider_id:
        conditions.append(AIModel.provider_id == provider_id)

    # 元素是异构的 SQLAlchemy 排序表达式（含 is_default.desc()），故用 Any。
    order_by: list[Any] = []
    if prefer_default:
        # 显式指定的默认模型压过页面排序。
        # 必须写成 ``is_(True)`` 而不是 ``is_default.desc()``：迁移后的库该列可为 NULL，
        # 而 PostgreSQL 的 ORDER BY ... DESC 会把 NULL 排在最前，直接写成 desc 会让
        # 未设置默认的 NULL 行压过真正非默认的行，破坏「按页面顺序兜底」。
        order_by.append(AIModel.is_default.is_(True).desc())
    order_by.extend(
        [Provider.sort_order, AIModel.sort_order, AIModel.created_at]
    )

    stmt = (
        select(AIModel, Provider)
        .join(Provider, Provider.id == AIModel.provider_id)
        .where(*conditions)
        .order_by(*order_by)
        .limit(limit)
    )

    rows: list[tuple[AIModel, Provider, str]] = []
    for model, provider in (await db.execute(stmt)).all():
        if not effective_api_base(model, provider):
            continue
        try:
            api_key = decrypt_api_key(provider.api_key)
        except Exception:
            logger.warning("提供商 %s 的 api_key 解密失败，跳过", provider.name)
            continue
        if not api_key:
            logger.warning("提供商 %s 未配置 api_key，跳过", provider.name)
            continue
        rows.append((model, provider, api_key))
    return rows
