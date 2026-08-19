"""OAuth2 client 注册查询与校验."""

import json
import re
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.models import OAuth2Client

_SEED_PATH = Path(__file__).resolve().parents[2] / "db" / "seeds" / "oauth2_clients_seed.json"


async def get_client_by_id(db: AsyncSession, client_id: str) -> OAuth2Client | None:
    """按 client_id 查询启用的客户端."""
    result = await db.execute(
        select(OAuth2Client).where(
            OAuth2Client.client_id == client_id,
            OAuth2Client.enabled.is_(True),
        )
    )
    return result.scalar_one_or_none()


def _registered_uri_pattern(registered_uri: str) -> str | None:
    """将注册的 redirect_uri 转为安全正则."""
    if "{port}" in registered_uri:
        parts = registered_uri.split("{port}")
        if any("{" in part or "}" in part for part in parts):
            return None
        return r"\d+".join(re.escape(part) for part in parts)

    if "{" in registered_uri or "}" in registered_uri:
        return None
    return re.escape(registered_uri)


def _validate_registered_uri_kind(uri: str) -> bool:
    """限制回调地址类型：loopback HTTP、HTTPS 或自定义 scheme."""
    normalized = uri.replace("{port}", "1")
    try:
        parsed = urlparse(normalized)
    except ValueError:
        return False

    if parsed.scheme in {"http", "https"}:
        if not parsed.hostname:
            return False
        if parsed.scheme == "http":
            return parsed.hostname in {"127.0.0.1", "localhost"}
        return True

    return parsed.scheme not in {"", "javascript", "data", "file"}


def redirect_uri_matches(registered_uris: list[str], redirect_uri: str) -> bool:
    """校验 redirect_uri 是否与注册值匹配."""
    try:
        parsed = urlparse(redirect_uri)
    except ValueError:
        return False
    if parsed.fragment:
        return False

    for registered in registered_uris:
        if not _validate_registered_uri_kind(registered):
            continue
        pattern = _registered_uri_pattern(registered)
        if pattern and re.fullmatch(pattern, redirect_uri):
            return True
    return False


async def seed_oauth2_clients(db: AsyncSession) -> None:
    """首次启动时写入内置 OAuth2 客户端."""
    if not _SEED_PATH.exists():
        return

    payload = json.loads(_SEED_PATH.read_text(encoding="utf-8"))
    clients: list[dict[str, Any]] = payload.get("clients", [])
    for item in clients:
        client_id = str(item["client_id"])
        existing = await db.execute(
            select(OAuth2Client).where(OAuth2Client.client_id == client_id)
        )
        client = existing.scalar_one_or_none()

        values = {
            "client_name": str(item["client_name"]),
            "client_type": str(item["client_type"]),
            "redirect_uris": cast(list[str], item["redirect_uris"]),
            "allowed_scopes": cast(list[str], item["allowed_scopes"]),
            "grant_types": cast(list[str], item["grant_types"]),
            "enabled": bool(item["enabled"]),
        }
        if client is None:
            db.add(OAuth2Client(client_id=client_id, **values))
        else:
            for field, value in values.items():
                setattr(client, field, value)
