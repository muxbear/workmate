"""专家可用的素材落盘工具（后端代理下载）。

工具名 ``download_asset`` 在桌面端有同名实现（写入本地工作区），
专家提示词因此可以保持平台无关：只说明"用 download_asset 把素材保存到交付目录"。

支持图片与音视频：图片走配图场景，视频走「视频创作专家」成片场景；
各端一律通过本工具落盘，不再允许模型执行 shell 命令下载素材。
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def _current_context() -> tuple[str, str]:
    """返回当前运行时上下文的 (user_id, delivery_dir)；不可用时返回空串。"""
    try:
        from langgraph.runtime import get_runtime

        runtime = get_runtime()
        context = getattr(runtime, "context", None) if runtime is not None else None
        user_id = str(getattr(context, "user_id", "") or "")
        delivery_dir = str(getattr(context, "delivery_dir", "") or "")
        return user_id, delivery_dir
    except Exception:
        logger.debug("读取运行时上下文失败", exc_info=True)
        return "", ""


def _current_thread_id() -> str:
    """返回当前会话（LangGraph thread_id）；不可用时返回空串。"""
    try:
        from langgraph.config import get_config

        config: Any = get_config()
        configurable = config.get("configurable") if isinstance(config, dict) else None
        if isinstance(configurable, dict):
            return str(configurable.get("thread_id") or "")
    except Exception:
        logger.debug("读取会话配置失败", exc_info=True)
    return ""


async def download_asset(url: str, rel_path: str) -> dict[str, Any]:
    """把远程素材（图片 / 视频）保存到本次会话的交付目录并登记为会话产物。

    适用于 AI 生成服务返回的临时地址：由后端代理下载，沙箱无需出网，
    素材会立即持久化，沙箱回收后仍可预览、下载与打包。

    Args:
        url: 素材地址（http/https，通常是生成服务返回的临时 URL）。
        rel_path: 相对交付目录的保存路径，例如 ``文章标题/figure-1.png``、
            ``视频标题/成片-1.mp4``。

    Returns:
        成功时返回 ``{"path", "size", "mime_type", "artifact_id", "persisted"}``；
        失败时返回 ``{"error": ...}``（不抛异常，避免中断整轮对话）。
    """
    user_id, delivery_dir = _current_context()
    thread_id = _current_thread_id()
    if not user_id or not thread_id:
        return {"error": "缺少运行时上下文（用户或会话），无法保存素材"}

    try:
        from api.agent.artifacts import ingest_remote_asset

        artifact = await ingest_remote_asset(
            user_id,
            thread_id,
            url,
            rel_path,
            delivery_dir=delivery_dir,
        )
    except Exception as error:
        logger.warning("素材落盘失败：%s", error, exc_info=True)
        return {"error": "素材保存失败：" + str(error)}

    return {
        "path": artifact.path,
        "size": artifact.size,
        "mime_type": artifact.mime_type,
        "artifact_id": artifact.artifact_id,
        "persisted": True,
    }


__all__ = ["download_asset"]