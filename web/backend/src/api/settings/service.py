"""系统设置服务：全局系统标识与按用户偏好.

校验规则与桌面版保持一致，便于两端行为对齐：

- 系统名称：``desktop/src/main/settings/schema.ts`` 的 ``isValidSystemName``
- LOGO：``desktop/src/main/settings/BrandLogoService.ts`` 的魔数嗅探与 SVG 消毒
"""

from __future__ import annotations

import re
import time

from fastapi import HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.storage import get_artifact_store
from db.models.system_setting import SystemSetting
from db.models.user_preference import UserPreference

SYSTEM_NAME_KEY = "system.name"
SYSTEM_LOGO_KEY = "system.logo"

SYSTEM_NAME_DEFAULT = "Ke-Work"
SYSTEM_NAME_MAX_LENGTH = 24

BRAND_LOGO_MAX_BYTES = 1024 * 1024
LOGO_STORAGE_PREFIX = "system/branding"
# 前端 <img src> 用的根相对路径；必须是绝对路径，否则在 /settings 等
# 子路由下会被按相对路径解析而 404
LOGO_URL_PATH = "/api/settings/system/logo"

DEFAULT_LANGUAGE = "zh-CN"
DEFAULT_FONT_SIZE = 17
DEFAULT_CLIENT_NOTIFICATIONS = True
DEFAULT_NOTIFICATION_SOUND = "none"

ALLOWED_LANGUAGES = frozenset({"zh-CN", "en"})
ALLOWED_NOTIFICATION_SOUNDS = frozenset({"none", "crisp", "soft"})
FONT_SIZE_MIN = 12
FONT_SIZE_MAX = 24

PREF_LANGUAGE = "language"
PREF_FONT_SIZE = "fontSize"
PREF_CLIENT_NOTIFICATIONS = "clientNotifications"
PREF_NOTIFICATION_SOUND = "notificationSound"

_MEDIA_TYPES = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "webp": "image/webp",
    "svg": "image/svg+xml",
}

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_JPEG_SIGNATURE = b"\xff\xd8\xff"
# 事件属性前必须是分隔符，否则 "monitor=" 这类字面量会被误判
_SVG_EVENT_ATTR_RE = re.compile(rb"""(?:^|[\s"'/<])on[a-z]{2,}\s*=""")


# ---- 全局系统标识 ----


def validate_system_name(raw: str) -> str:
    """校验系统名称，返回 trim 后的值；不合法时抛出 400."""
    name = raw.strip()
    if not name:
        raise HTTPException(status_code=400, detail="系统名称不能为空")
    if len(name) > SYSTEM_NAME_MAX_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"系统名称不能超过 {SYSTEM_NAME_MAX_LENGTH} 个字符",
        )
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in name):
        raise HTTPException(
            status_code=400, detail="系统名称不能包含换行或制表等控制字符"
        )
    return name


def _sniff_logo_extension(content: bytes) -> str | None:
    """按文件头识别图片格式，返回扩展名；无法识别时返回 None."""
    if content.startswith(_PNG_SIGNATURE):
        return "png"
    if content.startswith(_JPEG_SIGNATURE):
        return "jpg"
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "webp"
    # SVG 是文本，只能靠内容判定：先剥掉 BOM 与空白，再要求以 "<" 开头
    head = content[:1024].lstrip(b"\xef\xbb\xbf \t\r\n")
    if head.startswith(b"<") and b"<svg" in head.lower():
        return "svg"
    return None


def _is_unsafe_svg(content: bytes) -> bool:
    """检出 SVG 中的脚本与事件属性（存储型 XSS 风险）."""
    lowered = content.lower()
    if b"<script" in lowered or b"javascript:" in lowered:
        return True
    return _SVG_EVENT_ATTR_RE.search(lowered) is not None


