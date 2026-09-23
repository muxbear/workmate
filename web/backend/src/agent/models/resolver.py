"""对话模型解析——统一从「模型」页面（providers / ai_models）解析 LLM 实例。.

后端不再从环境变量读取模型配置（原先的 ``DEEPSEEK_*`` + 模块级单例已移除），
「模型」页面写入的提供商与模型是唯一来源：

- 请求显式带 ``provider_id`` + ``model_id`` 时按该组合解析，失败抛带具体原因的 ``RuntimeError``；
- 未指定时解析「默认对话模型」——页面显式标记的 ``is_default`` 优先，
  否则按页面拖拽顺序（``Provider.sort_order`` → ``AIModel.sort_order``）取第一个可用模型。

默认模型自身不可用时（提供商缺密钥、api_base 为空等）会**顺延**到下一个可用模型，
而不是直接报错；只有当整个「模型」页面都拿不出可用模型时才抛出 ``NO_CHAT_MODEL_MESSAGE``。

关键导入均为函数内懒加载，避免 agent ↔ api ↔ core ↔ db 的循环导入。
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, NamedTuple

from langchain_openai import ChatOpenAI
from pydantic import SecretStr

from db.model_lookup import select_usable_models

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

# 可作为对话模型的类型（与前端 ModelSelector、api/providers/service 保持一致）。
CHAT_MODEL_TYPES: tuple[str, ...] = ("llm", "multimodal")

NO_CHAT_MODEL_MESSAGE = (
    "未在「模型」页面找到可用的对话模型：请检查提供商的 API 地址与密钥，"
    "并确保至少一个 llm 或 multimodal 类型的模型处于启用状态"
)


class ModelNotConfiguredError(RuntimeError):
    """「模型」页面没有可用的对话模型。.

    继承 RuntimeError 以兼容既有「解析失败抛 RuntimeError」的约定，
    同时让 API 层能精确识别并把这句可执行提示原样回给用户，
    而不是被通用异常分支吞成「服务处理您的请求时发生了错误」。
    """


class _ModelTarget(NamedTuple):
    """构造 LLM 客户端所需的全部标量信息（脱离 ORM 会话后仍可使用）。."""

    model_name: str
    api_base: str
    api_key: str


def _build_chat_model(target: _ModelTarget) -> ChatOpenAI:
    """按 OpenAI 兼容协议构造对话模型客户端。."""
    return ChatOpenAI(
        model=target.model_name,
        api_key=SecretStr(target.api_key),
        base_url=target.api_base,
    )


async def resolve_default_llm(db: AsyncSession | None = None) -> ChatOpenAI:
    """解析默认对话模型。.

    ``is_default`` 标记优先于页面顺序；被标记的模型若所在提供商不可用
    （缺 api_key、api_base 为空、已禁用等）则**顺延**到下一个可用模型。

    Args:
        db: 可选的数据库会话，仅用于测试注入；生产调用留空自行开会话。

    Raises:
        ModelNotConfiguredError: 「模型」页面中没有任何可用对话模型。
    """
    if db is None:
        from db.engine import async_session

        async with async_session() as session:
            return await _resolve_default_llm_from(session)
    return await _resolve_default_llm_from(db)


async def _resolve_default_llm_from(db: AsyncSession) -> ChatOpenAI:
    """在给定会话上执行默认模型解析。."""
    # 注意不要限制 limit=1：不可用的候选是在 Python 侧跳过的，
    # 取 1 行会让「顺延到下一个可用模型」失效。
    rows = await select_usable_models(db, types=CHAT_MODEL_TYPES, prefer_default=True)
    if not rows:
        logger.error("解析默认对话模型失败：%s", NO_CHAT_MODEL_MESSAGE)
        raise ModelNotConfiguredError(NO_CHAT_MODEL_MESSAGE)

    model, provider, api_key = rows[0]
    target = _ModelTarget(model.name, provider.api_base, api_key)
    logger.info(
        "默认对话模型为 %s（提供商 %s）%s",
        model.name,
        provider.name,
        "（页面显式指定）" if model.is_default else "（按页面顺序选取）",
    )
    return _build_chat_model(target)


async def resolve_llm(
    provider_id: str, model_id: str, db: AsyncSession | None = None
) -> ChatOpenAI:
    """按显式 ``provider_id`` + ``model_id`` 解析 LLM 实例。.

    与默认解析不同，这里不做「顺延」：调用方明确指定了模型，
    任何一步失败都必须暴露具体原因，便于定位配置问题。

    Args:
        provider_id: 提供商 ID。
        model_id: 模型 ID。
        db: 可选的数据库会话，仅用于测试注入；生产调用留空自行开会话。

    Raises:
        RuntimeError: 提供商不存在、未配置密钥，或该提供商下没有这个模型。
    """
    if db is None:
        from db.engine import async_session

        async with async_session() as session:
            return await _resolve_llm_from(session, provider_id, model_id)
    return await _resolve_llm_from(db, provider_id, model_id)


async def _resolve_llm_from(
    db: AsyncSession, provider_id: str, model_id: str
) -> ChatOpenAI:
    """在给定会话上解析显式指定的模型。."""
    from sqlalchemy import select

    from core.security import decrypt_api_key
    from db.models.ai_model import AIModel
    from db.models.provider import Provider

    provider = (
        await db.execute(select(Provider).where(Provider.id == provider_id))
    ).scalar_one_or_none()
    if provider is None:
        raise RuntimeError(f"提供商 {provider_id} 未找到")

    api_key = decrypt_api_key(provider.api_key)
    if not api_key:
        raise RuntimeError(f"模型提供商 {provider.name} 未配置 api_key")

    # api_base 为空时 openai SDK 会回落到 https://api.openai.com/v1，
    # 等于把这个提供商的密钥发往 OpenAI。提供商允许只配 response_url /
    # anthropic_url，所以这里必须显式拦截。
    if not (provider.api_base or "").strip():
        raise ModelNotConfiguredError(
            f"提供商 {provider.name} 未配置 OpenAI 兼容地址（api_base），无法用于对话模型"
        )

    model = (
        await db.execute(
            select(AIModel).where(
                AIModel.id == model_id, AIModel.provider_id == provider_id
            )
        )
    ).scalar_one_or_none()
    if model is None:
        raise RuntimeError(f"模型提供商 {provider.name} 下未找到模型 {model_id}")

    return _build_chat_model(_ModelTarget(model.name, provider.api_base, api_key))
