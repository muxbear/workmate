"""系统设置服务单元测试：LOGO 校验规则与用户偏好 upsert."""

from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from api.settings import service
from db.base import Base
from db.models.system_setting import SystemSetting  # noqa: F401  注册建表
from db.models.user_preference import UserPreference  # noqa: F401  注册建表

pytestmark = pytest.mark.anyio


@pytest_asyncio.fixture
async def session() -> AsyncGenerator[AsyncSession, None]:
    """内存库会话，仅建本模块涉及的两张表."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as s:
        yield s
    await engine.dispose()


# ---- LOGO 魔数嗅探 ----


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        (bytes.fromhex("89504e470d0a1a0a") + b"x", "png"),
        (b"\xff\xd8\xff\xe0" + b"x", "jpg"),
        (b"RIFF\x00\x00\x00\x00WEBPVP8 ", "webp"),
        (b'<svg xmlns="http://www.w3.org/2000/svg"/>', "svg"),
        (b'<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>', "svg"),
        (b"\xef\xbb\xbf  <svg/>", "svg"),
    ],
)
def test_sniff_logo_extension_recognizes_formats(content: bytes, expected: str) -> None:
    """按文件头识别 PNG / JPG / WEBP / SVG."""
    assert service._sniff_logo_extension(content) == expected


@pytest.mark.parametrize(
    "content",
    [b"", b"not an image", b"<html><body>hi</body></html>", b"RIFF\x00\x00\x00\x00WAVE"],
)
def test_sniff_logo_extension_rejects_others(content: bytes) -> None:
    """非图片内容返回 None."""
    assert service._sniff_logo_extension(content) is None


@pytest.mark.parametrize(
    "content",
    [
        b'<svg><script>alert(1)</script></svg>',
        b'<svg onload="alert(1)"></svg>',
        b'<a xlink:href="javascript:alert(1)">x</a>',
        b'<rect/onerror = "alert(1)"/>',
    ],
)
def test_unsafe_svg_detected(content: bytes) -> None:
    """脚本、事件属性与 javascript: 协议均判为不安全."""
    assert service._is_unsafe_svg(content) is True


@pytest.mark.parametrize(
    "content",
    [
        b'<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>',
        b'<svg><text>monitor=1</text></svg>',
        b'<svg><text>online shop</text></svg>',
    ],
)
def test_safe_svg_passes(content: bytes) -> None:
    """正常图形不被误判——尤其 "monitor=" 这类字面量不能命中事件属性规则."""
    assert service._is_unsafe_svg(content) is False


# ---- 系统名称校验 ----


def test_validate_system_name_trims() -> None:
    """前后空白被裁掉."""
    assert service.validate_system_name("  我的工作台  ") == "我的工作台"


@pytest.mark.parametrize(
    ("raw", "message"),
    [
        ("", "系统名称不能为空"),
        ("   ", "系统名称不能为空"),
        ("x" * 25, "系统名称不能超过 24 个字符"),
        ("a\nb", "系统名称不能包含换行或制表等控制字符"),
        ("a\tb", "系统名称不能包含换行或制表等控制字符"),
        ("a\x7fb", "系统名称不能包含换行或制表等控制字符"),
    ],
)
def test_validate_system_name_rejects(raw: str, message: str) -> None:
    """非法名称抛出 400 与可读中文提示."""
    with pytest.raises(HTTPException) as excinfo:
        service.validate_system_name(raw)
    assert excinfo.value.status_code == 400
    assert excinfo.value.detail == message


def test_validate_system_name_measures_after_trim() -> None:
    """长度按 trim 后计算，两侧空白不占额度."""
    assert service.validate_system_name(" " + "y" * 24 + " ") == "y" * 24


# ---- 系统标识读写 ----


async def test_identity_defaults_without_rows(session: AsyncSession) -> None:
    """无任何配置行时返回默认值，不依赖种子数据."""
    identity = await service.get_system_identity(session)
    assert identity == {"system_name": "Ke-Work", "logo_url": None}


async def test_update_system_name_is_upsert(session: AsyncSession) -> None:
    """连续改名只保留一行，不重复插入."""
    await service.update_system_name(session, "第一个名字")
    await service.update_system_name(session, "第二个名字")

    rows = (await session.execute(select(SystemSetting))).scalars().all()
    assert len(rows) == 1
    assert rows[0].setting_value == "第二个名字"


# ---- 用户偏好 ----


async def test_preferences_defaults(session: AsyncSession) -> None:
    """无记录时返回默认偏好."""
    assert await service.get_preferences(session, "user-a") == {
        "language": "zh-CN",
        "font_size": 17,
        "client_notifications": True,
        "notification_sound": "none",
    }


async def test_preferences_upsert_is_idempotent(session: AsyncSession) -> None:
    """同一用户同一键反复写入只保留一行."""
    for size in (20, 22, 24):
        await service.update_preferences(session, "user-a", {"font_size": size})

    rows = (await session.execute(select(UserPreference))).scalars().all()
    assert len(rows) == 1
    assert rows[0].pref_value == "24"


async def test_preferences_are_scoped_per_user(session: AsyncSession) -> None:
    """一位用户的偏好不影响另一位."""
    await service.update_preferences(session, "user-a", {"language": "en"})
    await service.update_preferences(session, "user-b", {"font_size": 12})

    assert (await service.get_preferences(session, "user-a"))["language"] == "en"
    assert (await service.get_preferences(session, "user-a"))["font_size"] == 17
    assert (await service.get_preferences(session, "user-b"))["language"] == "zh-CN"
    assert (await service.get_preferences(session, "user-b"))["font_size"] == 12


async def test_update_preferences_only_touches_passed_fields(
    session: AsyncSession,
) -> None:
    """未传字段保持原值；全空调用是 no-op."""
    await service.update_preferences(
        session, "user-a", {"language": "en", "notification_sound": "crisp"}
    )
    result = await service.update_preferences(session, "user-a", {})
    assert result["language"] == "en"
    assert result["notification_sound"] == "crisp"


@pytest.mark.parametrize(
    "payload",
    [{"language": "fr"}, {"notification_sound": "loud"}, {"font_size": 99}],
)
async def test_update_preferences_rejects_unknown_values(
    session: AsyncSession, payload: dict[str, object]
) -> None:
    """白名单外的取值一律拒绝."""
    with pytest.raises(HTTPException) as excinfo:
        await service.update_preferences(session, "user-a", payload)
    assert excinfo.value.status_code == 400


async def test_get_preferences_falls_back_on_corrupt_values(
    session: AsyncSession,
) -> None:
    """库里存了非法值（手工改库/旧版本遗留）时回落到默认值而非崩溃."""
    session.add_all(
        [
            UserPreference(user_id="user-a", pref_key="fontSize", pref_value="abc"),
            UserPreference(user_id="user-a", pref_key="language", pref_value="fr"),
            UserPreference(
                user_id="user-a", pref_key="notificationSound", pref_value="loud"
            ),
        ]
    )
    await session.flush()

    assert await service.get_preferences(session, "user-a") == {
        "language": "zh-CN",
        "font_size": 17,
        "client_notifications": True,
        "notification_sound": "none",
    }