async def _read_setting(db: AsyncSession, key: str) -> str | None:
    """读取全局设置项，不存在时返回 None."""
    result = await db.execute(
        select(SystemSetting).where(SystemSetting.setting_key == key)
    )
    row = result.scalar_one_or_none()
    return row.setting_value if row is not None else None


async def _write_setting(db: AsyncSession, key: str, value: str | None) -> None:
    """写入全局设置项（不存在则新建）."""
    result = await db.execute(
        select(SystemSetting).where(SystemSetting.setting_key == key)
    )
    row = result.scalar_one_or_none()
    if row is None:
        db.add(SystemSetting(setting_key=key, setting_value=value))
    else:
        row.setting_value = value
    await db.flush()


async def get_system_identity(db: AsyncSession) -> dict[str, object]:
    """读取系统标识；未配置时返回默认值（不做种子数据）.

    返回 snake_case 字段名，camelCase 由响应模型统一序列化。
    """
    name = await _read_setting(db, SYSTEM_NAME_KEY)
    logo_key = await _read_setting(db, SYSTEM_LOGO_KEY)
    return {
        "system_name": name or SYSTEM_NAME_DEFAULT,
        "logo_url": LOGO_URL_PATH if logo_key else None,
    }


async def update_system_name(db: AsyncSession, raw_name: str) -> dict[str, object]:
    """更新系统名称并返回最新系统标识."""
    name = validate_system_name(raw_name)
    await _write_setting(db, SYSTEM_NAME_KEY, name)
    return await get_system_identity(db)


async def save_logo(db: AsyncSession, upload: UploadFile) -> dict[str, object]:
    """校验并保存 LOGO，成功后替换旧文件并返回最新系统标识."""
    content = await upload.read()
    if not content:
        raise HTTPException(status_code=400, detail="LOGO 文件为空")
    if len(content) > BRAND_LOGO_MAX_BYTES:
        raise HTTPException(status_code=400, detail="LOGO 大小不能超过 1MB")

    extension = _sniff_logo_extension(content)
    if extension is None:
        raise HTTPException(
            status_code=400, detail="仅支持 PNG / JPG / WEBP / SVG 格式的图片"
        )
    if extension == "svg" and _is_unsafe_svg(content):
        raise HTTPException(status_code=400, detail="SVG 中包含不安全的脚本或事件属性")

    previous_key = await _read_setting(db, SYSTEM_LOGO_KEY)
    storage_key = f"{LOGO_STORAGE_PREFIX}/logo-{int(time.time() * 1000)}.{extension}"
    get_artifact_store().save(storage_key, content)
    await _write_setting(db, SYSTEM_LOGO_KEY, storage_key)

    # 新图落库后再删旧图，避免中途失败导致 LOGO 丢失
    if previous_key and previous_key != storage_key:
        try:
            get_artifact_store().delete(previous_key)
        except Exception:  # noqa: BLE001 - 旧文件清理失败不应影响本次上传
            pass

    return await get_system_identity(db)


async def reset_logo(db: AsyncSession) -> dict[str, object]:
    """恢复默认 LOGO：清除配置并删除已存文件."""
    storage_key = await _read_setting(db, SYSTEM_LOGO_KEY)
    await _write_setting(db, SYSTEM_LOGO_KEY, None)
    if storage_key:
        try:
            get_artifact_store().delete(storage_key)
        except Exception:  # noqa: BLE001 - 同上
            pass
    return await get_system_identity(db)


async def read_logo(db: AsyncSession) -> tuple[bytes, str] | None:
    """读取 LOGO 字节与 MIME 类型；未配置或文件缺失时返回 None."""
    storage_key = await _read_setting(db, SYSTEM_LOGO_KEY)
    if not storage_key:
        return None
    try:
        content = get_artifact_store().open(storage_key)
    except Exception:  # noqa: BLE001 - 存储后端异常按未配置处理
        return None
    if not content:
        return None
    extension = storage_key.rsplit(".", 1)[-1].lower()
    return content, _MEDIA_TYPES.get(extension, "application/octet-stream")


# ---- 按用户偏好 ----


def _clamp_font_size(value: int) -> int:
    """把字号收敛到 12–24，默认 17."""
    if not isinstance(value, int) or isinstance(value, bool):
        return DEFAULT_FONT_SIZE
    return max(FONT_SIZE_MIN, min(FONT_SIZE_MAX, value))


async def _load_preferences(db: AsyncSession, user_id: str) -> dict[str, str]:
    """读取用户偏好原始键值，缺失的键不在结果中."""
    result = await db.execute(
        select(UserPreference).where(UserPreference.user_id == user_id)
    )
    return {row.pref_key: (row.pref_value or "") for row in result.scalars().all()}


async def get_preferences(db: AsyncSession, user_id: str) -> dict[str, object]:
    """读取用户偏好，缺失项回落到默认值."""
    stored = await _load_preferences(db, user_id)

    language = stored.get(PREF_LANGUAGE, "")
    if language not in ALLOWED_LANGUAGES:
        language = DEFAULT_LANGUAGE

    sound = stored.get(PREF_NOTIFICATION_SOUND, "")
    if sound not in ALLOWED_NOTIFICATION_SOUNDS:
        sound = DEFAULT_NOTIFICATION_SOUND

    raw_font_size = stored.get(PREF_FONT_SIZE, "")
    try:
        font_size = _clamp_font_size(int(raw_font_size))
    except (TypeError, ValueError):
        font_size = DEFAULT_FONT_SIZE

    raw_notifications = stored.get(PREF_CLIENT_NOTIFICATIONS, "")
    if raw_notifications in ("true", "false"):
        client_notifications = raw_notifications == "true"
    else:
        client_notifications = DEFAULT_CLIENT_NOTIFICATIONS

    return {
        "language": language,
        "font_size": font_size,
        "client_notifications": client_notifications,
        "notification_sound": sound,
    }


async def update_preferences(
    db: AsyncSession, user_id: str, payload: dict[str, object]
) -> dict[str, object]:
    """按需更新用户偏好（只写入显式传入的字段）并返回最新结果."""
    updates: dict[str, str] = {}

    if payload.get("language") is not None:
        language = str(payload["language"])
        if language not in ALLOWED_LANGUAGES:
            raise HTTPException(status_code=400, detail=f"不支持的语言：{language}")
        updates[PREF_LANGUAGE] = language

    if payload.get("font_size") is not None:
        raw_size = payload["font_size"]
        if isinstance(raw_size, bool) or not isinstance(raw_size, int):
            raise HTTPException(status_code=400, detail="字号必须是整数")
        if not FONT_SIZE_MIN <= raw_size <= FONT_SIZE_MAX:
            raise HTTPException(
                status_code=400,
                detail=f"字号必须在 {FONT_SIZE_MIN}–{FONT_SIZE_MAX} 之间",
            )
        updates[PREF_FONT_SIZE] = str(raw_size)

    if payload.get("client_notifications") is not None:
        updates[PREF_CLIENT_NOTIFICATIONS] = (
            "true" if payload["client_notifications"] else "false"
        )

    if payload.get("notification_sound") is not None:
        sound = str(payload["notification_sound"])
        if sound not in ALLOWED_NOTIFICATION_SOUNDS:
            raise HTTPException(status_code=400, detail=f"不支持的提示音：{sound}")
        updates[PREF_NOTIFICATION_SOUND] = sound

    if not updates:
        return await get_preferences(db, user_id)

    result = await db.execute(
        select(UserPreference).where(UserPreference.user_id == user_id)
    )
    existing = {row.pref_key: row for row in result.scalars().all()}
    for key, value in updates.items():
        row = existing.get(key)
        if row is None:
            db.add(UserPreference(user_id=user_id, pref_key=key, pref_value=value))
        else:
            row.pref_value = value
    await db.flush()

    return await get_preferences(db, user_id)
